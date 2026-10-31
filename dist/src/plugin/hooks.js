import { isAgentDisabled } from "./config.js";
import { hookChatId, hookChatTitle, hookIsGroup, hookPlatform, hookSenderName, inboundGroupTitle, inboundPlatform, } from "./identity.js";
const CAPTURE_INTERVAL_MS = 30_000;
export function registerHooks(api, runtime) {
    const lastCapture = new Map();
    const pendingIdentity = new Map();
    api.on("inbound_claim", ((event) => {
        try {
            const senderId = event.senderId?.trim();
            if (!senderId)
                return undefined;
            const platform = inboundPlatform(event, runtime.config);
            const at = Date.now();
            const entry = {
                senderName: event.senderName?.trim() || undefined,
                chatTitle: inboundGroupTitle(event),
                isGroup: event.isGroup === true,
                at,
            };
            pendingIdentity.set(`${platform}:${senderId}`, entry);
            if (event.sessionKey)
                pendingIdentity.set(`session:${event.sessionKey}`, entry);
            if (pendingIdentity.size > 500) {
                for (const [key, value] of pendingIdentity) {
                    if (at - value.at > 10 * 60_000)
                        pendingIdentity.delete(key);
                }
            }
        }
        catch {
            // passive observer only
        }
        return undefined;
    }));
    api.on("before_prompt_build", ((event, ctx) => {
        try {
            if (isAgentDisabled(runtime.config, ctx.agentId))
                return undefined;
            const senderId = ctx.senderId?.trim();
            if (!senderId)
                return undefined;
            const service = runtime.get({
                workspaceDir: ctx.workspaceDir,
                agentId: ctx.agentId,
                agentDir: undefined,
            });
            const platform = hookPlatform(ctx, runtime.config);
            const chatId = hookChatId(ctx);
            const pending = pendingIdentity.get(`${platform}:${senderId}`) ??
                (ctx.sessionKey ? pendingIdentity.get(`session:${ctx.sessionKey}`) : undefined);
            const chatTitle = hookChatTitle(ctx) ?? pending?.chatTitle;
            const isGroup = hookIsGroup(ctx) || pending?.isGroup === true;
            let groupId;
            if (runtime.config.capture !== false) {
                const captureKey = `${service.paths.workspaceKey}|${platform}|${senderId}`;
                const now = Date.now();
                const previous = lastCapture.get(captureKey) ?? 0;
                if (now - previous >= CAPTURE_INTERVAL_MS) {
                    lastCapture.set(captureKey, now);
                    const result = service.capture({
                        platform,
                        senderId,
                        senderName: hookSenderName(ctx) ?? pending?.senderName,
                        chatId,
                        chatTitle,
                        isGroup,
                        agentId: ctx.agentId,
                    });
                    groupId = result.groupId;
                }
            }
            if (runtime.config.injectContext === false)
                return undefined;
            if (!groupId && chatId) {
                groupId = service.db.findGroup(platform, chatId)?.group_id;
            }
            const accountId = service.resolveAccountForLookup(platform, senderId)?.account_id;
            if (!accountId)
                return undefined;
            const card = service.contextCard({
                accountId,
                groupId,
                maxChars: runtime.config.injectMaxChars,
                includeGroupMemory: runtime.config.injectGroupMemory !== false,
            });
            if (!card)
                return undefined;
            if (runtime.config.debug) {
                runtime.api.logger.info(`[people] inject ${accountId} bytes=${card.length} promptBytes=${event.prompt.length}`);
            }
            return { prependContext: card };
        }
        catch (error) {
            runtime.api.logger.warn(`[people] before_prompt_build failed: ${error.message}`);
            return undefined;
        }
    }), { timeoutMs: 3000 });
    api.on("gateway_stop", () => {
        runtime.closeAll();
    });
}
