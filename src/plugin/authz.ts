import type { PeoplePluginConfig } from "../core/types.js";
export type AuthzContext = {
  agentId?: string;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

export type OwnerClaimContext = {
  workspaceKey: string;
  sessionKey: string;
  senderId: string;
};

export type OwnerClaimStore = {
  claims: Set<string>;
};

export function createOwnerClaimStore(): OwnerClaimStore {
  return { claims: new Set<string>() };
}

export function ownerClaimKey(ctx: OwnerClaimContext): string {
  return [ctx.workspaceKey, ctx.sessionKey, ctx.senderId].join("\u0000");
}

/** Bind a host-trusted inbound owner bit to exactly one workspace/session/sender. */
export function claimOwnerForTurn(store: OwnerClaimStore, ctx: OwnerClaimContext): void {
  store.claims.add(ownerClaimKey(ctx));
}

/** Consume a single-use exact owner claim; no cross-sender inheritance or fallback. */
export function consumeOwnerClaim(store: OwnerClaimStore, ctx: OwnerClaimContext): boolean {
  const key = ownerClaimKey(ctx);
  if (!store.claims.has(key)) return false;
  store.claims.delete(key);
  return true;
}

export function clearOwnerClaims(store: OwnerClaimStore): void {
  store.claims.clear();
}

/** Drop any stale claim before admitting a fresh host-trusted owner event. */
export function resetOwnerClaim(store: OwnerClaimStore, ctx: OwnerClaimContext): void {
  store.claims.delete(ownerClaimKey(ctx));
}

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
  "people_bind",
  "people_forget",
  "people_bootstrap",
  "people_backup",
  "people_cycle",
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

/** Whether a resolved group is the conversation the caller is currently in. */
export function groupMatchesCurrent(
  group: { group_id: string; chat_id: string },
  current: string | undefined | null,
): boolean {
  const value = current?.trim();
  if (!value) return false;
  return (
    group.chat_id === value ||
    group.group_id === value ||
    group.group_id.endsWith(`:${value}`)
  );
}
