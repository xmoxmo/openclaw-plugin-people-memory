import type { PeoplePluginConfig } from "../core/types.js";
import { platformLookupKey } from "../core/platform.js";
import type { ResolvedIdentity } from "./identity.js";
export type AuthzContext = {
  agentId?: string;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

/**
 * Agent tools trust exactly one host-provided owner bit for the current turn.
 * A missing requester sender is an unauthenticated turn, not an admin turn:
 * plugin-owned maintenance never reaches this check through agent tools.
 */
export function canManage(ctx: AuthzContext): boolean {
  return ctx.senderIsOwner === true;
}

/** Write tools default to on; operators can turn them off explicitly. */
export function writeToolsEnabled(config: PeoplePluginConfig): boolean {
  return config.writeTools !== false;
}

/** Tools that mutate persistent data or maintenance content. */
export const WRITE_TOOL_NAMES = new Set([
  "people_remember",
  "people_name",
  "people_note",
  "people_bot_hint",
  "people_bind",
  "people_forget",
  "people_bootstrap",
  "people_backup",
  "people_merge",
  "people_merge_account",
  "people_unbind",
  "people_scan_mark",
]);

/** Agent tools are bound to the workspace of the session agent that admitted the turn. */
export function authorizeWorkspace(
  requested: string | undefined,
  current: string | undefined,
): string | undefined {
  if (!requested) return undefined;
  if (!current?.trim()) throw new Error("无法确认当前会话 agent 的工作区；不接受跨工作区参数。");
  throw new Error("识人工具只使用当前会话 agent 的工作区；请在该工作区的 agent 会话中操作。");
}

/**
 * A group is current only when the complete host-resolved identity space and
 * chat id match. A bare chat id is never enough: the same number in another
 * channel/backend is an independent group.
 */
export function groupMatchesCurrent(
  group: { group_id: string; platform: string; chat_id: string },
  current: ResolvedIdentity | undefined | null,
): boolean {
  const platform = current?.platform?.trim();
  const chatId = current?.chatId?.trim();
  if (
    !platform ||
    !chatId ||
    current?.isGroup !== true ||
    current?.source === "deferred" ||
    (platform.toLowerCase() === "bncr" && !platform.includes("/"))
  ) return false;
  return (
    platformLookupKey(group.platform) === platformLookupKey(platform) &&
    group.chat_id === chatId
  );
}
