import { resolvePlatform } from "../core/platform.js";
import { nowIso } from "../core/time.js";
import { canManage, groupMatchesCurrent, isInternalAdmin, writeToolsEnabled } from "./authz.js";
function stringArg(args, key) {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function boolArg(args, key) {
    return typeof args[key] === "boolean" ? args[key] : undefined;
}
function listArg(args, key) {
    const value = args[key];
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function textResult(text) {
    return { content: [{ type: "text", text }], details: {} };
}
function rememberResult(label, result) {
    if (result.traitUpdated && result.impressionStored)
        return `已记录到 ${label}，并更新了特征维度。`;
    if (result.traitUpdated)
        return `已更新 ${label} 的特征维度。`;
    if (result.impressionStored)
        return `已记录到 ${label}。`;
    return "这条内容已存在，未重复写入。";
}
function forgetResultText(result) {
    const base = `已删除印象 ${result.impressions} 条、特征 ${result.traits} 个。`;
    if (!result.purged)
        return base;
    return `${base}已清理备份/旧归档：文件 ${result.purged.files} 个、目录 ${result.purged.dirs} 个。`;
}
function toolService(runtime, ctx, workspace) {
    return runtime.get({
        workspaceDir: workspace || ctx.workspaceDir,
        agentId: ctx.agentId,
        agentDir: ctx.agentDir,
    });
}
function currentPlatform(ctx, runtime) {
    return resolvePlatform({
        channel: ctx.messageChannel,
        provider: ctx.messageChannel,
        accountId: ctx.agentAccountId,
        template: runtime.config.platformTemplate,
        overrides: runtime.config.platformOverrides,
    });
}
function currentAccount(ctx, runtime, service) {
    const senderId = ctx.requesterSenderId?.trim();
    if (!senderId)
        return null;
    return service.resolveAccountForLookup(currentPlatform(ctx, runtime), senderId);
}
function requireAccount(ctx, runtime, service) {
    const account = currentAccount(ctx, runtime, service);
    if (!account)
        throw new Error("当前消息没有可识别的发送者，无法确定画像对象。");
    return account;
}
function resolveAccountRef(service, ref) {
    const matches = service.searchAccounts(ref);
    if (matches.length === 0)
        throw new Error(`没有找到账号：${ref}`);
    if (matches.length > 1) {
        const exact = matches.filter((account) => account.account_id === ref ||
            account.display_name === ref ||
            account.confirmed_name === ref ||
            account.sender_id === ref);
        if (exact.length === 1)
            return exact[0];
        throw new Error(`匹配到多个账号，请用 account_id 精确指定：${matches
            .slice(0, 5)
            .map((account) => `${account.account_id}(${account.display_name ?? "?"})`)
            .join(", ")}`);
    }
    return matches[0];
}
function formatStatus(service) {
    const status = service.status();
    const counts = status.counts;
    return [
        "识人库状态",
        `工作区：${status.workspaceDir}`,
        `数据目录：${status.dataDir}`,
        `数据库：${status.dbPath}（schema v${status.schemaVersion}）`,
        `账号 ${counts.accounts ?? 0} · 人物 ${counts.persons ?? 0} · 绑定 ${counts.person_accounts ?? 0} · 群 ${counts.groups ?? 0}`,
        `群成员 ${counts.group_members ?? 0} · 群记忆 ${counts.group_events ?? 0} · 印象 ${counts.impressions ?? 0} · 特征 ${counts.traits ?? 0}`,
        `活跃维度：${status.dimensions.filter((dimension) => dimension.active).map((dimension) => dimension.key).join(", ")}`,
        `最近全量扫描：${status.lastFullScanAt ?? "无记录"}`,
        `旧 JSON 导入：${status.legacyImportedAt ?? "无"}`,
        status.security.strictInternalAdmin
            ? `安全模式：严格（内部管理员：${status.security.internalAdminAgents?.join(", ") || "无"}；写入工具：${status.security.writeTools ? "开" : "关"}）`
            : "安全模式：兼容（默认行为；可设置 internalAdminAgents 收紧内部提权）",
    ].join("\n");
}
function formatValidation(report) {
    const lines = [
        `${report.ok ? "✅" : "❌"} 校验 ${report.ok ? "通过" : "失败"}`,
        `数据库：${report.dbPath}`,
        `计数：${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join("  ")}`,
    ];
    if (report.issues.length === 0) {
        lines.push("没有发现问题。");
    }
    else {
        for (const issue of report.issues.slice(0, 40)) {
            lines.push(`· [${issue.level}] ${issue.code}: ${issue.message}`);
        }
        if (report.issues.length > 40)
            lines.push(`… 另有 ${report.issues.length - 40} 条`);
    }
    return lines.join("\n");
}
export function registerTools(api, runtime) {
    const WRITE_TOOLS = new Set([
        "people_remember",
        "people_name",
        "people_note",
        "people_bind",
        "people_forget",
        "people_bootstrap",
        "people_backup",
        "people_cycle",
        "people_merge",
        "people_unbind",
        "people_scan_mark",
    ]);
    const register = (name, description, parameters, handler) => {
        api.registerTool(((ctx) => ({
            name,
            label: name,
            description,
            parameters: parameters,
            execute: async (_toolCallId, rawArgs) => {
                const args = (rawArgs ?? {});
                if (WRITE_TOOLS.has(name) && !writeToolsEnabled(runtime.config)) {
                    throw new Error("写入工具已关闭（writeTools=false）。需要记录时请先在插件配置中开启。");
                }
                return (await handler(args, ctx));
            },
        })), { name });
    };
    register("people_status", "查看当前工作区识人库的状态和计数。仅 owner 或内部维护任务可用。", { type: "object", additionalProperties: false, properties: { workspace: { type: "string" } } }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("查看识人库状态仅限 owner 或内部维护任务。");
        const service = toolService(runtime, ctx, stringArg(args, "workspace"));
        return textResult(formatStatus(service));
    });
    register("people_lookup", "查询当前对话对象、指定账号、指定人物或群的画像与记忆。默认查自己；查他人仅限 owner；群记忆默认只能查当前群。", {
        type: "object",
        additionalProperties: false,
        properties: {
            query: { type: "string", description: "账号 ID、显示名、person_id 或人物名；省略表示当前发送者。" },
            account: { type: "string", description: "账号 ID 或显示名，等价于 query。" },
            person: { type: "string", description: "人物 ID（p_ 开头）或人物名。" },
            group: { type: "string", description: "群 ID 或 chat_id；提供时查群记忆。" },
            full: { type: "boolean", description: "返回完整 traits 和印象列表（含 ID），用于画像归并；普通展示用默认卡片。" },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx);
        const full = boolArg(args, "full") === true;
        const groupRef = stringArg(args, "group");
        if (groupRef) {
            const group = service.resolveGroup(groupRef);
            if (!group)
                throw new Error(`没有找到群：${groupRef}。可以只传数字群号。`);
            if (!canManage(ctx, runtime.config) && !groupMatchesCurrent(group, ctx.nativeChannelId)) {
                throw new Error("只能查询当前群的群记忆。");
            }
            return textResult(service.formatGroup(group));
        }
        const self = currentAccount(ctx, runtime, service);
        const query = stringArg(args, "query");
        const accountArg = stringArg(args, "account");
        const personArg = stringArg(args, "person");
        const targetRef = accountArg ?? personArg ?? query;
        if (!targetRef || targetRef === "self" || targetRef === "me" || targetRef === "我") {
            if (!self)
                throw new Error("当前消息没有可识别的发送者。");
            return textResult(service.formatLookup(self, full));
        }
        const isOwner = ctx.senderIsOwner === true;
        // Internal turns (cron, isolated jobs) have no requester sender. They keep
        // the compatible privileged default; strict mode narrows this to agents
        // listed in `internalAdminAgents`.
        const isInternal = isInternalAdmin(ctx, runtime.config);
        if (!isOwner && !isInternal) {
            if (!self)
                throw new Error("无法识别你的身份，暂时不能查询他人画像。");
            const selfMatches = targetRef === self.account_id ||
                targetRef === self.sender_id ||
                targetRef === self.display_name ||
                targetRef === self.confirmed_name ||
                targetRef === self.call_name ||
                targetRef === self.bound_person_id;
            if (!selfMatches)
                throw new Error("只能查询自己的画像。");
            return textResult(service.formatLookup(self, full));
        }
        const personRef = personArg ?? (query?.startsWith("p_") ? query : undefined);
        if (personRef) {
            let person = personRef.startsWith("p_") ? service.db.getPerson(personRef) : undefined;
            if (!person) {
                const matches = service.db.searchPersons(personRef, 5);
                if (matches.length > 1) {
                    throw new Error(`找到多个人物匹配「${personRef}」：${matches.map((item) => `${item.person_id}（${item.call_name || item.name || "未命名"}）`).join("、")}。请用 person_id。`);
                }
                person = matches[0];
            }
            if (!person)
                throw new Error(`没有找到人物：${personRef}`);
            return textResult(service.formatPersonLookup(person.person_id, full));
        }
        const accountRef = accountArg ?? query;
        if (!accountRef)
            throw new Error("请提供 query、account、person 或 group。");
        try {
            return textResult(service.formatLookup(resolveAccountRef(service, accountRef), full));
        }
        catch (error) {
            const matches = service.db.searchPersons(accountRef, 5);
            if (matches.length === 1) {
                return textResult(service.formatPersonLookup(matches[0].person_id, full));
            }
            if (matches.length > 1) {
                throw new Error(`找到多个人物匹配「${accountRef}」：${matches.map((item) => `${item.person_id}（${item.call_name || item.name || "未命名"}）`).join("、")}。请用 person_id。`);
            }
            throw error;
        }
    });
    register("people_remember", "记录一条关于某人的事实或印象；可选写入某个特征维度。默认记录当前发送者。", {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
            content: { type: "string", description: "要记录的事实，尽量保留原始表述。" },
            dimension: { type: "string", description: "可选特征维度 key，例如 basic_origin、preference。" },
            mode: { type: "string", enum: ["append", "replace"], description: "维度值写入方式，默认 append。" },
            account: { type: "string", description: "目标账号；省略表示当前发送者。仅 owner 可指定他人。" },
            person: { type: "string", description: "目标人物 ID（p_ 开头）。仅 owner 或内部维护任务可用，用于整理人物级画像。" },
            source: { type: "string", description: "来源标记，例如 chat、manual、scan。" },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx);
        const content = stringArg(args, "content");
        if (!content)
            throw new Error("content 不能为空。");
        const personId = stringArg(args, "person");
        if (personId) {
            if (!canManage(ctx, runtime.config))
                throw new Error("只有 owner 或内部维护任务可以整理人物级画像。");
            const person = service.db.getPerson(personId);
            if (!person)
                throw new Error(`没有找到人物：${personId}`);
            const modeRaw = stringArg(args, "mode");
            const result = service.remember({
                personId: person.person_id,
                content,
                dimension: stringArg(args, "dimension"),
                mode: modeRaw === "replace" ? "replace" : "append",
                agentId: ctx.agentId,
                source: stringArg(args, "source") ?? "tool",
            });
            return textResult(rememberResult(person.call_name || person.name || person.person_id, result));
        }
        const self = currentAccount(ctx, runtime, service);
        const accountRef = stringArg(args, "account");
        const target = accountRef ? resolveAccountRef(service, accountRef) : self;
        if (!target)
            throw new Error("当前消息没有可识别的发送者，请用 account 指定目标。");
        if (target.account_id !== self?.account_id && !canManage(ctx, runtime.config)) {
            throw new Error("只能记录自己的信息。");
        }
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
    });
    register("people_name", "设置称呼：本人钦定的 call_name（优先使用），或 confirmed_name / 人物名。默认操作当前发送者。", {
        type: "object",
        additionalProperties: false,
        properties: {
            call_name: { type: "string", description: "本人指定的称呼，例如「阿龙」。写入后不会被昵称同步覆盖。" },
            confirmed_name: { type: "string", description: "本人确认的名字。" },
            person_name: { type: "string", description: "绑定人物的正式名字（仅 owner）。" },
            account: { type: "string", description: "目标账号；省略表示当前发送者。仅 owner 可指定他人。" },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx);
        const self = currentAccount(ctx, runtime, service);
        const accountRef = stringArg(args, "account");
        const target = accountRef ? resolveAccountRef(service, accountRef) : self;
        if (!target)
            throw new Error("当前消息没有可识别的发送者，请用 account 指定目标。");
        if (target.account_id !== self?.account_id && !canManage(ctx, runtime.config)) {
            throw new Error("只能设置自己的称呼。");
        }
        if (stringArg(args, "person_name") && ctx.senderIsOwner !== true) {
            throw new Error("只有 owner 可以修改人物正式名字。");
        }
        const result = service.setName({
            accountId: target.account_id,
            callName: stringArg(args, "call_name"),
            confirmedName: stringArg(args, "confirmed_name"),
            personName: stringArg(args, "person_name"),
        });
        return textResult(`已更新${result.target === "person" ? "人物" : "账号"}称呼${result.callName ? `：${result.callName}` : "。"}`);
    });
    register("people_note", "向当前群或指定群追加一条群记忆。非 owner 只能写当前群。", {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
            summary: { type: "string" },
            category: { type: "string", description: "milestone / rule / observation / personal_info 等。" },
            tags: { type: "array", items: { type: "string" } },
            group: { type: "string", description: "群 ID 或 chat_id；省略表示当前群。" },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx);
        const summary = stringArg(args, "summary");
        if (!summary)
            throw new Error("summary 不能为空。");
        const explicitGroup = stringArg(args, "group");
        const groupRef = explicitGroup ?? ctx.nativeChannelId ?? "";
        if (!groupRef)
            throw new Error("当前会话没有群标识，请显式传 group。");
        const group = service.resolveGroupStrict(groupRef);
        if (explicitGroup && !canManage(ctx, runtime.config) && !groupMatchesCurrent(group, ctx.nativeChannelId)) {
            throw new Error("只能向当前群写入群记忆。");
        }
        const result = service.note({
            groupId: group.group_id,
            summary,
            category: stringArg(args, "category"),
            tags: listArg(args, "tags"),
            agentId: ctx.agentId,
        });
        return textResult(result.stored ? "已写入群记忆。" : "同一天已有相同记忆，未重复写入。");
    });
    register("people_bind", "把账号绑定到人物（仅 owner）。绑定后画像合并到人物级。", {
        type: "object",
        additionalProperties: false,
        required: ["account"],
        properties: {
            account: { type: "string", description: "账号 ID 或可唯一定位的显示名。" },
            person_id: { type: "string" },
            name: { type: "string", description: "人物名；不传则用账号显示名。" },
            confidence: { type: "string", enum: ["confirmed", "tentative"] },
        },
    }, (args, ctx) => {
        if (ctx.senderIsOwner !== true)
            throw new Error("只有 owner 可以绑定人物。");
        const service = toolService(runtime, ctx);
        const account = resolveAccountRef(service, stringArg(args, "account") ?? "");
        const result = service.bind({
            accountId: account.account_id,
            personId: stringArg(args, "person_id"),
            name: stringArg(args, "name"),
            confidence: stringArg(args, "confidence"),
        });
        return textResult(`已绑定 ${account.account_id} → ${result.personId}${result.createdPerson ? "（新建人物）" : ""}；迁移印象 ${result.moved.impressions} 条、特征 ${result.moved.traits} 个。`);
    });
    register("people_forget", "删除匹配到的印象或特征。默认只能操作自己；owner 可指定账号；purge 仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        required: ["match"],
        properties: {
            match: { type: "string", description: "要删除的内容片段。" },
            account: { type: "string" },
            person: { type: "string", description: "目标人物 ID（p_ 开头）。仅 owner 或内部维护任务可用。" },
            scope: {
                type: "string",
                enum: ["all", "impressions", "traits"],
                description: "删除范围，默认 all。画像归并后用 impressions，避免误删 traits。",
            },
            purge: {
                type: "boolean",
                description: "彻底清除：同时删除备份和旧 JSON 归档中的历史数据。不可恢复，默认关闭。",
            },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx);
        const match = stringArg(args, "match");
        if (!match)
            throw new Error("match 不能为空。");
        const scopeRaw = stringArg(args, "scope");
        const scope = scopeRaw === "impressions" || scopeRaw === "traits" ? scopeRaw : "all";
        const purge = boolArg(args, "purge") === true;
        if (purge && !canManage(ctx, runtime.config)) {
            throw new Error("彻底清除（purge）仅限 owner 或内部维护任务。");
        }
        const personId = stringArg(args, "person");
        if (personId) {
            if (!canManage(ctx, runtime.config))
                throw new Error("只有 owner 或内部维护任务可以整理人物级画像。");
            const person = service.db.getPerson(personId);
            if (!person)
                throw new Error(`没有找到人物：${personId}`);
            const result = service.forget({ personId: person.person_id, match, scope, purge });
            return textResult(forgetResultText(result));
        }
        const self = currentAccount(ctx, runtime, service);
        const accountRef = stringArg(args, "account");
        const target = accountRef ? resolveAccountRef(service, accountRef) : self;
        if (!target)
            throw new Error("当前消息没有可识别的发送者，请用 account 指定目标。");
        if (!canManage(ctx, runtime.config) && target.account_id !== self?.account_id) {
            throw new Error("只能删除自己的信息。");
        }
        const result = service.forget({ accountId: target.account_id, match, scope, purge });
        return textResult(forgetResultText(result));
    });
    register("people_validate", "校验当前工作区识人库的一致性。owner 可选择自动修复可修复项。", {
        type: "object",
        additionalProperties: false,
        properties: {
            fix: { type: "boolean" },
            workspace: { type: "string" },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx, stringArg(args, "workspace"));
        const fix = boolArg(args, "fix") === true;
        if (fix && !writeToolsEnabled(runtime.config))
            throw new Error("写入工具已关闭（writeTools=false），无法自动修复。");
        if (fix && !canManage(ctx, runtime.config))
            throw new Error("只有 owner 或本工作区的维护任务可以自动修复。");
        const actions = fix ? service.repair() : [];
        const report = service.validate();
        const text = formatValidation(report);
        return textResult(actions.length > 0 ? `${text}\n\n修复：${actions.join("；")}` : text);
    });
    register("people_scan_mark", "记录某个会话/频道的扫描进度；full=true 时同时更新全量扫描时间。仅 owner 或内部维护任务可用。", {
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
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("记录扫描进度仅限 owner 或内部维护任务。");
        const service = toolService(runtime, ctx);
        const channel = stringArg(args, "channel");
        if (!channel)
            throw new Error("channel 不能为空。");
        const lastScanAt = stringArg(args, "lastScanAt") ?? nowIso();
        service.db.upsertScanChannel({
            channelKey: channel,
            displayName: stringArg(args, "displayName"),
            kind: stringArg(args, "kind"),
            platform: stringArg(args, "platform"),
            groupId: stringArg(args, "group"),
            lastScanAt,
        });
        if (boolArg(args, "full") === true)
            service.db.setScanMeta(lastScanAt);
        return textResult(`已记录扫描进度：${channel} @ ${lastScanAt}`);
    });
    register("people_bootstrap", "初始化当前工作区的识人库，并导入旧 JSON（如果存在）。可重复执行。仅 owner 或内部维护任务可用。", { type: "object", additionalProperties: false, properties: { workspace: { type: "string" } } }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("初始化识人库仅限 owner 或内部维护任务。");
        const workspace = stringArg(args, "workspace");
        if (workspace && workspace !== ctx.workspaceDir && ctx.senderIsOwner !== true) {
            throw new Error("只有 owner 可以初始化其他工作区。");
        }
        const service = toolService(runtime, ctx, workspace);
        return textResult(`${formatStatus(service)}\n初始化完成。`);
    });
    register("people_backup", "为当前工作区创建一致的 SQLite 与 JSON 备份，并清理超出保留数量的旧备份。仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        properties: {
            keep: { type: "number", description: "保留最近多少份备份，默认 14，最少 2。" },
            workspace: { type: "string", description: "目标工作区；默认当前工作区。" },
        },
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("备份识人库仅限 owner 或内部维护任务。");
        const workspace = stringArg(args, "workspace");
        const service = toolService(runtime, ctx, workspace);
        const keepRaw = typeof args.keep === "number" ? args.keep : 14;
        const report = service.backup(keepRaw);
        return textResult([
            "备份完成。",
            `SQLite：${report.dbBackup}（${report.dbBytes} bytes）`,
            `JSON：${report.jsonBackup}（${report.jsonBytes} bytes）`,
            `保留 ${report.kept} 份${report.removedOld ? `，清理旧文件 ${report.removedOld} 个` : ""}。`,
        ].join("\n"));
    });
    register("people_health", "检查当前工作区识人库的维护风险：校验错误、孤儿记录、重复人物、过密画像、缺备份等。只读，仅 owner 或内部维护任务可用。", { type: "object", additionalProperties: false, properties: { workspace: { type: "string" } } }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("健康检查仅限 owner 或内部维护任务。");
        const service = toolService(runtime, ctx, stringArg(args, "workspace"));
        const report = service.health();
        const lines = [
            `${report.ok ? "✅" : "❌"} 识人库健康检查`,
            `数据库：${report.dbPath}`,
            `最近备份：${report.lastBackupAt ?? "无"}`,
            `计数：${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join("  ")}`,
        ];
        if (report.issues.length === 0)
            lines.push("没有发现需要处理的问题。");
        else {
            for (const issue of report.issues.slice(0, 50)) {
                lines.push(`· [${issue.level}] ${issue.code}: ${issue.message}`);
            }
            if (report.issues.length > 50)
                lines.push(`… 另有 ${report.issues.length - 50} 条`);
        }
        return textResult(lines.join("\n"));
    });
    register("people_cycle", "执行一次插件化维护周期：按需备份、自动修复安全项、健康检查，并返回后续需要 agent 处理的归并/合并计划。", {
        type: "object",
        additionalProperties: false,
        properties: {
            workspace: { type: "string" },
            backup_keep: { type: "number" },
            backup_interval_hours: { type: "number" },
            force_backup: { type: "boolean" },
        },
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("维护周期仅限 owner 或内部维护任务。");
        const workspace = stringArg(args, "workspace");
        const service = toolService(runtime, ctx, workspace);
        const report = service.cycle({
            backupKeep: typeof args.backup_keep === "number" ? args.backup_keep : 14,
            backupIntervalHours: typeof args.backup_interval_hours === "number" ? args.backup_interval_hours : 20,
            forceBackup: boolArg(args, "force_backup") === true,
        });
        const lines = [
            "识人维护周期",
            `数据库：${report.health.dbPath}`,
            report.backup
                ? `备份：${report.backup.dbBackup}（${report.backup.dbBytes} bytes）`
                : `备份：跳过${report.backupSkipped ? "（距离上次备份不足设定间隔）" : ""}`,
            `修复：${report.repairActions.length ? report.repairActions.join("；") : "无"}`,
            `健康：${report.health.ok ? "ok" : "有 error"}，待处理 ${report.actions.length} 项`,
        ];
        for (const action of report.actions) {
            lines.push(`· [${action.kind}] ${action.ownerType ? `${action.ownerType}:` : ""}${action.target}：${action.message}`);
        }
        if (report.actions.length === 0)
            lines.push("没有需要 agent 继续处理的画像任务。");
        return textResult(lines.join("\n"));
    });
    register("people_search", "在当前工作区搜索账号、人物、印象和群事件。仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
            query: { type: "string" },
            limit: { type: "number" },
        },
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("搜索全局记忆仅限 owner 或内部维护任务。");
        const service = toolService(runtime, ctx);
        const report = service.search(stringArg(args, "query") ?? "", typeof args.limit === "number" ? args.limit : 10);
        const lines = [`搜索：${stringArg(args, "query")}`];
        if (report.accounts.length) {
            lines.push("", "账号");
            for (const account of report.accounts) {
                lines.push(`· ${account.account_id}（${account.call_name || account.confirmed_name || account.display_name || "未命名"}）`);
            }
        }
        if (report.persons.length) {
            lines.push("", "人物");
            for (const person of report.persons) {
                lines.push(`· ${person.person_id}（${person.call_name || person.name || "未命名"}）`);
            }
        }
        if (report.impressions.length) {
            lines.push("", "印象");
            for (const impression of report.impressions) {
                lines.push(`· ${impression.owner_id}：${impression.content}`);
            }
        }
        if (report.groupEvents.length) {
            lines.push("", "群事件");
            for (const event of report.groupEvents) {
                lines.push(`· ${event.group_id} ${event.occurred_at.slice(0, 10)}：${event.summary}`);
            }
        }
        if (lines.length === 1)
            lines.push("没有找到匹配记录。");
        return textResult(lines.join("\n"));
    });
    register("people_dimension", "查看、添加或启停画像特征维度。添加和启停仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        properties: {
            action: { type: "string", enum: ["list", "add", "enable", "disable"] },
            key: { type: "string" },
            label: { type: "string" },
            sort: { type: "number" },
        },
    }, (args, ctx) => {
        const service = toolService(runtime, ctx);
        const action = stringArg(args, "action") ?? "list";
        if (action === "list") {
            return textResult(service.db
                .listDimensions()
                .map((dimension) => `${dimension.key} · ${dimension.label} · ${dimension.active ? "启用" : "停用"} · sort=${dimension.sort}`)
                .join("\n"));
        }
        if (!canManage(ctx, runtime.config))
            throw new Error("修改维度仅限 owner 或内部维护任务。");
        if (!writeToolsEnabled(runtime.config))
            throw new Error("写入工具已关闭（writeTools=false），无法修改维度。");
        const key = stringArg(args, "key");
        if (!key)
            throw new Error("key 不能为空。");
        const existing = service.db.getDimension(key);
        const active = action !== "disable";
        const dimension = service.upsertDimension(key, stringArg(args, "label") ?? existing?.label ?? key, active, typeof args.sort === "number" ? args.sort : existing?.sort ?? 999);
        return textResult(`已更新维度 ${dimension.key}：${dimension.label}，${dimension.active ? "启用" : "停用"}。`);
    });
    register("people_merge", "合并两个人物记录到一个目标人物。用于清理重复人物；需要 confirm=true。仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
            source: { type: "string", description: "被合并的 person_id" },
            target: { type: "string", description: "保留的 person_id" },
            confirm: { type: "boolean" },
        },
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("合并人物仅限 owner 或内部维护任务。");
        if (boolArg(args, "confirm") !== true)
            throw new Error("合并人物需要 confirm=true。");
        const service = toolService(runtime, ctx);
        const source = stringArg(args, "source");
        const target = stringArg(args, "target");
        if (!source || !target)
            throw new Error("source 和 target 不能为空。");
        const result = service.mergePersons(source, target);
        return textResult(`已合并 ${source} → ${target}：迁移账号 ${result.accounts}、印象 ${result.impressions}、特征 ${result.traits}。`);
    });
    register("people_unbind", "解除账号与人物绑定，默认把人物画像复制回账号，避免解绑即丢画像。需要 confirm=true。仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        required: ["account"],
        properties: {
            account: { type: "string" },
            copy_profile: { type: "boolean", description: "默认 true。" },
            confirm: { type: "boolean" },
        },
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("解绑人物仅限 owner 或内部维护任务。");
        if (boolArg(args, "confirm") !== true)
            throw new Error("解绑人物需要 confirm=true。");
        const service = toolService(runtime, ctx);
        const account = resolveAccountRef(service, stringArg(args, "account") ?? "");
        const result = service.unbind(account.account_id, boolArg(args, "copy_profile") !== false);
        return textResult(`已解除 ${account.account_id} 的人物绑定；复制印象 ${result.impressionsCopied} 条、特征 ${result.traitsCopied} 个。`);
    });
    register("people_merge_account", "把同一人物的平台双份账号归并到一个账号（例如 bncr:x 并入 bncr/tgBot:x）。迁移印象/特征/群成员，必要时迁移人物绑定。需要 confirm=true。仅 owner 或内部维护任务可用。", {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
            source: { type: "string", description: "被归并的账号 ID 或显示名" },
            target: { type: "string", description: "保留的账号 ID 或显示名" },
            confirm: { type: "boolean" },
        },
    }, (args, ctx) => {
        if (!canManage(ctx, runtime.config))
            throw new Error("账号归并仅限 owner 或内部维护任务。");
        if (boolArg(args, "confirm") !== true)
            throw new Error("账号归并需要 confirm=true。");
        const service = toolService(runtime, ctx);
        const source = resolveAccountRef(service, stringArg(args, "source") ?? "");
        const target = resolveAccountRef(service, stringArg(args, "target") ?? "");
        const result = service.mergeAccounts(source.account_id, target.account_id);
        return textResult(`已归并 ${source.account_id} → ${target.account_id}：印象 ${result.impressions}、特征 ${result.traits}、群成员 ${result.groupMembers}${result.bindingMoved ? "，并迁移了人物绑定" : ""}。`);
    });
}
export { textResult, currentPlatform };
