import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStorePaths, resolveWorkspaceRoot } from "../core/paths.js";
import { isAgentDisabled } from "./config.js";
import {
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

export function registerHooks(
  api: OpenClawPluginApi,
  runtime: PeopleRuntime,
  identities: IdentityStore = runtime.identities,
): void {
  const lastCapture = new Map<string, number>();
  const lastDeferred = new Map<string, number>();
  const logger = runtime.api.logger;

  const observe = (event: InboundIdentityEvent, context?: InboundIdentityContext): void => {
    const workspaceDir =
      context?.workspaceDir?.trim() ||
      resolveWorkspaceRoot(
        runtime.api.config as Parameters<typeof resolveWorkspaceRoot>[0],
        context?.agentId ?? event.agentId,
      );
    const workspaceKey = workspaceDir
      ? resolveStorePaths({ workspaceDir, config: runtime.config }).workspaceKey
      : undefined;
    const identity = resolveInboundIdentity(event, runtime.config, context, workspaceKey);
    if (identity) identities.put(identity);
  };

  api.on("inbound_claim", ((event: InboundIdentityEvent, context: InboundIdentityContext) => {
    try { observe(event, context); } catch { /* passive observer only */ }
    return undefined;
  }) as never);

  api.on("message_received", ((event: InboundIdentityEvent, context: InboundIdentityContext) => {
    // This host event does not carry senderIsOwner. Only inbound_claim may
    // bind a tool-side owner claim; observing here must never revive one.
    try { observe({ ...event, senderIsOwner: undefined }, context); } catch { /* passive observer only */ }
    return undefined;
  }) as never);

  api.on(
    "before_prompt_build",
    ((event: { prompt: string }, ctx: HookCtx) => {
      try {
        if (isAgentDisabled(runtime.config, ctx.agentId)) return undefined;
        const service = runtime.get({ workspaceDir: ctx.workspaceDir, agentId: ctx.agentId });
        const workspaceKey = service.paths.workspaceKey;
        if (ctx.sessionKey) identities.registerWorkspace(ctx.sessionKey, workspaceKey);
        const hasInboundBackend = identities.hasBackend(workspaceKey, ctx.sessionKey, ctx.runId);
        const pending = identities.get(
          workspaceKey,
          ctx.sessionKey,
          ctx.runId,
          ctx.channel ?? ctx.messageProvider,
          ctx.senderId,
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
          const previous = lastDeferred.get(key) ?? 0;
          if (runtime.config.capture !== false && now - previous >= DEFERRED_INTERVAL_MS) {
            lastDeferred.set(key, now);
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
          const captureKey = workspaceKey + "|" + platform + "|" + senderId;
          const previous = lastCapture.get(captureKey) ?? 0;
          if (now - previous >= CAPTURE_INTERVAL_MS) {
            lastCapture.set(captureKey, now);
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
        if (!groupId && chatId) groupId = service.db.findGroup(platform, chatId)?.group_id;
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
        logger.warn("[people] before_prompt_build failed: " + (error as Error).message);
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
