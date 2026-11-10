import type {
  AnyAgentTool,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { nowIso } from "../core/time.js";
import { safeContextValue, type PeopleService } from "../core/service.js";
import { SCHEMA_VERSION } from "../core/schema.js";
import type { AccountRecord, BotHint } from "../core/types.js";
import {
  authorizeWorkspace,
  canManage,
  groupMatchesCurrent,
  WRITE_TOOL_NAMES,
  writeToolsEnabled,
} from "./authz.js";
import { isAgentDisabled } from "./config.js";
import type { PeopleRuntime } from "./runtime.js";
import { resolveToolIdentity, type ResolvedIdentity, type ToolIdentityCtx } from "./identity.js";

type ToolArgs = Record<string, unknown>;

type ToolCtx = ToolIdentityCtx & {
  workspaceDir?: string;
  agentId?: string;
  agentDir?: string;
  senderIsOwner?: boolean;
  identities?: PeopleRuntime["identities"];
};

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolArg(args: ToolArgs, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
}

function listArg(args: ToolArgs, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details: {} };
}

function rememberResult(
  label: string,
  result: { traitUpdated: boolean; impressionStored: boolean },
): string {
  const safeLabel = safeContextValue(label);
  if (result.traitUpdated && result.impressionStored) return `已记录到 ${safeLabel}，并更新了特征维度。`;
  if (result.traitUpdated) return `已更新 ${safeLabel} 的特征维度。`;
  if (result.impressionStored) return `已记录到 ${safeLabel}。`;
  return "这条内容已存在，未重复写入。";
}

function forgetResultText(result: {
  impressions: number;
  traits: number;
  purged?: { files: number; dirs: number };
}): string {
  const base = `已删除印象 ${result.impressions} 条、特征 ${result.traits} 个。`;
  if (!result.purged) return base;
  return `${base}已清理备份/旧归档：文件 ${result.purged.files} 个、目录 ${result.purged.dirs} 个。`;
}

function toolService(runtime: PeopleRuntime, ctx: ToolCtx): PeopleService {
  return runtime.get({
    workspaceDir: ctx.workspaceDir,
    agentId: ctx.agentId,
    agentDir: ctx.agentDir,
  });
}

function ownerAuthorized(ctx: ToolCtx): boolean {
  return ctx.senderIsOwner === true;
}

function currentIdentity(ctx: ToolCtx, runtime: PeopleRuntime, service: PeopleService) {
  const workspaceKey = service.paths.workspaceKey;
  const direct = resolveToolIdentity(ctx, runtime.config, undefined, workspaceKey);
  const pending = runtime.identities.get(
    workspaceKey,
    ctx.sessionKey,
    ctx.runId,
    ctx.messageChannel ?? ctx.messageProvider,
    ctx.requesterSenderId,
    direct?.chatId ?? ctx.nativeChannelId,
  );
  return resolveToolIdentity(ctx, runtime.config, pending, workspaceKey);
}

/** A complete current channel identity space and chat id, or nothing. */
function currentGroupIdentity(
  ctx: ToolCtx,
  runtime: PeopleRuntime,
  service: PeopleService,
): ResolvedIdentity | undefined {
  const identity = currentIdentity(ctx, runtime, service);
  if (
    !identity ||
    identity.source === "deferred" ||
    identity.isGroup !== true ||
    !identity.platform.trim() ||
    !identity.chatId?.trim() ||
    (identity.platform.toLowerCase() === "bncr" && !identity.platform.includes("/"))
  ) return undefined;
  return identity;
}

/**
 * A bare chat id means the current identity space's group. Exact keys stay
 * available for owner lookup and for deliberately addressing another row.
 */
function resolveToolGroup(
  service: PeopleService,
  ref: string,
  identity: ResolvedIdentity | undefined,
): ReturnType<PeopleService["resolveGroupStrict"]> | null {
  const value = ref.trim();
  const bare = value && !value.includes("/") && !value.includes(":");
  if (bare && identity) {
    const current = service.db.findGroup(identity.platform, value);
    if (current) return current;
  }
  return service.resolveGroupStrict(value);
}

function requireToolGroup(
  service: PeopleService,
  ref: string,
  identity: ResolvedIdentity | undefined,
): ReturnType<PeopleService["resolveGroupStrict"]> {
  const group = resolveToolGroup(service, ref, identity);
  if (group) return group;
  return service.resolveGroupStrict(ref);
}

function currentAccount(
  ctx: ToolCtx,
  runtime: PeopleRuntime,
  service: PeopleService,
): AccountRecord | null {
  const senderId = ctx.requesterSenderId?.trim();
  if (!senderId) return null;
  const identity = currentIdentity(ctx, runtime, service);
  const multi = runtime.config.multiAccountChannels ?? ["bncr"];
  const multiBackend = multi.some(
    (channel) => channel.trim().toLowerCase() === identity?.channel.toLowerCase(),
  );
  if (!identity || (multiBackend && identity.platform.split("/").length < 2)) return null;
  return service.db.getAccountByPlatformSender(identity.platform, senderId);
}

function accountMatchesRef(account: AccountRecord, ref: string): boolean {
  const value = ref.trim();
  return Boolean(
    value &&
      (value === account.account_id ||
        value === account.sender_id ||
        value === account.display_name ||
        value === account.confirmed_name ||
        value === account.call_name ||
        value === account.bound_person_id),
  );
}

/** Non-owner account mutations resolve only the current host identity. */
function resolveMutationAccount(
  service: PeopleService,
  ctx: ToolCtx,
  runtime: PeopleRuntime,
  ref: string | undefined,
  errors: { noSelf: string; foreign: string },
): AccountRecord {
  const self = currentAccount(ctx, runtime, service);
  if (!canManage(ctx)) {
    if (!self) throw new Error(errors.noSelf);
    if (ref && !accountMatchesRef(self, ref)) throw new Error(errors.foreign);
    return self;
  }
  const target = ref ? resolveAccountRef(service, ref) : self;
  if (!target) throw new Error(errors.noSelf);
  return target;
}

/** Resolve group data only after the current group identity is established. */
function resolveAccessibleGroup(
  service: PeopleService,
  ctx: ToolCtx,
  runtime: PeopleRuntime,
  ref: string,
  foreignMessage: string,
): ReturnType<PeopleService["resolveGroupStrict"]> {
  if (canManage(ctx)) {
    const identity = currentGroupIdentity(ctx, runtime, service);
    if (ref) return requireToolGroup(service, ref, identity);
    const current = identity?.chatId ? service.db.findGroup(identity.platform, identity.chatId) : null;
    if (!current) throw new Error(foreignMessage);
    return current;
  }
  const identity = currentGroupIdentity(ctx, runtime, service);
  if (!identity?.chatId) throw new Error(foreignMessage);
  const current = service.db.findGroup(identity.platform, identity.chatId) ?? service.db.getGroup(ref);
  if (!current || !groupMatchesCurrent(current, identity)) throw new Error(foreignMessage);
  if (ref && ref !== current.group_id && ref !== current.chat_id) throw new Error(foreignMessage);
  return current;
}

function resolveAccountRef(service: PeopleService, ref: string): AccountRecord {
  const matches = service.searchAccounts(ref);
  if (matches.length === 0) throw new Error(`没有找到账号：${safeContextValue(ref, 160)}`);
  if (matches.length > 1) {
    const exact = matches.filter(
      (account) =>
        account.account_id === ref ||
        account.display_name === ref ||
        account.confirmed_name === ref ||
        account.sender_id === ref,
    );
    if (exact.length === 1) return exact[0]!;
    throw new Error(
      `匹配到多个账号，请用 account_id 精确指定：${matches
        .slice(0, 5)
        .map((account) => `${safeContextValue(account.account_id, 160)}(${safeContextValue(account.display_name ?? "?")})`)
        .join(", ")}`,
    );
  }
  return matches[0]!;
}

/** Status is intentionally de-identified: ordinary agents may see whether it works. */
function formatStatus(service: PeopleService): string {
  const status = service.status();
  const maintenance = status.maintenance;
  return [
    "识人库状态",
    `状态：${status.schemaVersion === SCHEMA_VERSION ? "正常" : "需检修"} · 写入工具：${status.security.writeTools ? "开" : "关"}`,
    `采集：${status.capture.lastAt ? "有心跳" : "尚无心跳"}`,
    `后台维护：${maintenance.active ? "运行中" : "未运行"} · 最近完成：${maintenance.completedAt ?? "无"} · 最近失败：${maintenance.lastError ? "有" : "无"}`,
  ].join("\n");
}

/** Detailed operational diagnostics are owner-only. */
function formatDetailedStatus(service: PeopleService): string {
  const status = service.status();
  const counts = status.counts;
  const maintenance = status.maintenance;
  return [
    "识人库状态（详细）",
    `工作区：${status.workspaceDir}`,
    `数据目录：${status.dataDir}`,
    `数据库：${status.dbPath}（schema v${status.schemaVersion}）`,
    `状态：${status.schemaVersion === SCHEMA_VERSION ? "正常" : "需检修"} · 写入工具：${status.security.writeTools ? "开" : "关"}`,
    `采集：${status.capture.lastAt ? "有心跳" : "尚无心跳"} · 身份挂起 ${status.capture.deferredCount} 次`,
    `后台维护：${maintenance.active ? "运行中" : "未运行"} · 最近完成：${maintenance.completedAt ?? "无"} · 最近失败：${maintenance.lastError ? "有" : "无"}`,
    `账号 ${counts.accounts ?? 0} · 人物 ${counts.persons ?? 0} · 绑定 ${counts.person_accounts ?? 0} · 群 ${counts.groups ?? 0}`,
    `群成员 ${counts.group_members ?? 0} · 群记忆 ${counts.group_events ?? 0} · 印象 ${counts.impressions ?? 0} · 特征 ${counts.traits ?? 0}`,
    `活跃维度：${status.dimensions.filter((dimension) => dimension.active).map((dimension) => dimension.key).join(", ")}`,
    `最近全量扫描：${status.lastFullScanAt ?? "无记录"}`,
    `旧 JSON 导入：${status.legacyImportedAt ?? "无"}`,
    `采集心跳：${status.capture.lastAt ?? "无"} · 标准 ${status.capture.standardCount} · hex 回退 ${status.capture.sessionFallbackCount} · 挂起 ${status.capture.deferredCount}`,
    `维护启动：${maintenance.startedAt ?? "无"} · 间隔 ${maintenance.intervalMs ? Math.round(maintenance.intervalMs / 3_600_000) + "h" : "无"}`,
    `最近调度：${maintenance.scheduledAt ?? "无"} · 最近失败：${maintenance.lastError ?? "无"}`,
    `授权链：owner 只认宿主本次工具执行上下文的 senderIsOwner=true，或精确 toolCallId 的一次性 requester.senderIsOwner receipt`,
  ].join("\n");
}

function formatDetailedHealth(report: ReturnType<PeopleService["health"]>): string {
  const lines = [
    `${report.ok ? "✅" : "❌"} 识人库健康检查`,
    `数据库：${report.dbPath}`,
    `最近备份：${report.lastBackupAt ?? "无"}`,
    `采集心跳：${report.capture.lastAt ?? "无"} · 标准 ${report.capture.standardCount} · hex 回退 ${report.capture.sessionFallbackCount} · 挂起 ${report.capture.deferredCount}`,
    `计数：${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join("  ")}`,
  ];
  if (report.issues.length === 0) lines.push("没有发现需要处理的问题。");
  else {
    for (const issue of report.issues.slice(0, 50)) {
      lines.push(`· [${issue.level}] ${issue.code}: ${safeContextValue(issue.message, 300)}`);
    }
    if (report.issues.length > 50) lines.push(`… 另有 ${report.issues.length - 50} 条`);
  }
  return lines.join("\n");
}

function formatValidation(report: ReturnType<PeopleService["validate"]>): string {
  const lines = [
    `${report.ok ? "✅" : "❌"} 校验 ${report.ok ? "通过" : "失败"}`,
    `数据库：${report.dbPath}`,
    `计数：${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join("  ")}`,
  ];
  if (report.issues.length === 0) {
    lines.push("没有发现问题。");
  } else {
    for (const issue of report.issues.slice(0, 40)) {
      lines.push(`· [${issue.level}] ${issue.code}: ${safeContextValue(issue.message, 300)}`);
    }
    if (report.issues.length > 40) lines.push(`… 另有 ${report.issues.length - 40} 条`);
  }
  return lines.join("\n");
}

function maintenanceIntro(service: PeopleService): string {
  const maintenance = service.status().maintenance;
  if (!maintenance.active) return "插件后台 service 未在当前工作区运行。";
  return `插件后台 service 已启动（${maintenance.startedAt ?? "无"}），最近调度 ${maintenance.scheduledAt ?? "无"}，最近完成 ${maintenance.completedAt ?? "无"}，最近失败 ${maintenance.lastError ?? "无"}。`;
}

export function registerTools(api: OpenClawPluginApi, runtime: PeopleRuntime): void {
  const register = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    handler: (args: ToolArgs, ctx: ToolCtx, signal?: AbortSignal) => Promise<unknown> | unknown,
  ) => {
    api.registerTool(
      ((ctx: ToolCtx) => {
        const baseContext: ToolCtx = { ...ctx, identities: runtime.identities };
        return {
        name,
        label: name,
        description,
        parameters: parameters as AnyAgentTool["parameters"],
        execute: async (toolCallId: string, rawArgs: unknown, signal?: AbortSignal) => {
          const args = (rawArgs ?? {}) as ToolArgs;
          const callContext: ToolCtx = {
            ...baseContext,
            // The host tool factory context is the current-turn authority. A
            // matching before_tool_call receipt is an equivalent host source
            // for harnesses that expose authority only through that hook.
            senderIsOwner:
              baseContext.senderIsOwner === true ||
              runtime.identities.consumeToolCallOwner(toolCallId),
          };
          try {
            if (isAgentDisabled(runtime.config, callContext.agentId)) {
              throw new Error("本 agent 已在 disabledAgents 中关闭识人体系。");
            }
            if (WRITE_TOOL_NAMES.has(name) && !writeToolsEnabled(runtime.config)) {
              throw new Error("写入工具已关闭（writeTools=false）。需要记录时请先在插件配置中开启。");
            }
            return (await handler(args, callContext, signal)) as never;
          } finally {
            runtime.identities.discardToolCall(toolCallId);
          }
        },
        };
      }) as never,
      { name },
    );
  };

  register(
    "people_status",
    "状态入口：查看当前工作区识人库是否正常运行。普通 agent 只收到去标识化状态，owner 可看详细状态。",
    { type: "object", additionalProperties: false, properties: {} },
    (args, ctx) => {
      authorizeWorkspace(stringArg(args, "workspace"), ctx.workspaceDir);
      const service = toolService(runtime, ctx);
      return textResult(canManage(ctx) ? formatDetailedStatus(service) : formatStatus(service));
    },
  );

  register(
    "people_lookup",
    "查询当前对话对象、指定账号、指定人物或群的画像与记忆。默认查自己；查他人仅限 owner；群记忆默认只能查当前群。",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "账号 ID、显示名、person_id 或人物名；省略表示当前发送者。" },
        account: { type: "string", description: "账号 ID 或显示名，等价于 query。" },
        person: { type: "string", description: "人物 ID（p_ 开头）或人物名。" },
        group: { type: "string", description: "群 ID 或 chat_id；提供时查群记忆。" },
        full: { type: "boolean", description: "返回完整 traits 和印象列表（含 ID），用于 owner 诊断；常规画像压缩由插件后台完成。" },
      },
    },
    (args, ctx) => {
      const service = toolService(runtime, ctx);
      const full = boolArg(args, "full") === true;
      const groupRef = stringArg(args, "group");
      if (groupRef) {
        const group = resolveAccessibleGroup(service, ctx, runtime, groupRef, "只能查询当前群的群记忆。");
        return textResult(service.formatGroup(group));
      }

      const query = stringArg(args, "query");
      const accountArg = stringArg(args, "account");
      const personArg = stringArg(args, "person");
      const targetRef = accountArg ?? personArg ?? query;
      const isOwner = canManage(ctx);
      const self = currentAccount(ctx, runtime, service);
      if (!targetRef || targetRef === "self" || targetRef === "me" || targetRef === "我") {
        if (!self) throw new Error("当前消息没有可识别的发送者。");
        return textResult(service.formatLookup(self, full));
      }
      if (!isOwner) {
        if (!self) throw new Error("无法识别你的身份，暂时不能查询他人画像。");
        const selfMatches =
          targetRef === self.account_id ||
          targetRef === self.sender_id ||
          targetRef === self.display_name ||
          targetRef === self.confirmed_name ||
          targetRef === self.call_name ||
          targetRef === self.bound_person_id;
        if (!selfMatches) throw new Error("只能查询自己的画像。");
        return textResult(service.formatLookup(self, full));
      }
      const personRef = personArg ?? (query?.startsWith("p_") ? query : undefined);
      if (personRef) {
        let person = personRef.startsWith("p_") ? service.db.getPerson(personRef) : undefined;
        if (!person) {
          const matches = service.db.searchPersons(personRef, 5);
          if (matches.length > 1) {
            throw new Error(
              `找到多个人物匹配「${safeContextValue(personRef, 160)}」：${matches.map((item) => `${safeContextValue(item.person_id, 80)}（${safeContextValue(item.call_name || item.name || "未命名")}）`).join("、")}。请用 person_id。`,
            );
          }
          person = matches[0];
        }
        if (!person) throw new Error(`没有找到人物：${personRef}`);
        return textResult(service.formatPersonLookup(person.person_id, full));
      }

      const accountRef = accountArg ?? query;
      if (!accountRef) throw new Error("请提供 query、account、person 或 group。");
      try {
        return textResult(service.formatLookup(resolveAccountRef(service, accountRef), full));
      } catch (error) {
        const matches = service.db.searchPersons(accountRef, 5);
        if (matches.length === 1) {
          return textResult(service.formatPersonLookup(matches[0].person_id, full));
        }
        if (matches.length > 1) {
          throw new Error(
            `找到多个人物匹配「${safeContextValue(accountRef, 160)}」：${matches.map((item) => `${safeContextValue(item.person_id, 80)}（${safeContextValue(item.call_name || item.name || "未命名")}）`).join("、")}。请用 person_id。`,
          );
        }
        throw error;
      }
    },
  );

  register(
    "people_remember",
    "记录一条关于某人的事实或印象；可选写入某个特征维度。默认记录当前发送者。",
    {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "string", description: "要记录的事实，尽量保留原始表述。" },
        dimension: { type: "string", description: "可选特征维度 key，例如 basic_origin、preference。" },
        mode: { type: "string", enum: ["append", "replace"], description: "维度值写入方式，默认 append。" },
        account: { type: "string", description: "目标账号；省略表示当前发送者。仅 owner 可指定他人。" },
        person: { type: "string", description: "目标人物 ID（p_ 开头）。仅 owner 可用，用于整理人物级画像。" },
        source: { type: "string", description: "来源标记，例如 chat、manual、scan。" },
      },
    },
    (args, ctx) => {
      const service = toolService(runtime, ctx);
      const content = stringArg(args, "content");
      if (!content) throw new Error("content 不能为空。");
      const personId = stringArg(args, "person");
      if (personId) {
        if (!canManage(ctx)) throw new Error("只有 owner 可以整理人物级画像。");
        const person = service.db.getPerson(personId);
        if (!person) throw new Error(`没有找到人物：${personId}`);
        const modeRaw = stringArg(args, "mode");
        const result = service.remember({
          personId: person.person_id,
          content,
          dimension: stringArg(args, "dimension"),
          mode: modeRaw === "replace" ? "replace" : "append",
          agentId: ctx.agentId,
          source: stringArg(args, "source") ?? "tool",
        });
        return textResult(
          rememberResult(person.call_name || person.name || person.person_id, result),
        );
      }
      const accountRef = stringArg(args, "account");
      const target = resolveMutationAccount(service, ctx, runtime, accountRef, {
        noSelf: "当前消息没有可识别的发送者。",
        foreign: "只能记录自己的信息。",
      });
      const modeRaw = stringArg(args, "mode");
      const result = service.remember({
        accountId: target.account_id,
        content,
        dimension: stringArg(args, "dimension"),
        mode: modeRaw === "replace" ? "replace" : "append",
        agentId: ctx.agentId,
        source: stringArg(args, "source") ?? "tool",
      });
      return textResult(rememberResult(target.display_name ?? target.account_id, result));
    },
  );

  register(
    "people_name",
    "设置称呼：本人钦定的 call_name（优先使用），或 confirmed_name / 人物名。默认操作当前发送者。",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        call_name: { type: "string", description: "本人指定的称呼，例如「阿龙」。写入后不会被昵称同步覆盖。" },
        confirmed_name: { type: "string", description: "本人确认的名字。" },
        person_name: { type: "string", description: "绑定人物的正式名字（仅 owner）。" },
        account: { type: "string", description: "目标账号；省略表示当前发送者。仅 owner 可指定他人。" },
      },
    },
    (args, ctx) => {
      const service = toolService(runtime, ctx);
      const accountRef = stringArg(args, "account");
      const target = resolveMutationAccount(service, ctx, runtime, accountRef, {
        noSelf: "当前消息没有可识别的发送者。",
        foreign: "只能设置自己的称呼。",
      });
      if (stringArg(args, "person_name") && !ownerAuthorized(ctx)) {
        throw new Error("只有 owner 可以修改人物正式名字。");
      }
      const result = service.setName({
        accountId: target.account_id,
        callName: stringArg(args, "call_name"),
        confirmedName: stringArg(args, "confirmed_name"),
        personName: stringArg(args, "person_name"),
      });
      return textResult(
        `已更新${result.target === "person" ? "人物" : "账号"}称呼${result.callName ? `：${safeContextValue(result.callName)}` : "。"}`,
      );
    },
  );

  register(
    "people_note",
    "向当前群或指定群追加一条群记忆。非 owner 只能写当前群。",
    {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string" },
        category: { type: "string", description: "milestone / rule / observation / personal_info 等。" },
        tags: { type: "array", items: { type: "string" } },
        group: { type: "string", description: "群 ID 或 chat_id；省略表示当前群。" },
      },
    },
    (args, ctx) => {
      const service = toolService(runtime, ctx);
      const summary = stringArg(args, "summary");
      if (!summary) throw new Error("summary 不能为空。");
      const explicitGroup = stringArg(args, "group");
      const group = resolveAccessibleGroup(
        service,
        ctx,
        runtime,
        explicitGroup ?? "",
        "只能向当前群写入群记忆。",
      );
      const result = service.note({
        groupId: group.group_id,
        summary,
        category: stringArg(args, "category"),
        tags: listArg(args, "tags"),
        agentId: ctx.agentId,
      });
      return textResult(result.stored ? "已写入群记忆。" : "同一天已有相同记忆，未重复写入。");
    },
  );

  register(
    "people_bot_hint",
    "修正账号的历史行为推断（unknown/human/bot/mixed）。该值仅据历史得出，可能误判，不构成身份、回复门禁或授权。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["hint"],
      properties: {
        account: { type: "string", description: "账号 ID 或可唯一定位的显示名；省略表示当前发送者账号。" },
        hint: {
          type: "string",
          enum: ["unknown", "human", "bot", "mixed"],
          description: "mixed 表示观察证据显示同一账号可能由人与 bot 共用。",
        },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("修正历史行为推断仅限 owner。");
      const service = toolService(runtime, ctx);
      const hint = stringArg(args, "hint");
      if (hint !== "unknown" && hint !== "human" && hint !== "bot" && hint !== "mixed") {
        throw new Error("hint 必须是 unknown、human、bot 或 mixed。");
      }
      const accountRef = stringArg(args, "account");
      const account = accountRef
        ? resolveAccountRef(service, accountRef)
        : currentAccount(ctx, runtime, service);
      if (!account) throw new Error("当前消息没有可识别的发送者；请用 account 指定目标账号。");
      const updated = service.setAccountBotHint(account.account_id, hint as BotHint);
      return textResult(
        `已更新 ${safeContextValue(updated.account_id, 160)} 的历史行为推断为 ${updated.bot_hint}（仅供参考，可能误判；非身份或授权）。`,
      );
    },
  );

  register(
    "people_bind",
    "把账号绑定到人物（仅 owner）。绑定后画像合并到人物级。",
    {
      type: "object",
      additionalProperties: false,
      required: ["account"],
      properties: {
        account: { type: "string", description: "账号 ID 或可唯一定位的显示名。" },
        person_id: { type: "string" },
        name: { type: "string", description: "人物名；不传则用账号显示名。" },
        confidence: { type: "string", enum: ["confirmed", "tentative"] },
      },
    },
    (args, ctx) => {
      if (!ownerAuthorized(ctx)) throw new Error("只有 owner 可以绑定人物。");
      const service = toolService(runtime, ctx);
      const account = resolveAccountRef(service, stringArg(args, "account") ?? "");
      const result = service.bind({
        accountId: account.account_id,
        personId: stringArg(args, "person_id"),
        name: stringArg(args, "name"),
        confidence: stringArg(args, "confidence"),
      });
      if (result.alreadyBound) {
        return textResult(
          `账号 ${safeContextValue(account.account_id, 160)} 已绑定到人物 ${safeContextValue(result.personId, 80)}，未重复变更。`,
        );
      }
      return textResult(
        `已绑定 ${safeContextValue(account.account_id, 160)} → ${safeContextValue(result.personId, 80)}${result.createdPerson ? "（新建人物）" : ""}；迁移印象 ${result.moved.impressions} 条、特征 ${result.moved.traits} 个${result.moved.traitsPreserved ? `、保留冲突特征 ${result.moved.traitsPreserved} 个` : ""}。`,
      );
    },
  );

  register(
    "people_forget",
    "删除匹配到的印象或特征。默认只能操作自己；owner 可指定账号；purge 仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["match"],
      properties: {
        match: { type: "string", description: "要删除的内容片段。" },
        account: { type: "string" },
        person: { type: "string", description: "目标人物 ID（p_ 开头）。仅 owner 可用。" },
        scope: {
          type: "string",
          enum: ["all", "impressions", "traits"],
          description: "删除范围，默认 all；需要只清理原始印象时显式用 impressions。",
        },
        purge: {
          type: "boolean",
          description: "彻底清除：同时删除备份和旧 JSON 归档中的历史数据。不可恢复，默认关闭。",
        },
      },
    },
    (args, ctx) => {
      const service = toolService(runtime, ctx);
      const match = stringArg(args, "match");
      if (!match) throw new Error("match 不能为空。");
      const scopeRaw = stringArg(args, "scope");
      const scope = scopeRaw === "impressions" || scopeRaw === "traits" ? scopeRaw : "all";
      const purge = boolArg(args, "purge") === true;
      if (purge && !canManage(ctx)) {
        throw new Error("彻底清除（purge）仅限 owner。");
      }
      const personId = stringArg(args, "person");
      if (personId) {
        if (!canManage(ctx)) throw new Error("只有 owner 可以整理人物级画像。");
        const person = service.db.getPerson(personId);
        if (!person) throw new Error(`没有找到人物：${personId}`);
        const result = service.forget({ personId: person.person_id, match, scope, purge });
        return textResult(forgetResultText(result));
      }
      const accountRef = stringArg(args, "account");
      const target = resolveMutationAccount(service, ctx, runtime, accountRef, {
        noSelf: "当前消息没有可识别的发送者。",
        foreign: "只能删除自己的信息。",
      });
      const result = service.forget({ accountId: target.account_id, match, scope, purge });
      return textResult(forgetResultText(result));
    },
  );

  register(
    "people_validate",
    "诊断入口：校验当前工作区识人库的一致性，仅 owner 可查看；owner 可选择自动修复可修复项。",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        fix: { type: "boolean" },
      },
    },
    (args, ctx) => {
      authorizeWorkspace(stringArg(args, "workspace"), ctx.workspaceDir);
      const service = toolService(runtime, ctx);
      if (!canManage(ctx)) throw new Error("诊断信息仅 owner 可查看；查看运行状态请用 people_status。");
      const fix = boolArg(args, "fix") === true;
      if (fix && !writeToolsEnabled(runtime.config)) throw new Error("写入工具已关闭（writeTools=false），无法自动修复。");
      const repaired = fix ? service.repairWithBackup() : null;
      const actions = repaired?.actions ?? [];
      const report = service.validate();
      const text = formatValidation(report);
      const backupNote = repaired ? `\n\n修复前备份：${repaired.backup.dbBackup}` : "";
      const repairNote = actions.length > 0
        ? `\n\n修复：${actions.map((action) => safeContextValue(action, 500)).join("；")}`
        : "";
      return textResult(`${text}${backupNote}${repairNote}`);
    },
  );

  register(
    "people_scan_mark",
    "记录某个会话/频道的扫描进度；full=true 时同时更新全量扫描时间。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: {
        channel: { type: "string", description: "频道或会话 key。" },
        displayName: { type: "string" },
        kind: { type: "string" },
        platform: { type: "string" },
        group: { type: "string" },
        lastScanAt: { type: "string" },
        full: { type: "boolean" },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("记录扫描进度仅限 owner。");
      const service = toolService(runtime, ctx);
      const channel = stringArg(args, "channel");
      if (!channel) throw new Error("channel 不能为空。");
      const lastScanAt = stringArg(args, "lastScanAt") ?? nowIso();
      service.db.upsertScanChannel({
        channelKey: channel,
        displayName: stringArg(args, "displayName"),
        kind: stringArg(args, "kind"),
        platform: stringArg(args, "platform"),
        groupId: stringArg(args, "group"),
        lastScanAt,
      });
      if (boolArg(args, "full") === true) service.db.setScanMeta(lastScanAt);
      return textResult(`已记录扫描进度：${safeContextValue(channel, 160)} @ ${safeContextValue(lastScanAt, 80)}`);
    },
  );

  register(
    "people_bootstrap",
    "初始化当前工作区的识人库，并导入旧 JSON（如果存在）。可重复执行。仅 owner 可用。",
    { type: "object", additionalProperties: false, properties: {} },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("初始化识人库仅限 owner。");
      authorizeWorkspace(stringArg(args, "workspace"), ctx.workspaceDir);
      const service = toolService(runtime, ctx);
      return textResult(`${formatStatus(service)}\n初始化完成。`);
    },
  );

  register(
    "people_backup",
    "为当前工作区创建一致的 SQLite 与 JSON 备份，并清理超出保留数量的旧备份。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        keep: { type: "number", description: "保留最近多少份备份，默认 14，最少 2。" },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("备份识人库仅限 owner。");
      authorizeWorkspace(stringArg(args, "workspace"), ctx.workspaceDir);
      const service = toolService(runtime, ctx);
      const keepRaw = typeof args.keep === "number" ? args.keep : 14;
      const report = service.backup(keepRaw);
      return textResult(
        [
          "备份完成。",
          `SQLite：${report.dbBackup}（${report.dbBytes} bytes）`,
          `JSON：${report.jsonBackup}（${report.jsonBytes} bytes）`,
          `保留 ${report.kept} 份${report.removedOld ? `，清理旧文件 ${report.removedOld} 个` : ""}。`,
        ].join("\n"),
      );
    },
  );

  register(
    "people_health",
    "诊断入口：检查当前工作区识人库的完整性、备份和风险明细，仅 owner 可查看；普通状态请用 people_status。",
    { type: "object", additionalProperties: false, properties: {} },
    (args, ctx) => {
      authorizeWorkspace(stringArg(args, "workspace"), ctx.workspaceDir);
      const service = toolService(runtime, ctx);
      if (!canManage(ctx)) throw new Error("诊断信息仅 owner 可查看；查看运行状态请用 people_status。");
      return textResult(formatDetailedHealth(service.health()));
    },
  );

  register(
    "people_cycle",
    "诊断入口：只读查看最近维护摘要，或由 owner 手动触发一次插件内部维护；后台 service 已自动执行。",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        run: { type: "boolean", description: "仅 owner 可用；手动触发一次插件内部维护，默认只读摘要。" },
        backup_keep: { type: "number" },
        backup_interval_hours: { type: "number" },
        force_backup: { type: "boolean" },
      },
    },
    async (args, ctx, signal) => {
      authorizeWorkspace(stringArg(args, "workspace"), ctx.workspaceDir);
      const service = toolService(runtime, ctx);
      if (!canManage(ctx)) throw new Error("诊断信息仅 owner 可查看；查看运行状态请用 people_status。");
      let report = runtime.maintenanceSummary({ workspaceDir: service.paths.workspaceDir, agentId: ctx.agentId });
      if (boolArg(args, "run") === true) {
        if (!writeToolsEnabled(runtime.config)) {
          throw new Error("写入工具已关闭（writeTools=false），无法手动触发维护；只读摘要仍可查看。");
        }
        const cycle = await runtime.runMaintenanceCycle(
          { workspaceDir: service.paths.workspaceDir, agentId: ctx.agentId },
          {
            backupKeep: typeof args.backup_keep === "number" ? args.backup_keep : 14,
            backupIntervalHours:
              typeof args.backup_interval_hours === "number" ? args.backup_interval_hours : 20,
            forceBackup: boolArg(args, "force_backup") === true,
          },
          signal,
        );
        if (!cycle) {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("people_cycle cancelled");
          }
          return textResult("本工作区已有维护轮次在执行，本次手动触发已跳过；请稍后用默认只读模式查看摘要。");
        }
        report = runtime.maintenanceSummary({ workspaceDir: service.paths.workspaceDir, agentId: ctx.agentId });
      }
      if (!report) {
        return textResult(
          `识人维护周期\n${maintenanceIntro(service)}当前进程尚无已完成轮次；owner 可用 run=true 手动触发一次。`,
        );
      }
      const semantic = report.semantic;
      const svc = service.status().maintenance;
      const lines = [
        "识人维护摘要（仅计数，不含画像原文）",
        `最近周期：${report.cycledAt} · 耗时 ${report.durationMs}ms`,
        `健康：${report.healthOk ? "ok" : "error"} · 备份：${report.backup ? "已创建" : "跳过"} · 自动修复 ${report.repairActions} 项`,
        `内部语义压缩：${semantic.unavailable ? "宿主隔离推理不可用，原文保留" : `完成 ${semantic.compacted}/${semantic.processed}`}`,
        `失败 ${semantic.failed} 项 · 剩余待压缩 ${semantic.remaining} 项`,
      ];
      if (svc.lastError) lines.push("后台最近失败：有（详情见 people_status 的 owner 视图）");
      if (semantic.reason) lines.push(`说明：${semantic.reason}`);
      lines.push("日常运行由插件后台 service 完成；agent 不需要整理画像，也不会收到画像原文。");
      return textResult(lines.join("\n"));
    },
  );

  register(
    "people_search",
    "在当前工作区搜索账号、人物、印象和群事件。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("搜索全局记忆仅限 owner。");
      const service = toolService(runtime, ctx);
      const report = service.search(
        stringArg(args, "query") ?? "",
        typeof args.limit === "number" ? args.limit : 10,
      );
      const lines = [`搜索：${safeContextValue(stringArg(args, "query"), 160)}`];
      if (report.accounts.length) {
        lines.push("", "账号");
        for (const account of report.accounts) {
          lines.push(
            `· ${safeContextValue(account.account_id, 160)}（${safeContextValue(account.call_name || account.confirmed_name || account.display_name || "未命名")}）`,
          );
        }
      }
      if (report.persons.length) {
        lines.push("", "人物");
        for (const person of report.persons) {
          lines.push(
            `· ${safeContextValue(person.person_id, 80)}（${safeContextValue(person.call_name || person.name || "未命名")}）`,
          );
        }
      }
      if (report.impressions.length) {
        lines.push("", "印象");
        for (const impression of report.impressions) {
          lines.push(
            `· ${safeContextValue(impression.owner_id, 120)}：${safeContextValue(impression.content)}`,
          );
        }
      }
      if (report.groupEvents.length) {
        lines.push("", "群事件");
        for (const event of report.groupEvents) {
          lines.push(
            `· ${safeContextValue(event.group_id, 160)} ${safeContextValue(event.occurred_at.slice(0, 10), 12)}：${safeContextValue(event.summary)}`,
          );
        }
      }
      if (lines.length === 1) lines.push("没有找到匹配记录。");
      return textResult(lines.join("\n"));
    },
  );

  register(
    "people_dimension",
    "查看、添加或启停画像特征维度。添加和启停仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "add", "enable", "disable"] },
        key: { type: "string" },
        label: { type: "string" },
        sort: { type: "number" },
      },
    },
    (args, ctx) => {
      const service = toolService(runtime, ctx);
      const action = stringArg(args, "action") ?? "list";
      if (action === "list") {
        return textResult(
          service.db
            .listDimensions()
            .map((dimension) => `${safeContextValue(dimension.key, 48)} · ${safeContextValue(dimension.label, 80)} · ${dimension.active ? "启用" : "停用"} · sort=${dimension.sort}`)
            .join("\n"),
        );
      }
      if (!canManage(ctx)) throw new Error("修改维度仅限 owner。");
      if (!writeToolsEnabled(runtime.config)) throw new Error("写入工具已关闭（writeTools=false），无法修改维度。");
      const key = stringArg(args, "key");
      if (!key) throw new Error("key 不能为空。");
      const existing = service.db.getDimension(key);
      const active = action !== "disable";
      const dimension = service.upsertDimension(
        key,
        stringArg(args, "label") ?? existing?.label ?? key,
        active,
        typeof args.sort === "number" ? args.sort : existing?.sort ?? 999,
      );
      return textResult(`已更新维度 ${safeContextValue(dimension.key, 48)}：${safeContextValue(dimension.label, 80)}，${dimension.active ? "启用" : "停用"}。`);
    },
  );

  register(
    "people_merge",
    "合并两个人物记录到一个目标人物。用于清理重复人物；需要 confirm=true。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["source", "target"],
      properties: {
        source: { type: "string", description: "被合并的 person_id" },
        target: { type: "string", description: "保留的 person_id" },
        confirm: { type: "boolean" },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("合并人物仅限 owner。");
      if (boolArg(args, "confirm") !== true) throw new Error("合并人物需要 confirm=true。");
      const service = toolService(runtime, ctx);
      const source = stringArg(args, "source");
      const target = stringArg(args, "target");
      if (!source || !target) throw new Error("source 和 target 不能为空。");
      const result = service.mergePersons(source, target);
      return textResult(
        `已合并 ${safeContextValue(source, 80)} → ${safeContextValue(target, 80)}：迁移账号 ${result.accounts}、印象 ${result.impressions}、特征 ${result.traits}。`,
      );
    },
  );

  register(
    "people_unbind",
    "解除账号与人物绑定，默认把人物画像复制回账号，避免解绑即丢画像。需要 confirm=true。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["account"],
      properties: {
        account: { type: "string" },
        copy_profile: { type: "boolean", description: "默认 true。" },
        confirm: { type: "boolean" },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("解绑人物仅限 owner。");
      if (boolArg(args, "confirm") !== true) throw new Error("解绑人物需要 confirm=true。");
      const service = toolService(runtime, ctx);
      const account = resolveAccountRef(service, stringArg(args, "account") ?? "");
      const result = service.unbind(account.account_id, boolArg(args, "copy_profile") !== false);
      return textResult(
        `已解除 ${safeContextValue(account.account_id, 160)} 的人物绑定；复制印象 ${result.impressionsCopied} 条、特征 ${result.traitsCopied} 个。`,
      );
    },
  );
  register(
    "people_merge_account",
    "把同一人物的平台双份账号归并到一个账号（例如 bncr:x 并入 bncr/tgBot:x）。迁移印象/特征/群成员，必要时迁移人物绑定。需要 confirm=true。仅 owner 可用。",
    {
      type: "object",
      additionalProperties: false,
      required: ["source", "target"],
      properties: {
        source: { type: "string", description: "被归并的账号 ID 或显示名" },
        target: { type: "string", description: "保留的账号 ID 或显示名" },
        confirm: { type: "boolean" },
      },
    },
    (args, ctx) => {
      if (!canManage(ctx)) throw new Error("账号归并仅限 owner。");
      if (boolArg(args, "confirm") !== true) throw new Error("账号归并需要 confirm=true。");
      const service = toolService(runtime, ctx);
      const source = resolveAccountRef(service, stringArg(args, "source") ?? "");
      const target = resolveAccountRef(service, stringArg(args, "target") ?? "");
      const result = service.mergeAccounts(source.account_id, target.account_id);
      return textResult(
        `已归并 ${safeContextValue(source.account_id, 160)} → ${safeContextValue(target.account_id, 160)}：印象 ${result.impressions}、特征 ${result.traits}、群成员 ${result.groupMembers}${result.bindingMoved ? "，并迁移了人物绑定" : ""}。`,
      );
    },
  );
}

export { textResult, currentIdentity };
export type { ToolArgs };
