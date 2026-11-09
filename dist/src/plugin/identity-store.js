import { claimOwnerForTurn, clearOwnerClaims, consumeOwnerClaim, createOwnerClaimStore, ownerClaimKey, resetOwnerClaim, } from "./authz.js";
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
/**
 * One turn's inbound identity metadata, keyed by session/run/sender.
 * Every entry belongs to exactly one workspace key. Entries without a key are
 * never admitted: cross-workspace identity reuse would break data isolation.
 * A host-trusted owner bit creates one workspace/session/sender claim that the
 * next tool invocation consumes. Identity resolution never treats it as a
 * fallback or a cache; a new host-trusted inbound event can create a new claim.
 */
export class IdentityStore {
    ownerClaims = createOwnerClaimStore();
    values = new Map();
    workspaceKeys = new Map();
    pending = new Map();
    pendingByIdentity = new Map();
    static keys(identity, prefix) {
        return [
            identity.sessionKey ? prefix + "session:" + identity.sessionKey : "",
            identity.runId ? prefix + "run:" + identity.runId : "",
            identity.senderId ? prefix + "sender:" + identity.channel + ":" + identity.senderId : "",
        ].filter(Boolean);
    }
    store(identity, scope) {
        const now = Date.now();
        if (this.values.size > MAX_ENTRIES) {
            for (const [key, value] of this.values)
                if (now - value.at > TTL_MS)
                    this.values.delete(key);
        }
        const scoped = { ...identity, workspaceKey: scope };
        if (scoped.sessionKey)
            this.workspaceKeys.set(scoped.sessionKey, scope);
        if (scoped.senderIsOwner === true &&
            scoped.sessionKey &&
            scoped.senderId) {
            resetOwnerClaim(this.ownerClaims, {
                workspaceKey: scope,
                sessionKey: scoped.sessionKey,
                senderId: scoped.senderId,
            });
            claimOwnerForTurn(this.ownerClaims, {
                workspaceKey: scope,
                sessionKey: scoped.sessionKey,
                senderId: scoped.senderId,
            });
        }
        for (const key of IdentityStore.keys(scoped, scope + "|"))
            this.values.set(key, scoped);
    }
    /** Bind an observed session to its prompt-hook workspace when it arrives later. */
    registerWorkspace(sessionKey, workspaceKey) {
        if (!sessionKey || !workspaceKey)
            return;
        this.workspaceKeys.set(sessionKey, workspaceKey);
        const key = "session:" + sessionKey;
        const identity = this.pending.get(key);
        if (!identity)
            return;
        if (Date.now() - identity.at > TTL_MS) {
            this.dropPending(identity);
            return;
        }
        this.store(identity, workspaceKey);
        this.dropPending(identity);
    }
    put(identity) {
        const scope = identity.workspaceKey?.trim();
        const now = Date.now();
        if (scope) {
            this.store(identity, scope);
            return;
        }
        const bound = identity.sessionKey ? this.workspaceKeys.get(identity.sessionKey) : undefined;
        if (bound) {
            this.store(identity, bound);
            return;
        }
        for (const value of new Set(this.pending.values())) {
            if (now - value.at > TTL_MS)
                this.dropPending(value);
        }
        const keys = IdentityStore.keys(identity, "");
        this.pendingByIdentity.set(identity, new Set(keys));
        for (const key of keys)
            this.pending.set(key, identity);
    }
    dropPending(identity) {
        for (const key of this.pendingByIdentity.get(identity) ?? [])
            this.pending.delete(key);
        this.pendingByIdentity.delete(identity);
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
            return Boolean(value?.backend && Date.now() - value.at <= TTL_MS);
        });
    }
    get(workspaceKey, sessionKey, runId, channel, senderId) {
        const scope = workspaceKey?.trim();
        if (!scope || (sessionKey && this.workspaceKeys.get(sessionKey) !== scope))
            return undefined;
        const prefix = scope + "|";
        const keys = IdentityStore.keys({ runId, sessionKey, channel, senderId }, prefix);
        const now = Date.now();
        for (const key of keys) {
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
    clear() {
        clearOwnerClaims(this.ownerClaims);
        this.values.clear();
        this.workspaceKeys.clear();
        this.pending.clear();
        this.pendingByIdentity.clear();
    }
    /** Consume one exact host-trusted owner claim for this workspace/session/sender. */
    consumeOwnerClaim(ctx) {
        return consumeOwnerClaim(this.ownerClaims, ctx);
    }
    /** Observable terminal state of the explicit, single-use claim store. */
    ownerClaimState(ctx) {
        return { pending: this.ownerClaims.claims.has(ownerClaimKey(ctx)) };
    }
}
