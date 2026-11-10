import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveWorkspaceRoot } from "../core/paths.js";
import { isAgentDisabled } from "./config.js";
import { PEOPLE_TOOL_NAMES, isPeopleToolName } from "./tool-names.js";
import {
  hookChatId,
  resolveHookIdentity,
  resolveInboundIdentity,
  type HookCtx,
  type InboundIdentityContext,
  type InboundIdentityEvent,
} from "./identity.js";
import type { IdentityStore } from "./identity-store.js";
import type { PeopleRuntime } from "./runtime.js";

const CAPTURE_INTERVAL_MS = 30_000;
const DEFERRED_INTERVAL_MS = 5 * 60_000;
const THROTTLE_MAX_ENTRIES = 500;

/** Bound long-lived throttle state while preserving each active interval. */
function takeThrottleSlot(
  store: Map<string, number>,
  key: string,
  now: number,
  intervalMs: number,
): boolean {
  const previous = store.get(key) ?? 0;
  if (now - previous < intervalMs) return false;
  store.set(key, now);
  if (store.size <= THROTTLE_MAX_ENTRIES) return true;
  for (const [entry, at] of store) {
    if (now - at >= intervalMs * 2) store.delete(entry);
  }
  if (store.size > THROTTLE_MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((left, right) => left[1] - right[1]);
    for (const [entry] of oldest.slice(0, store.size - THROTTLE_MAX_ENTRIES)) store.delete(entry);
  }
  return true;
}

export function registerHooks(
  api: OpenClawPluginApi,
  runtime: PeopleRuntime,
  identities: IdentityStore = runtime.identities,
): void {
  const lastCapture = new Map<string, number>();
  const lastDeferred = new Map<string, number>();
  const logger = runtime.api.logger;
  const toolMatcher = PEOPLE_TOOL_NAMES as unknown as [string, ...string[]];

  type ToolCallEvent = {
    toolName: string;
    params?: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    /** Present on host versions that expose the trusted requester bit here too. */
    senderIsOwner?: boolean;
  };
  type ToolCallContext = {
    toolName: string;
    toolCallId?: string;
    runId?: string;
    requester?: { senderIsOwner?: boolean; senderId?: string };
  };

  const observe = (event: InboundIdentityEvent, context?: InboundIdentityContext): void => {
    if (isAgentDisabled(runtime.config, context?.agentId ?? event.agentId)) return;
    const workspaceDir =
      context?.workspaceDir?.trim() ||
      resolveWorkspaceRoot(
        runtime.api.config as Parameters<typeof resolveWorkspaceRoot>[0],
        context?.agentId ?? event.agentId,
      );
    const workspaceKey = workspaceDir
      ? runtime.resolveWorkspacePaths(
          { workspaceDir, agentId: context?.agentId ?? event.agentId },
          workspaceDir,
        ).workspaceKey
      : undefined;
    // Inbound owner metadata is never cached. Tool authority comes only from
    // the host's current tool execution context or exact before_tool_call receipt.
    const identity = resolveInboundIdentity(
      { ...event, senderIsOwner: undefined },
      runtime.config,
      context,
      workspaceKey,
    );
    if (identity) identities.put(identity);
  };

  api.on("inbound_claim", ((event: InboundIdentityEvent, context: InboundIdentityContext) => {
    try {
      observe(event, context);
    } catch {
      logger.warn("[people] inbound_claim observation failed");
    }
    return undefined;
  }) as never);

  api.on("message_received", ((event: InboundIdentityEvent, context: InboundIdentityContext) => {
    // Message observation never grants owner authority. The tool execution
    // context and exact before_tool_call receipt carry the host-owned bit.
    try {
      observe(event, context);
    } catch {
      logger.warn("[people] message_received observation failed");
    }
    return undefined;
  }) as never);

  api.on(
    "before_tool_call",
    ((event: ToolCallEvent, ctx: ToolCallContext) => {
      const name = event.toolName ?? ctx.toolName;
      if (!isPeopleToolName(name)) return undefined;
      identities.admitToolCallOwner(
        event.toolCallId ?? ctx.toolCallId,
        event.senderIsOwner ?? ctx.requester?.senderIsOwner,
      );
      return undefined;
    }) as never,
    { matcher: toolMatcher },
  );

  api.on(
    "after_tool_call",
    ((event: ToolCallEvent, ctx: ToolCallContext) => {
      const name = event.toolName ?? ctx.toolName;
      if (isPeopleToolName(name)) identities.discardToolCall(event.toolCallId ?? ctx.toolCallId);
    }) as never,
    { matcher: toolMatcher },
  );

  api.on(
    "before_prompt_build",
    ((_event: { prompt: string }, ctx: HookCtx) => {
      try {
        if (isAgentDisabled(runtime.config, ctx.agentId)) return undefined;
        const service = runtime.get({ workspaceDir: ctx.workspaceDir, agentId: ctx.agentId });
        const workspaceKey = service.paths.workspaceKey;
        identities.registerWorkspace(ctx.sessionKey, workspaceKey, ctx.runId);
        const hasInboundBackend = identities.hasBackend(workspaceKey, ctx.sessionKey, ctx.runId);
        const pending = identities.get(
          workspaceKey,
          ctx.sessionKey,
          ctx.runId,
          ctx.channel ?? ctx.messageProvider,
          ctx.senderId,
          hookChatId(ctx),
        );
        const identity = resolveHookIdentity(
          ctx,
          runtime.config,
          pending,
          workspaceKey,
          hasInboundBackend ? undefined : ctx.sessionKey,
        );
        const senderId = identity?.senderId?.trim();
        if (!identity || !senderId) return undefined;
        const now = Date.now();

        if (identity.source === "deferred") {
          const key = workspaceKey + "|" + ctx.sessionKey + "|" + senderId;
          if (
            runtime.config.capture !== false &&
            takeThrottleSlot(lastDeferred, key, now, DEFERRED_INTERVAL_MS)
          ) {
            service.capture({
              platform: identity.platform,
              senderId,
              agentId: ctx.agentId,
              source: "deferred",
            });
          }
          return undefined;
        }

        if (identity.source === "session_fallback" && pending?.source !== "session_fallback") {
          logger.warn("[people] BNCR backend required sessionKey fallback; standard inbound metadata was unavailable");
        }

        const platform = identity.platform;
        const chatId = identity.chatId;
        let groupId: string | undefined;
        if (runtime.config.capture !== false) {
          // The same sender can trigger replies in different groups in quick
          // succession. Account refresh is idempotent; grouping the throttle
          // by chat prevents the second group and its membership from vanishing.
          const captureKey = [
            workspaceKey,
            platform,
            senderId,
            identity.isGroup === true ? "group" : "direct",
            chatId?.trim() || "none",
          ].join("|");
          if (takeThrottleSlot(lastCapture, captureKey, now, CAPTURE_INTERVAL_MS)) {
            const result = service.capture({
              platform,
              senderId,
              senderName: identity.senderName,
              chatId,
              chatTitle: identity.chatTitle,
              isGroup: identity.isGroup === true,
              agentId: ctx.agentId,
              source: identity.source,
            });
            groupId = result.groupId;
          }
        }

        if (runtime.config.injectContext === false) return undefined;
        if (identity.isGroup === true && !groupId && chatId) {
          groupId = service.db.findGroup(platform, chatId)?.group_id;
        }
        const accountId = service.db.getAccountByPlatformSender(platform, senderId)?.account_id;
        if (!accountId) return undefined;
        const card = service.contextCard({
          accountId,
          groupId,
          maxChars: runtime.config.injectMaxChars,
          includeGroupMemory: runtime.config.injectGroupMemory !== false,
        });
        if (!card) return undefined;
        if (runtime.config.debug) logger.info("[people] injected context bytes=" + card.length);
        return { prependContext: card };
      } catch (error) {
        logger.warn(
          runtime.config.debug
            ? "[people] before_prompt_build failed: " + (error as Error).message
            : "[people] before_prompt_build failed",
        );
        return undefined;
      }
    }) as never,
    { timeoutMs: 3000 },
  );

  api.on("gateway_stop", () => {
    identities.clear();
    runtime.closeAll();
  });
}
