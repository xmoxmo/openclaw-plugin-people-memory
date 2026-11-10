const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const MAX_PENDING = 500;
const MAX_TOOL_CALLS = 2_000;
function workspaceBindingKey(kind, value) {
    return `${kind}:${value}`;
}
/**
 * One turn's inbound identity metadata, keyed by session/run/sender.
 * Every entry belongs to exactly one workspace key. Entries without a key are
 * never admitted: cross-workspace identity reuse would break data isolation.
 * Tool-call owner receipts are separate, one-per-call state: the host supplies
 * requester.senderIsOwner to before_tool_call and the matching execute
 * consumes the exact toolCallId. Inbound identity never grants owner authority.
 */
export class IdentityStore {
    toolCallReceipts = new Map();
    values = new Map();
    workspaceKeys = new Map();
    pending = new Map();
    pendingByIdentity = new Map();
    now;
    constructor(now = Date.now) {
        this.now = now;
    }
    static keys(identity, prefix) {
        const keys = [
            identity.sessionKey ? prefix + workspaceBindingKey("session", identity.sessionKey) : "",
            identity.runId ? prefix + workspaceBindingKey("run", identity.runId) : "",
        ].filter(Boolean);
        // Sender fallback exists only for hosts that provide neither identity
        // scope. Otherwise two parallel runs with the same sender could evict
        // each other's exact run binding.
        if (!identity.sessionKey && !identity.runId && identity.senderId) {
            keys.push(prefix + "sender:" + identity.channel + ":" + identity.platform + ":" + identity.senderId);
        }
        return keys;
    }
    store(identity, scope) {
        const now = this.now();
        if (this.values.size > MAX_ENTRIES) {
            for (const [key, value] of this.values)
                if (now - value.at > TTL_MS)
                    this.values.delete(key);
            if (this.values.size > MAX_ENTRIES) {
                const oldest = [...this.values.entries()].sort((left, right) => left[1].at - right[1].at);
                for (const [key] of oldest.slice(0, this.values.size - MAX_ENTRIES))
                    this.values.delete(key);
            }
        }
        const scoped = { ...identity, workspaceKey: scope };
        if (scoped.sessionKey) {
            this.workspaceKeys.set(workspaceBindingKey("session", scoped.sessionKey), { workspaceKey: scope, at: now });
        }
        if (scoped.runId) {
            this.workspaceKeys.set(workspaceBindingKey("run", scoped.runId), { workspaceKey: scope, at: now });
        }
        this.trimWorkspaceKeys(now);
        for (const key of IdentityStore.keys(scoped, scope + "|"))
            this.values.set(key, scoped);
    }
    /** Bind observed session/run scopes to their prompt-hook workspace when they arrive later. */
    registerWorkspace(sessionKey, workspaceKey, runId) {
        if ((!sessionKey && !runId) || !workspaceKey)
            return;
        const now = this.now();
        if (sessionKey) {
            this.workspaceKeys.set(workspaceBindingKey("session", sessionKey), { workspaceKey, at: now });
        }
        if (runId) {
            this.workspaceKeys.set(workspaceBindingKey("run", runId), { workspaceKey, at: now });
        }
        this.trimWorkspaceKeys(now);
        const pending = new Set();
        for (const key of [
            sessionKey ? workspaceBindingKey("session", sessionKey) : "",
            runId ? workspaceBindingKey("run", runId) : "",
        ].filter(Boolean)) {
            const identity = this.pending.get(key);
            if (identity)
                pending.add(identity);
        }
        for (const identity of pending) {
            if (this.now() - identity.at > TTL_MS) {
                this.dropPending(identity);
                continue;
            }
            this.store(identity, workspaceKey);
            this.dropPending(identity);
        }
    }
    put(identity) {
        const scope = identity.workspaceKey?.trim();
        const now = this.now();
        if (scope) {
            this.store(identity, scope);
            return;
        }
        const candidates = [
            identity.sessionKey
                ? this.workspaceKeys.get(workspaceBindingKey("session", identity.sessionKey))
                : undefined,
            identity.runId ? this.workspaceKeys.get(workspaceBindingKey("run", identity.runId)) : undefined,
        ].filter((value) => Boolean(value));
        const activeWorkspaces = new Set(candidates
            .filter((value) => now - value.at <= TTL_MS)
            .map((value) => value.workspaceKey));
        if (activeWorkspaces.size > 1)
            return;
        const bound = activeWorkspaces.values().next().value;
        if (bound) {
            this.store(identity, bound);
            return;
        }
        for (const value of new Set(this.pending.values())) {
            if (now - value.at > TTL_MS)
                this.dropPending(value);
        }
        const keys = IdentityStore.keys(identity, "");
        for (const key of keys) {
            const previous = this.pending.get(key);
            if (previous && previous !== identity)
                this.dropPending(previous);
        }
        this.pendingByIdentity.set(identity, new Set(keys));
        for (const key of keys)
            this.pending.set(key, identity);
        if (this.pendingByIdentity.size > MAX_PENDING) {
            const oldest = [...this.pendingByIdentity.keys()].sort((left, right) => left.at - right.at);
            for (const expired of oldest.slice(0, this.pendingByIdentity.size - MAX_PENDING)) {
                this.dropPending(expired);
            }
        }
    }
    dropPending(identity) {
        for (const key of this.pendingByIdentity.get(identity) ?? [])
            this.pending.delete(key);
        this.pendingByIdentity.delete(identity);
    }
    trimWorkspaceKeys(now) {
        if (this.workspaceKeys.size <= MAX_ENTRIES)
            return;
        for (const [key, value] of this.workspaceKeys) {
            if (now - value.at > TTL_MS)
                this.workspaceKeys.delete(key);
        }
        if (this.workspaceKeys.size <= MAX_ENTRIES)
            return;
        const oldest = [...this.workspaceKeys.entries()].sort((left, right) => left[1].at - right[1].at);
        for (const [key] of oldest.slice(0, this.workspaceKeys.size - MAX_ENTRIES)) {
            this.workspaceKeys.delete(key);
        }
    }
    /** True when a scoped inbound identity has already resolved a backend. */
    hasBackend(workspaceKey, sessionKey, runId) {
        const scope = workspaceKey.trim();
        if (!scope)
            return false;
        const prefix = scope + "|";
        const keys = [
            runId ? prefix + "run:" + runId : "",
            sessionKey ? prefix + "session:" + sessionKey : "",
        ].filter(Boolean);
        return keys.some((key) => {
            const value = this.values.get(key);
            return Boolean(value?.backend && this.now() - value.at <= TTL_MS);
        });
    }
    get(workspaceKey, sessionKey, runId, channel, senderId, chatId) {
        const scope = workspaceKey?.trim();
        if (!scope)
            return undefined;
        const now = this.now();
        const boundWorkspaces = [
            sessionKey
                ? this.workspaceKeys.get(workspaceBindingKey("session", sessionKey))
                : undefined,
            runId ? this.workspaceKeys.get(workspaceBindingKey("run", runId)) : undefined,
        ].filter((value) => Boolean(value && now - value.at <= TTL_MS));
        if (boundWorkspaces.some((value) => value.workspaceKey !== scope))
            return undefined;
        const prefix = scope + "|";
        // A scoped lookup must stay inside the exact run/session. Falling back to
        // the sender cache could apply identity from group A while serving group B.
        const scopedKeys = [
            runId ? prefix + "run:" + runId : "",
            sessionKey ? prefix + "session:" + sessionKey : "",
        ].filter(Boolean);
        if (scopedKeys.length > 0) {
            for (const key of scopedKeys) {
                const value = this.values.get(key);
                if (!value)
                    continue;
                if (now - value.at > TTL_MS) {
                    this.values.delete(key);
                    continue;
                }
                return value;
            }
            return undefined;
        }
        // A host may omit run/session ids. In that case only an exact
        // workspace+channel+sender+chat tuple is eligible, and only when it names
        // exactly one identity space. A sender id or chat id alone is never enough.
        const normalizedChannel = channel?.trim().toLowerCase();
        const normalizedSender = senderId?.trim();
        const normalizedChat = chatId?.trim();
        if (!normalizedChannel || !normalizedSender || !normalizedChat)
            return undefined;
        const candidates = [...new Set(this.values.values())].filter((value) => value.workspaceKey === scope &&
            value.channel.trim().toLowerCase() === normalizedChannel &&
            value.senderId?.trim() === normalizedSender &&
            value.chatId?.trim() === normalizedChat &&
            now - value.at <= TTL_MS);
        return candidates.length === 1 ? candidates[0] : undefined;
    }
    clear() {
        this.toolCallReceipts.clear();
        this.values.clear();
        this.workspaceKeys.clear();
        this.pending.clear();
        this.pendingByIdentity.clear();
    }
    /** Admit one host-authoritative owner bit for exactly one tool call. */
    admitToolCallOwner(toolCallId, senderIsOwner) {
        if (!toolCallId)
            return;
        this.toolCallReceipts.set(toolCallId, { owner: senderIsOwner === true, at: this.now() });
        if (this.toolCallReceipts.size > MAX_TOOL_CALLS) {
            const oldest = [...this.toolCallReceipts.entries()].sort((left, right) => left[1].at - right[1].at);
            for (const [key] of oldest.slice(0, this.toolCallReceipts.size - MAX_TOOL_CALLS)) {
                this.toolCallReceipts.delete(key);
            }
        }
    }
    /** Read and delete the exact receipt; a missing receipt is not an owner. */
    consumeToolCallOwner(toolCallId) {
        if (!toolCallId)
            return false;
        const owner = this.toolCallReceipts.get(toolCallId)?.owner === true;
        this.toolCallReceipts.delete(toolCallId);
        return owner;
    }
    /** Clean up a receipt for a tool call that never reached execute. */
    discardToolCall(toolCallId) {
        if (toolCallId)
            this.toolCallReceipts.delete(toolCallId);
    }
    /** Observable count for lifecycle regression tests; never persisted. */
    get pendingToolCalls() {
        return this.toolCallReceipts.size;
    }
    /** Observable count for long-lived session-binding resource tests. */
    get workspaceBindingCount() {
        return this.workspaceKeys.size;
    }
}
