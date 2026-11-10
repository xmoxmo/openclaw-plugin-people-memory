import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./paths.js";
import { normalizePlatform, platformLookupKey } from "./platform.js";
import { SCHEMA_SQL, SCHEMA_VERSION, DEFAULT_DIMENSIONS } from "./schema.js";
import { nowIso } from "./time.js";
function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function number(value) {
    return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}
export function normalizeContent(value) {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
}
export function contentKey(value) {
    return crypto.createHash("sha256").update(normalizeContent(value)).digest("hex").slice(0, 32);
}
/** Treat a user-provided fragment as text, never as SQL LIKE wildcards. */
function likeContains(value) {
    return `%${value.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
function earlierTimestamp(left, right) {
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
        return leftMs <= rightMs ? left : right;
    }
    return left.localeCompare(right) <= 0 ? left : right;
}
function laterTimestamp(left, right) {
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
        return leftMs >= rightMs ? left : right;
    }
    return left.localeCompare(right) >= 0 ? left : right;
}
const CLASSIFICATION_RANK = new Map([
    ["pending", 0],
    ["unknown", 1],
    ["likely_human", 2],
    ["confirmed_human", 3],
    ["likely_bot", 4],
    ["bot", 5],
]);
const CONFIDENCE_RANK = new Map([
    ["unknown", 0],
    ["tentative", 1],
    ["probable", 2],
    ["likely", 3],
    ["confirmed", 4],
]);
const GROUP_ROLE_RANK = new Map([
    ["unknown", 0],
    ["member", 1],
    ["moderator", 2],
    ["admin", 3],
    ["owner", 4],
]);
function rankOf(value, ranks) {
    return ranks.get((value ?? "").trim().toLowerCase()) ?? 0;
}
/** Pick one coherent classification/confidence observation, never mix their sources. */
function strongerMemberEvidence(current, incoming) {
    const incomingClass = rankOf(incoming.classification, CLASSIFICATION_RANK);
    const currentClass = rankOf(current.classification, CLASSIFICATION_RANK);
    if (incomingClass !== currentClass) {
        return incomingClass > currentClass
            ? { classification: incoming.classification, confidence: incoming.confidence }
            : { classification: current.classification, confidence: current.confidence };
    }
    return rankOf(incoming.confidence, CONFIDENCE_RANK) > rankOf(current.confidence, CONFIDENCE_RANK)
        ? { classification: incoming.classification, confidence: incoming.confidence }
        : { classification: current.classification, confidence: current.confidence };
}
export function newPersonId() {
    return `p_${crypto.randomBytes(4).toString("hex")}`;
}
export function normalizeBotHint(value) {
    const normalized = text(value)?.toLowerCase();
    return normalized === "human" || normalized === "bot" || normalized === "mixed"
        ? normalized
        : "unknown";
}
export function normalizeBotHintSource(value) {
    const normalized = text(value)?.toLowerCase();
    return normalized === "history" || normalized === "group_evidence" || normalized === "manual"
        ? normalized
        : null;
}
export function botHintFromLegacyRole(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "bot" || normalized === "mixed")
        return normalized;
    if (normalized === "human" || normalized === "user")
        return "human";
    return "unknown";
}
function mergeBotHints(left, right) {
    const hints = new Set([left.bot_hint, right.bot_hint].filter((hint) => hint !== "unknown"));
    if (hints.size === 0)
        return { bot_hint: "unknown", bot_hint_source: null };
    const hint = hints.has("mixed") || (hints.has("bot") && hints.has("human"))
        ? "mixed"
        : hints.has("bot")
            ? "bot"
            : "human";
    const source = hint === "mixed" && hints.size > 1
        ? "history"
        : left.bot_hint === hint && left.bot_hint_source
            ? left.bot_hint_source
            : right.bot_hint_source ?? "history";
    return { bot_hint: hint, bot_hint_source: source };
}
export class PeopleDatabase {
    dbPath;
    workspaceKey;
    db;
    transactionDepth = 0;
    constructor(dbPath, workspaceKey = path.dirname(dbPath)) {
        this.dbPath = dbPath;
        this.workspaceKey = workspaceKey;
        ensureDir(path.dirname(dbPath));
        this.db = new DatabaseSync(dbPath);
        try {
            this.db.exec("PRAGMA journal_mode=WAL;");
            this.db.exec("PRAGMA busy_timeout=5000;");
            this.db.exec("PRAGMA foreign_keys=ON;");
            this.db.exec("PRAGMA synchronous=NORMAL;");
            for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    fs.chmodSync(file, 0o600);
                }
                catch {
                    // Best effort: some platforms do not expose POSIX modes. The parent
                    // data directory is still created with owner-only permissions.
                }
            }
            if (this.existingSchemaVersion() > SCHEMA_VERSION) {
                throw new Error(`数据库 schema v${this.existingSchemaVersion()} 高于插件支持的 v${SCHEMA_VERSION}，请升级插件后再打开。`);
            }
            this.db.exec(SCHEMA_SQL);
            this.migrate();
            this.ensureDefaultDimensions();
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() {
        this.db.close();
    }
    migrate() {
        const current = Number(this.metaGet("schema_version") ?? 0);
        this.ensureColumn("accounts", "call_name", "TEXT");
        this.ensureColumn("persons", "call_name", "TEXT");
        this.ensureColumn("accounts", "bot_hint", "TEXT NOT NULL DEFAULT 'unknown'");
        this.ensureColumn("accounts", "bot_hint_source", "TEXT");
        if (current > 0 && current < 3) {
            this.db.exec(`
        UPDATE accounts
        SET bot_hint = CASE lower(trim(current_role))
              WHEN 'bot' THEN 'bot'
              WHEN 'mixed' THEN 'mixed'
              WHEN 'human' THEN 'human'
              WHEN 'user' THEN 'human'
              ELSE 'unknown'
            END,
            bot_hint_source = CASE lower(trim(current_role))
              WHEN 'bot' THEN 'history'
              WHEN 'mixed' THEN 'history'
              WHEN 'human' THEN 'history'
              WHEN 'user' THEN 'history'
              ELSE NULL
            END
        WHERE bot_hint = 'unknown' AND bot_hint_source IS NULL
      `);
        }
        if (current < SCHEMA_VERSION) {
            this.metaSet("schema_version", String(SCHEMA_VERSION));
        }
    }
    existingSchemaVersion() {
        const table = this.db
            .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='meta'")
            .get();
        if (!table)
            return 0;
        const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        const version = Number(row?.value ?? 0);
        return Number.isFinite(version) ? version : 0;
    }
    ensureColumn(table, column, type) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (columns.some((entry) => entry.name === column))
            return;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    transaction(fn) {
        if (this.transactionDepth > 0) {
            const savepoint = `people_sp_${this.transactionDepth}`;
            this.db.exec(`SAVEPOINT ${savepoint}`);
            this.transactionDepth += 1;
            try {
                const result = fn();
                this.db.exec(`RELEASE ${savepoint}`);
                this.transactionDepth -= 1;
                return result;
            }
            catch (error) {
                try {
                    this.db.exec(`ROLLBACK TO ${savepoint}`);
                    this.db.exec(`RELEASE ${savepoint}`);
                }
                catch {
                    // ignore savepoint cleanup failures
                }
                this.transactionDepth -= 1;
                throw error;
            }
        }
        this.db.exec("BEGIN IMMEDIATE");
        this.transactionDepth = 1;
        try {
            const result = fn();
            this.db.exec("COMMIT");
            this.transactionDepth = 0;
            return result;
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch {
                // ignore rollback failures
            }
            this.transactionDepth = 0;
            throw error;
        }
    }
    metaGet(key) {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
        return row ? text(row.value) : null;
    }
    metaSet(key, value) {
        this.db
            .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(key, value);
    }
    /** Cross-process maintenance lease; stale leases expire without granting authority. */
    tryAcquireMaintenanceLease(token, ttlMs = 30 * 60_000) {
        const now = Date.now();
        return this.transaction(() => {
            const owner = this.metaGet("maintenance_lease_owner");
            const until = Date.parse(this.metaGet("maintenance_lease_until") ?? "");
            if (owner && owner !== token && Number.isFinite(until) && until > now)
                return false;
            this.metaSet("maintenance_lease_owner", token);
            this.metaSet("maintenance_lease_until", new Date(now + Math.max(60_000, ttlMs)).toISOString());
            return true;
        });
    }
    releaseMaintenanceLease(token) {
        this.transaction(() => {
            if (this.metaGet("maintenance_lease_owner") !== token)
                return;
            this.metaSet("maintenance_lease_owner", "");
            this.metaSet("maintenance_lease_until", "");
        });
    }
    schemaVersion() {
        return Number(this.metaGet("schema_version") ?? 0);
    }
    // -------------------------------------------------------------------------
    // Accounts
    // -------------------------------------------------------------------------
    upsertAccount(input) {
        const platform = normalizePlatform(input.platform);
        const senderId = input.senderId.trim();
        if (!platform || !senderId)
            throw new Error("账号身份不能为空");
        const platformKey = platformLookupKey(platform);
        const existing = this.getAccountByPlatformSender(platform, senderId);
        const at = input.lastInteraction?.trim() || nowIso();
        const displayName = text(input.displayName);
        if (!existing) {
            const accountId = `${platform}:${senderId}`;
            const firstSeen = input.firstSeen?.trim() || at;
            this.db
                .prepare(`INSERT INTO accounts(account_id, platform, platform_key, sender_id, display_name, current_role, first_seen, last_interaction, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(accountId, platform, platformKey, senderId, displayName, text(input.currentRole)?.toLowerCase() ?? null, firstSeen, at, at);
            return {
                account: this.getAccount(accountId),
                created: true,
                displayNameChanged: Boolean(displayName),
            };
        }
        const requestedMs = Date.parse(at);
        const existingMs = Date.parse(existing.last_interaction);
        const staleSnapshot = Number.isFinite(requestedMs) && Number.isFinite(existingMs) && requestedMs < existingMs;
        const nextDisplayName = staleSnapshot ? undefined : displayName;
        const changed = Boolean(nextDisplayName && nextDisplayName !== existing.display_name);
        const requestedFirstSeen = input.firstSeen?.trim();
        const firstSeen = requestedFirstSeen
            ? earlierTimestamp(existing.first_seen, requestedFirstSeen)
            : existing.first_seen;
        const lastInteraction = staleSnapshot
            ? existing.last_interaction
            : at;
        const updatedAt = staleSnapshot ? existing.updated_at : at;
        this.db
            .prepare(`UPDATE accounts SET
           platform = ?,
           platform_key = ?,
           sender_id = ?,
           display_name = COALESCE(?, display_name),
           current_role = COALESCE(?, current_role),
           first_seen = ?,
           last_interaction = ?,
           updated_at = ?
         WHERE account_id = ?`)
            .run(platform, platformKey, senderId, nextDisplayName ?? null, staleSnapshot ? null : text(input.currentRole)?.toLowerCase() ?? null, firstSeen, lastInteraction, updatedAt, existing.account_id);
        return {
            account: this.getAccount(existing.account_id),
            created: false,
            displayNameChanged: changed,
        };
    }
    getAccount(accountId) {
        const row = this.db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId);
        return row ? this.mapAccount(row) : null;
    }
    getAccountByPlatformSender(platform, senderId) {
        const row = this.db
            .prepare("SELECT * FROM accounts WHERE platform_key = ? AND sender_id = ?")
            .get(platformLookupKey(platform), senderId);
        return row ? this.mapAccount(row) : null;
    }
    /** Drop one group membership row (a member that is not a tracked account). */
    removeGroupMember(groupId, accountId) {
        const result = this.db
            .prepare("DELETE FROM group_members WHERE group_id=? AND account_id=?")
            .run(groupId, accountId);
        return number(result.changes) > 0;
    }
    /** Delete a person and its bindings; refuses when the person still has data. */
    deletePerson(personId) {
        const impressions = this.countImpressions("person", personId);
        const traits = this.getTraits("person", personId).length;
        const bindingRow = this.db
            .prepare("SELECT COUNT(*) AS c FROM person_accounts WHERE person_id=?")
            .get(personId);
        const bindings = number(bindingRow?.c);
        if (impressions > 0 || traits > 0 || bindings > 0)
            return false;
        return this.transaction(() => {
            this.db.prepare("DELETE FROM persons WHERE person_id=?").run(personId);
            return true;
        });
    }
    deleteAccount(accountId) {
        // group_members intentionally has no account foreign key because legacy
        // imports may contain unresolved member rows. Remove them explicitly so a
        // later repair sweep cannot resurrect a deleted placeholder account.
        this.transaction(() => {
            this.db.prepare("DELETE FROM group_members WHERE account_id = ?").run(accountId);
            this.db.prepare("DELETE FROM accounts WHERE account_id = ?").run(accountId);
        });
    }
    setAccountRole(accountId, role) {
        this.db.prepare("UPDATE accounts SET current_role=?, updated_at=? WHERE account_id=?").run(role.trim().toLowerCase(), nowIso(), accountId);
    }
    /** Store a non-authoritative hint inferred from observed behaviour. */
    setAccountBotHint(accountId, hint, source) {
        if (!this.getAccount(accountId))
            throw new Error(`账号不存在: ${accountId}`);
        const normalized = normalizeBotHint(hint);
        const normalizedSource = normalizeBotHintSource(source) ?? "history";
        this.db
            .prepare("UPDATE accounts SET bot_hint=?, bot_hint_source=?, updated_at=? WHERE account_id=?")
            .run(normalized, normalized === "unknown" ? null : normalizedSource, nowIso(), accountId);
    }
    /** Move account-level data (impressions, traits, group memberships) from
     *  `sourceId` to `targetId`, then drop the source row. If the source was
     *  bound to a person and the target was not, the target inherits that person.
     *  Runs in one transaction.
     */
    mergeAccounts(sourceId, targetId) {
        return this.transaction(() => {
            const source = this.getAccount(sourceId);
            const target = this.getAccount(targetId);
            if (!source || !target)
                throw new Error(`账号不存在: ${sourceId} 或 ${targetId}`);
            if (source.account_id === target.account_id)
                throw new Error("源账号和目标账号不能相同");
            if (source.bound_person_id &&
                target.bound_person_id &&
                source.bound_person_id !== target.bound_person_id) {
                throw new Error(`账号绑定冲突：${source.account_id} → ${source.bound_person_id}，` +
                    `${target.account_id} → ${target.bound_person_id}。请先确认并合并人物。`);
            }
            // Account metadata has independent evidence value. Keep target names and
            // role authoritative, combine both behaviour hints, and preserve the full
            // observed time range.
            const mergedHint = mergeBotHints(target, source);
            this.db
                .prepare(`UPDATE accounts SET
             display_name=?, confirmed_name=?, call_name=?, current_role=?,
             bot_hint=?, bot_hint_source=?,
             first_seen=?, last_interaction=?, updated_at=?
           WHERE account_id=?`)
                .run(target.display_name ?? source.display_name, target.confirmed_name ?? source.confirmed_name, target.call_name ?? source.call_name, target.current_role ?? source.current_role, mergedHint.bot_hint, mergedHint.bot_hint_source, earlierTimestamp(target.first_seen, source.first_seen), laterTimestamp(target.last_interaction, source.last_interaction), laterTimestamp(target.updated_at, source.updated_at), targetId);
            const impressions = number(this.db
                .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
             SELECT 'account', ?, content, dedupe_key, source, agent_id, created_at
             FROM impressions WHERE owner_type='account' AND owner_id=?`)
                .run(targetId, sourceId).changes);
            this.db.prepare("DELETE FROM impressions WHERE owner_type='account' AND owner_id=?").run(sourceId);
            // Preserve conflicting source traits as impressions so a merge never
            // silently drops a value the target already holds for the same dimension.
            const sourceTraits = this.getTraits("account", sourceId);
            const targetDims = new Set(this.getTraits("account", targetId).map((trait) => trait.dimension));
            for (const trait of sourceTraits) {
                if (targetDims.has(trait.dimension)) {
                    this.addImpression({
                        ownerType: "account",
                        ownerId: targetId,
                        content: `合并保留特征 ${trait.dimension}：${trait.value}`,
                        source: "merge",
                    });
                }
            }
            const traits = number(this.db
                .prepare(`INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
             SELECT 'account', ?, dimension, value, confidence, updated_at
             FROM traits WHERE owner_type='account' AND owner_id=?`)
                .run(targetId, sourceId).changes);
            this.db.prepare("DELETE FROM traits WHERE owner_type='account' AND owner_id=?").run(sourceId);
            const sourceMemberships = this.listAllGroupMembers().filter((member) => member.account_id === sourceId);
            let groupMembers = 0;
            for (const member of sourceMemberships) {
                this.mergeGroupMember(member, targetId);
                groupMembers += 1;
            }
            this.db.prepare("DELETE FROM group_members WHERE account_id=?").run(sourceId);
            let bindingMoved = false;
            if (source.bound_person_id && !target.bound_person_id) {
                this.bindAccount(targetId, source.bound_person_id, { method: "manual", confidence: "confirmed", migrate: false });
                bindingMoved = true;
            }
            this.deleteAccount(sourceId);
            return { impressions, traits, groupMembers, bindingMoved };
        });
    }
    searchAccounts(query, limit = 10) {
        const value = likeContains(query);
        if (!query.trim())
            return [];
        const rows = this.db
            .prepare(`SELECT * FROM accounts
         WHERE account_id LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR sender_id LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR confirmed_name LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR call_name LIKE ? ESCAPE '\\' COLLATE NOCASE
         ORDER BY julianday(last_interaction) DESC, last_interaction DESC LIMIT ?`)
            .all(value, value, value, value, value, limit);
        return rows.map((row) => this.mapAccount(row));
    }
    listAllAccounts() {
        const rows = this.db
            .prepare("SELECT * FROM accounts ORDER BY julianday(last_interaction) DESC, last_interaction DESC")
            .all();
        return rows.map((row) => this.mapAccount(row));
    }
    listAccountsBySender(senderId) {
        const rows = this.db
            .prepare("SELECT * FROM accounts WHERE sender_id=? ORDER BY julianday(last_interaction) DESC, last_interaction DESC")
            .all(senderId.trim());
        return rows.map((row) => this.mapAccount(row));
    }
    /** Rewrite only legacy platform labels; identity keys and activity times stay intact. */
    normalizePlatformLabels() {
        return this.transaction(() => {
            let accounts = 0;
            let groups = 0;
            for (const account of this.listAllAccounts()) {
                const platform = normalizePlatform(account.platform);
                const platformKey = platformLookupKey(platform);
                if (platform === account.platform && platformKey === platformLookupKey(account.platform))
                    continue;
                this.db
                    .prepare("UPDATE accounts SET platform=?, platform_key=? WHERE account_id=?")
                    .run(platform, platformKey, account.account_id);
                accounts += 1;
            }
            for (const group of this.listAllGroups()) {
                const platform = normalizePlatform(group.platform);
                const platformKey = platformLookupKey(platform);
                if (platform === group.platform && platformKey === platformLookupKey(group.platform))
                    continue;
                this.db
                    .prepare("UPDATE groups SET platform=?, platform_key=? WHERE group_id=?")
                    .run(platform, platformKey, group.group_id);
                groups += 1;
            }
            return { accounts, groups };
        });
    }
    listAllPersonAccounts() {
        const rows = this.db.prepare("SELECT * FROM person_accounts ORDER BY bound_at").all();
        return rows.map((row) => ({
            account_id: String(row.account_id),
            person_id: String(row.person_id),
            bind_method: String(row.bind_method),
            confidence: String(row.confidence),
            bound_at: String(row.bound_at),
        }));
    }
    setConfirmedName(accountId, name) {
        const at = nowIso();
        this.db
            .prepare("UPDATE accounts SET confirmed_name = ?, updated_at = ? WHERE account_id = ?")
            .run(name.trim(), at, accountId);
    }
    setCallName(accountId, name) {
        const at = nowIso();
        this.db
            .prepare("UPDATE accounts SET call_name = ?, updated_at = ? WHERE account_id = ?")
            .run(name.trim(), at, accountId);
    }
    touchAccount(accountId, at = nowIso()) {
        this.db
            .prepare("UPDATE accounts SET last_interaction = ?, updated_at = ? WHERE account_id = ?")
            .run(at, at, accountId);
    }
    mapAccount(row) {
        return {
            account_id: String(row.account_id),
            platform: String(row.platform),
            sender_id: String(row.sender_id),
            display_name: text(row.display_name),
            confirmed_name: text(row.confirmed_name),
            call_name: text(row.call_name),
            current_role: text(row.current_role),
            bot_hint: normalizeBotHint(row.bot_hint),
            bot_hint_source: normalizeBotHint(row.bot_hint) === "unknown"
                ? null
                : normalizeBotHintSource(row.bot_hint_source),
            first_seen: String(row.first_seen),
            last_interaction: String(row.last_interaction),
            updated_at: String(row.updated_at),
            bound_person_id: text(row.bound_person_id),
        };
    }
    // -------------------------------------------------------------------------
    // Persons and bindings
    // -------------------------------------------------------------------------
    createPerson(input = {}) {
        const personId = input.personId?.trim() || newPersonId();
        const at = input.createdAt?.trim() || nowIso();
        this.db
            .prepare("INSERT OR IGNORE INTO persons(person_id, name, notes, created_at, updated_at) VALUES(?, ?, ?, ?, ?)")
            .run(personId, text(input.name), text(input.notes), at, at);
        return this.getPerson(personId);
    }
    getPerson(personId) {
        const row = this.db.prepare("SELECT * FROM persons WHERE person_id = ?").get(personId);
        return row
            ? {
                person_id: String(row.person_id),
                name: text(row.name),
                call_name: text(row.call_name),
                notes: text(row.notes),
                created_at: String(row.created_at),
                updated_at: String(row.updated_at),
            }
            : null;
    }
    listAllPersons() {
        const rows = this.db
            .prepare("SELECT * FROM persons ORDER BY julianday(updated_at) DESC, updated_at DESC")
            .all();
        return rows.map((row) => ({
            person_id: String(row.person_id),
            name: text(row.name),
            call_name: text(row.call_name),
            notes: text(row.notes),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at),
        }));
    }
    mergePersons(sourcePersonId, targetPersonId) {
        if (sourcePersonId === targetPersonId)
            throw new Error("源人物和目标人物不能相同。");
        return this.transaction(() => {
            const source = this.getPerson(sourcePersonId);
            const target = this.getPerson(targetPersonId);
            if (!source)
                throw new Error(`源人物不存在: ${sourcePersonId}`);
            if (!target)
                throw new Error(`目标人物不存在: ${targetPersonId}`);
            const impressions = number(this.db
                .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
             SELECT 'person', ?, content, dedupe_key, source, agent_id, created_at
             FROM impressions WHERE owner_type='person' AND owner_id=?`)
                .run(targetPersonId, sourcePersonId).changes);
            this.db
                .prepare("DELETE FROM impressions WHERE owner_type='person' AND owner_id=?")
                .run(sourcePersonId);
            // Preserve conflicting source traits as impressions so a merge never
            // silently drops a value the target already holds for the same dimension.
            const sourceTraits = this.getTraits("person", sourcePersonId);
            const targetDims = new Set(this.getTraits("person", targetPersonId).map((trait) => trait.dimension));
            for (const trait of sourceTraits) {
                if (targetDims.has(trait.dimension)) {
                    this.addImpression({
                        ownerType: "person",
                        ownerId: targetPersonId,
                        content: `合并保留特征 ${trait.dimension}：${trait.value}`,
                        source: "merge",
                    });
                }
            }
            const traits = number(this.db
                .prepare(`INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
             SELECT 'person', ?, dimension, value, confidence, updated_at
             FROM traits WHERE owner_type='person' AND owner_id=?`)
                .run(targetPersonId, sourcePersonId).changes);
            this.db.prepare("DELETE FROM traits WHERE owner_type='person' AND owner_id=?").run(sourcePersonId);
            const accounts = number(this.db
                .prepare("UPDATE OR REPLACE person_accounts SET person_id=?, bound_at=? WHERE person_id=?")
                .run(targetPersonId, nowIso(), sourcePersonId).changes);
            this.db
                .prepare("UPDATE accounts SET bound_person_id=?, updated_at=? WHERE bound_person_id=?")
                .run(targetPersonId, nowIso(), sourcePersonId);
            const notes = target.notes?.trim() || source.notes?.trim() || null;
            const callName = target.call_name?.trim() || source.call_name?.trim() || null;
            const name = target.name?.trim() || source.name?.trim() || null;
            this.db
                .prepare("UPDATE persons SET name=?, call_name=?, notes=?, updated_at=? WHERE person_id=?")
                .run(name, callName, notes, nowIso(), targetPersonId);
            this.db
                .prepare("UPDATE persons SET created_at=? WHERE person_id=?")
                .run(earlierTimestamp(target.created_at, source.created_at), targetPersonId);
            this.db.prepare("DELETE FROM persons WHERE person_id=?").run(sourcePersonId);
            return { accounts, impressions, traits, deletedSource: true };
        });
    }
    unbindAccount(accountId, copyProfile = true) {
        return this.transaction(() => {
            const account = this.getAccount(accountId);
            if (!account)
                throw new Error(`账号不存在: ${accountId}`);
            const personId = account.bound_person_id;
            if (!personId)
                return { impressionsCopied: 0, traitsCopied: 0 };
            let impressionsCopied = 0;
            let traitsCopied = 0;
            if (copyProfile) {
                impressionsCopied = number(this.db
                    .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
               SELECT 'account', ?, content, dedupe_key, source, agent_id, created_at
               FROM impressions WHERE owner_type='person' AND owner_id=?`)
                    .run(accountId, personId).changes);
                traitsCopied = number(this.db
                    .prepare(`INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
               SELECT 'account', ?, dimension, value, confidence, updated_at
               FROM traits WHERE owner_type='person' AND owner_id=?`)
                    .run(accountId, personId).changes);
            }
            this.db.prepare("DELETE FROM person_accounts WHERE account_id=?").run(accountId);
            this.db
                .prepare("UPDATE accounts SET bound_person_id=NULL, updated_at=? WHERE account_id=?")
                .run(nowIso(), accountId);
            return { impressionsCopied, traitsCopied };
        });
    }
    updatePerson(personId, input) {
        const at = nowIso();
        this.db
            .prepare("UPDATE persons SET name = COALESCE(?, name), call_name = COALESCE(?, call_name), notes = COALESCE(?, notes), updated_at = ? WHERE person_id = ?")
            .run(text(input.name), text(input.callName), text(input.notes), at, personId);
    }
    searchPersons(query, limit = 10) {
        const value = likeContains(query);
        const rows = this.db
            .prepare("SELECT * FROM persons WHERE person_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR call_name LIKE ? ESCAPE '\\' ORDER BY julianday(updated_at) DESC, updated_at DESC LIMIT ?")
            .all(value, value, value, limit);
        return rows.map((row) => ({
            person_id: String(row.person_id),
            name: text(row.name),
            call_name: text(row.call_name),
            notes: text(row.notes),
            created_at: String(row.created_at),
            updated_at: String(row.updated_at),
        }));
    }
    bindAccount(accountId, personId, options = {}) {
        const at = nowIso();
        return this.transaction(() => {
            this.db
                .prepare(`INSERT INTO person_accounts(account_id, person_id, bind_method, confidence, bound_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             person_id=excluded.person_id,
             bind_method=excluded.bind_method,
             confidence=excluded.confidence,
             bound_at=excluded.bound_at`)
                .run(accountId, personId, options.method ?? "manual", options.confidence ?? "confirmed", at);
            this.db
                .prepare("UPDATE accounts SET bound_person_id = ?, updated_at = ? WHERE account_id = ?")
                .run(personId, at, accountId);
            let impressionsMoved = 0;
            let traitsMoved = 0;
            let traitsPreserved = 0;
            if (options.migrate !== false) {
                impressionsMoved = number(this.db
                    .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
               SELECT 'person', ?, content, dedupe_key, source, agent_id, created_at
               FROM impressions WHERE owner_type='account' AND owner_id=?`)
                    .run(personId, accountId).changes);
                this.db
                    .prepare("DELETE FROM impressions WHERE owner_type='account' AND owner_id=?")
                    .run(accountId);
                // Binding a populated account to an existing person must not erase a
                // conflicting dimension. Keep the person's value as authoritative and
                // retain the account value as an explicit impression.
                const sourceTraits = this.getTraits("account", accountId);
                const targetDims = new Set(this.getTraits("person", personId).map((trait) => trait.dimension));
                for (const trait of sourceTraits) {
                    if (!targetDims.has(trait.dimension))
                        continue;
                    if (this.addImpression({
                        ownerType: "person",
                        ownerId: personId,
                        content: `绑定保留特征 ${trait.dimension}：${trait.value}`,
                        source: "bind",
                    })) {
                        impressionsMoved += 1;
                        traitsPreserved += 1;
                    }
                }
                traitsMoved = number(this.db
                    .prepare(`INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
               SELECT 'person', ?, dimension, value, confidence, updated_at
               FROM traits WHERE owner_type='account' AND owner_id=?`)
                    .run(personId, accountId).changes);
                this.db.prepare("DELETE FROM traits WHERE owner_type='account' AND owner_id=?").run(accountId);
            }
            this.db.prepare("UPDATE persons SET updated_at=? WHERE person_id=?").run(at, personId);
            return { impressionsMoved, traitsMoved, traitsPreserved };
        });
    }
    listPersonAccounts(personId) {
        const rows = this.db
            .prepare(`SELECT a.* FROM accounts a JOIN person_accounts pa ON pa.account_id = a.account_id
         WHERE pa.person_id = ? ORDER BY julianday(a.last_interaction) DESC, a.last_interaction DESC`)
            .all(personId);
        return rows.map((row) => this.mapAccount(row));
    }
    // -------------------------------------------------------------------------
    // Traits and impressions
    // -------------------------------------------------------------------------
    setTrait(ownerType, ownerId, dimension, value, confidence = null) {
        const at = nowIso();
        this.db
            .prepare(`INSERT INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_type, owner_id, dimension) DO UPDATE SET
           value=excluded.value, confidence=excluded.confidence, updated_at=excluded.updated_at`)
            .run(ownerType, ownerId, dimension, value.trim(), confidence, at);
        if (ownerType === "person") {
            this.db.prepare("UPDATE persons SET updated_at=? WHERE person_id=?").run(at, ownerId);
        }
    }
    getTraits(ownerType, ownerId) {
        const rows = this.db
            .prepare(`SELECT t.dimension, t.value, t.confidence, t.updated_at, d.sort
         FROM traits t LEFT JOIN dimensions d ON d.key = t.dimension
         WHERE t.owner_type=? AND t.owner_id=?
         ORDER BY COALESCE(d.sort, 999), t.dimension`)
            .all(ownerType, ownerId);
        return rows.map((row) => ({
            dimension: String(row.dimension),
            value: String(row.value),
            confidence: text(row.confidence),
            updated_at: String(row.updated_at),
        }));
    }
    addImpression(input) {
        const content = input.content.trim();
        if (!content)
            return false;
        const result = this.db
            .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`)
            .run(input.ownerType, input.ownerId, content, contentKey(content), text(input.source), text(input.agentId), input.createdAt ?? nowIso());
        return number(result.changes) > 0;
    }
    listImpressions(ownerType, ownerId, limit = 50) {
        const rows = this.db
            .prepare(`SELECT * FROM impressions WHERE owner_type=? AND owner_id=?
         ORDER BY julianday(created_at) DESC, created_at DESC, id DESC LIMIT ?`)
            .all(ownerType, ownerId, limit);
        return rows.map((row) => ({
            id: number(row.id),
            owner_type: String(row.owner_type),
            owner_id: String(row.owner_id),
            content: String(row.content),
            source: text(row.source),
            agent_id: text(row.agent_id),
            created_at: String(row.created_at),
        }));
    }
    listImpressionsByIds(ownerType, ownerId, ids) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => "?").join(", ");
        const rows = this.db
            .prepare(`SELECT * FROM impressions
         WHERE owner_type=? AND owner_id=? AND id IN (${placeholders})
         ORDER BY julianday(created_at) DESC, created_at DESC, id DESC`)
            .all(ownerType, ownerId, ...ids);
        return rows.map((row) => ({
            id: number(row.id),
            owner_type: String(row.owner_type),
            owner_id: String(row.owner_id),
            content: String(row.content),
            source: text(row.source),
            agent_id: text(row.agent_id),
            created_at: String(row.created_at),
        }));
    }
    countImpressions(ownerType, ownerId) {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n FROM impressions WHERE owner_type=? AND owner_id=?")
            .get(ownerType, ownerId);
        return number(row?.n);
    }
    removeImpressions(ownerType, ownerId, match) {
        const result = this.db
            .prepare("DELETE FROM impressions WHERE owner_type=? AND owner_id=? AND content LIKE ? ESCAPE '\\'")
            .run(ownerType, ownerId, likeContains(match));
        return number(result.changes);
    }
    removeImpressionsByIds(ownerType, ownerId, ids) {
        if (ids.length === 0)
            return 0;
        const placeholders = ids.map(() => "?").join(", ");
        const result = this.db
            .prepare(`DELETE FROM impressions WHERE owner_type=? AND owner_id=? AND id IN (${placeholders})`)
            .run(ownerType, ownerId, ...ids);
        return number(result.changes);
    }
    removeTraitsMatching(ownerType, ownerId, match) {
        const result = this.db
            .prepare("DELETE FROM traits WHERE owner_type=? AND owner_id=? AND value LIKE ? ESCAPE '\\'")
            .run(ownerType, ownerId, likeContains(match));
        return number(result.changes);
    }
    /** Remove profile data for one owner without touching the owner index row. */
    clearProfile(ownerType, ownerId) {
        return this.transaction(() => ({
            impressions: number(this.db
                .prepare("DELETE FROM impressions WHERE owner_type=? AND owner_id=?")
                .run(ownerType, ownerId).changes),
            traits: number(this.db
                .prepare("DELETE FROM traits WHERE owner_type=? AND owner_id=?")
                .run(ownerType, ownerId).changes),
        }));
    }
    listAllTraits() {
        const rows = this.db.prepare("SELECT * FROM traits ORDER BY owner_type, owner_id, dimension").all();
        return rows.map((row) => ({
            owner_type: String(row.owner_type),
            owner_id: String(row.owner_id),
            dimension: String(row.dimension),
            value: String(row.value),
            confidence: text(row.confidence),
            updated_at: String(row.updated_at),
        }));
    }
    /** Distinct owner references used by polymorphic profile tables. */
    listProfileOwners() {
        const rows = this.db
            .prepare(`SELECT owner_type, owner_id FROM impressions
         UNION
         SELECT owner_type, owner_id FROM traits
         ORDER BY owner_type, owner_id`)
            .all();
        return rows.map((row) => ({
            owner_type: String(row.owner_type),
            owner_id: String(row.owner_id),
        }));
    }
    profileStats(limit = 20) {
        const rows = this.db
            .prepare(`SELECT owner_type, owner_id, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
         FROM impressions GROUP BY owner_type, owner_id ORDER BY n DESC LIMIT ?`)
            .all(limit);
        return rows.map((row) => ({
            owner_type: String(row.owner_type),
            owner_id: String(row.owner_id),
            impressions: number(row.n),
            oldest: String(row.oldest),
            newest: String(row.newest),
        }));
    }
    searchImpressions(query, limit = 10) {
        const value = likeContains(query);
        if (!query.trim())
            return [];
        const rows = this.db
            .prepare("SELECT * FROM impressions WHERE content LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY julianday(created_at) DESC, created_at DESC LIMIT ?")
            .all(value, limit);
        return rows.map((row) => ({
            id: number(row.id),
            owner_type: String(row.owner_type),
            owner_id: String(row.owner_id),
            content: String(row.content),
            source: text(row.source),
            agent_id: text(row.agent_id),
            created_at: String(row.created_at),
        }));
    }
    searchGroupEvents(query, limit = 10) {
        const value = likeContains(query);
        if (!query.trim())
            return [];
        const rows = this.db
            .prepare("SELECT * FROM group_events WHERE summary LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY julianday(occurred_at) DESC, occurred_at DESC LIMIT ?")
            .all(value, limit);
        return rows.map((row) => ({
            id: number(row.id),
            group_id: String(row.group_id),
            occurred_at: String(row.occurred_at),
            category: String(row.category),
            summary: String(row.summary),
            tags: this.parseStringArray(row.tags),
            agent_id: text(row.agent_id),
        }));
    }
    backupTo(file) {
        ensureDir(path.dirname(file));
        if (fs.existsSync(file))
            throw new Error(`备份文件已存在: ${file}`);
        this.db.exec("PRAGMA wal_checkpoint(FULL);");
        const escaped = file.replace(/'/g, "''");
        this.db.exec(`VACUUM INTO '${escaped}'`);
        fs.chmodSync(file, 0o600);
    }
    /** Erase deleted pages from the live database and truncate the WAL. */
    purgeStorage() {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        this.db.exec("VACUUM;");
    }
    dumpDatabase(database) {
        const tables = [
            "accounts",
            "persons",
            "person_accounts",
            "impressions",
            "traits",
            "groups",
            "group_members",
            "group_events",
            "group_observations",
            "dimensions",
            "scan_channels",
            "scan_meta",
            "meta",
        ];
        const schemaRow = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        const data = {
            exported_at: nowIso(),
            schema_version: Number(schemaRow?.value ?? 0),
        };
        for (const table of tables) {
            data[table] = database.prepare(`SELECT * FROM ${table}`).all();
        }
        return data;
    }
    /** Serialize the completed SQLite snapshot, never the concurrently written live DB. */
    dumpSnapshot(file) {
        const snapshot = new DatabaseSync(file, { readOnly: true });
        try {
            return this.dumpDatabase(snapshot);
        }
        finally {
            snapshot.close();
        }
    }
    dump() {
        return this.dumpDatabase(this.db);
    }
    // -------------------------------------------------------------------------
    // Groups
    // -------------------------------------------------------------------------
    upsertGroup(input) {
        const platform = normalizePlatform(input.platform);
        const platformKey = platformLookupKey(platform);
        const existing = this.getGroup(input.groupId) ?? this.findGroup(platform, input.chatId);
        const at = nowIso();
        const subject = text(input.subject);
        const displayName = text(input.displayName);
        if (!existing) {
            this.db
                .prepare(`INSERT INTO groups(group_id, platform, platform_key, chat_id, display_name, group_subject, bot_names, first_seen, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(input.groupId, platform, platformKey, input.chatId, displayName, subject, JSON.stringify(input.botNames ?? []), input.firstSeen?.trim() || at, at);
            return { group: this.getGroup(input.groupId), created: true, subjectChanged: Boolean(subject) };
        }
        const changed = Boolean(subject && subject !== existing.group_subject);
        const firstSeen = input.firstSeen?.trim()
            ? earlierTimestamp(existing.first_seen, input.firstSeen.trim())
            : existing.first_seen;
        const botNames = [...new Set([...existing.bot_names, ...(input.botNames ?? [])])];
        this.db
            .prepare(`UPDATE groups SET
           platform=?, platform_key=?, chat_id=?,
           display_name=COALESCE(?, display_name),
           group_subject=COALESCE(?, group_subject),
           bot_names=?, first_seen=?,
           updated_at=?
         WHERE group_id=?`)
            .run(platform, platformKey, input.chatId, displayName, subject, JSON.stringify(botNames), firstSeen, at, existing.group_id);
        return {
            group: this.getGroup(existing.group_id),
            created: false,
            subjectChanged: changed,
        };
    }
    getGroup(groupId) {
        const row = this.db.prepare("SELECT * FROM groups WHERE group_id=?").get(groupId);
        return row ? this.mapGroup(row) : null;
    }
    findGroup(platform, chatId) {
        const row = this.db
            .prepare("SELECT * FROM groups WHERE platform_key=? AND chat_id=?")
            .get(platformLookupKey(platform), chatId);
        return row ? this.mapGroup(row) : null;
    }
    findGroupByChat(chatId) {
        const row = this.db
            .prepare("SELECT * FROM groups WHERE chat_id=? ORDER BY julianday(updated_at) DESC, updated_at DESC LIMIT 1")
            .get(chatId);
        return row ? this.mapGroup(row) : null;
    }
    /** All group rows sharing the same chat id, newest first (multi-backend independence). */
    findGroupsByChatAll(chatId) {
        const rows = this.db
            .prepare("SELECT * FROM groups WHERE chat_id=? ORDER BY julianday(updated_at) DESC, updated_at DESC")
            .all(chatId.trim());
        return rows.map((row) => this.mapGroup(row));
    }
    listAllGroups() {
        const rows = this.db
            .prepare("SELECT * FROM groups ORDER BY julianday(updated_at) DESC, updated_at DESC")
            .all();
        return rows.map((row) => this.mapGroup(row));
    }
    updateGroupSubject(groupId, subject) {
        const at = nowIso();
        this.db
            .prepare("UPDATE groups SET group_subject=?, updated_at=? WHERE group_id=?")
            .run(subject.trim(), at, groupId);
    }
    setGroupBotNames(groupId, names) {
        this.db.prepare("UPDATE groups SET bot_names=? WHERE group_id=?").run(JSON.stringify(names), groupId);
    }
    countGroupEvents(groupId) {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM group_events WHERE group_id=?").get(groupId);
        return number(row?.n ?? 0);
    }
    countGroupMembers(groupId) {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id=?").get(groupId);
        return number(row?.n ?? 0);
    }
    mergeGroups(sourceId, targetId) {
        return this.transaction(() => {
            const source = this.getGroup(sourceId);
            const target = this.getGroup(targetId);
            if (!source || !target)
                throw new Error("群不存在: " + sourceId + " 或 " + targetId);
            if (source.group_id === target.group_id)
                throw new Error("源群和目标群不能相同");
            const events = number(this.db
                .prepare("INSERT OR IGNORE INTO group_events(group_id, occurred_at, category, summary, tags, agent_id, dedupe_key, created_at) " +
                "SELECT ?, occurred_at, category, summary, tags, agent_id, dedupe_key, created_at FROM group_events WHERE group_id=?")
                .run(targetId, sourceId).changes);
            this.db.prepare("DELETE FROM group_events WHERE group_id=?").run(sourceId);
            const observations = number(this.db
                .prepare("INSERT OR IGNORE INTO group_observations(group_id, content, dedupe_key, created_at) " +
                "SELECT ?, content, dedupe_key, created_at FROM group_observations WHERE group_id=?")
                .run(targetId, sourceId).changes);
            this.db.prepare("DELETE FROM group_observations WHERE group_id=?").run(sourceId);
            const sourceMembers = this.listGroupMembersByGroup(sourceId);
            for (const member of sourceMembers)
                this.mergeGroupMember(member, member.account_id, targetId);
            const members = sourceMembers.length;
            this.db.prepare("DELETE FROM group_members WHERE group_id=?").run(sourceId);
            const botNames = [...new Set([...target.bot_names, ...source.bot_names])];
            const subjectAdopted = Boolean(!target.group_subject && source.group_subject);
            this.db
                .prepare(`UPDATE groups SET display_name=?, group_subject=?, bot_names=?, first_seen=?, updated_at=? WHERE group_id=?`)
                .run(target.display_name ?? source.display_name, target.group_subject ?? source.group_subject, JSON.stringify(botNames), earlierTimestamp(target.first_seen, source.first_seen), laterTimestamp(target.updated_at, source.updated_at), targetId);
            this.db.prepare("UPDATE scan_channels SET group_id=? WHERE group_id=?").run(targetId, sourceId);
            this.db.prepare("DELETE FROM groups WHERE group_id=?").run(sourceId);
            return { events, members, observations, botNames, subjectAdopted };
        });
    }
    addGroupEvent(input) {
        const summary = input.summary.trim();
        if (!summary)
            return false;
        const occurredAt = input.occurredAt ?? nowIso();
        const dedupe = contentKey(`${occurredAt.slice(0, 10)}:${summary}`);
        const result = this.db
            .prepare(`INSERT OR IGNORE INTO group_events(group_id, occurred_at, category, summary, tags, agent_id, dedupe_key, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.groupId, occurredAt, input.category?.trim() || "observation", summary, JSON.stringify(input.tags ?? []), text(input.agentId), dedupe, nowIso());
        if (number(result.changes) > 0) {
            this.db.prepare("UPDATE groups SET updated_at=? WHERE group_id=?").run(nowIso(), input.groupId);
            return true;
        }
        return false;
    }
    listGroupEvents(groupId, limit = 10) {
        const rows = this.db
            .prepare("SELECT * FROM group_events WHERE group_id=? ORDER BY julianday(occurred_at) DESC, occurred_at DESC, id DESC LIMIT ?")
            .all(groupId, limit);
        return rows.map((row) => ({
            id: number(row.id),
            group_id: String(row.group_id),
            occurred_at: String(row.occurred_at),
            category: String(row.category),
            summary: String(row.summary),
            tags: this.parseStringArray(row.tags),
            agent_id: text(row.agent_id),
        }));
    }
    addGroupObservation(groupId, content) {
        const value = content.trim();
        if (!value)
            return false;
        const result = this.db
            .prepare(`INSERT OR IGNORE INTO group_observations(group_id, content, dedupe_key, created_at)
         VALUES(?, ?, ?, ?)`)
            .run(groupId, value, contentKey(value), nowIso());
        return number(result.changes) > 0;
    }
    upsertGroupMember(input) {
        const at = input.at ?? nowIso();
        const existing = this.getGroupMember(input.groupId, input.accountId);
        const evidence = existing
            ? strongerMemberEvidence(existing, {
                classification: input.classification?.trim() || "pending",
                confidence: input.confidence?.trim() || "tentative",
            })
            : {
                classification: input.classification?.trim() || "pending",
                confidence: input.confidence?.trim() || "tentative",
            };
        const firstSeen = existing
            ? earlierTimestamp(existing.first_seen, input.firstSeen ?? at)
            : input.firstSeen ?? at;
        const lastSeen = existing ? laterTimestamp(existing.last_seen, at) : at;
        const roleInGroup = existing
            ? rankOf(input.roleInGroup, GROUP_ROLE_RANK) > rankOf(existing.role_in_group, GROUP_ROLE_RANK)
                ? text(input.roleInGroup)
                : existing.role_in_group
            : text(input.roleInGroup);
        this.db
            .prepare(`INSERT INTO group_members(group_id, account_id, display_name, classification, confidence, role_in_group, first_seen, last_seen)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, account_id) DO UPDATE SET
           display_name=COALESCE(excluded.display_name, group_members.display_name),
           classification=excluded.classification,
           confidence=excluded.confidence,
           role_in_group=excluded.role_in_group,
           first_seen=excluded.first_seen,
           last_seen=excluded.last_seen`)
            .run(input.groupId, input.accountId, text(input.displayName), evidence.classification, evidence.confidence, roleInGroup, firstSeen, lastSeen);
    }
    getGroupMember(groupId, accountId) {
        const row = this.db
            .prepare("SELECT * FROM group_members WHERE group_id=? AND account_id=?")
            .get(groupId, accountId);
        return row ? this.mapGroupMember(row) : null;
    }
    listGroupMembersByGroup(groupId) {
        const rows = this.db
            .prepare("SELECT * FROM group_members WHERE group_id=? ORDER BY julianday(last_seen) DESC, last_seen DESC")
            .all(groupId);
        return rows.map((row) => this.mapGroupMember(row));
    }
    mapGroupMember(row) {
        return {
            group_id: String(row.group_id),
            account_id: String(row.account_id),
            display_name: text(row.display_name),
            classification: String(row.classification),
            confidence: String(row.confidence),
            role_in_group: text(row.role_in_group),
            first_seen: String(row.first_seen),
            last_seen: String(row.last_seen),
        };
    }
    /** Merge one source membership into a target key without losing evidence. */
    mergeGroupMember(source, accountId, groupId = source.group_id) {
        const target = this.getGroupMember(groupId, accountId);
        if (!target) {
            this.db
                .prepare("UPDATE group_members SET group_id=?, account_id=? WHERE group_id=? AND account_id=?")
                .run(groupId, accountId, source.group_id, source.account_id);
            return false;
        }
        const evidence = strongerMemberEvidence(target, source);
        const role = rankOf(source.role_in_group, GROUP_ROLE_RANK) > rankOf(target.role_in_group, GROUP_ROLE_RANK)
            ? source.role_in_group
            : target.role_in_group;
        this.upsertGroupMember({
            groupId,
            accountId,
            displayName: target.display_name ?? source.display_name,
            classification: evidence.classification,
            confidence: evidence.confidence,
            roleInGroup: role,
            firstSeen: earlierTimestamp(target.first_seen, source.first_seen),
            at: laterTimestamp(target.last_seen, source.last_seen),
        });
        return true;
    }
    listGroupMembers(groupId, limit = 50) {
        const rows = this.db
            .prepare("SELECT * FROM group_members WHERE group_id=? ORDER BY julianday(last_seen) DESC, last_seen DESC LIMIT ?")
            .all(groupId, limit);
        return rows.map((row) => this.mapGroupMember(row));
    }
    listAllGroupMembers() {
        const rows = this.db
            .prepare("SELECT * FROM group_members ORDER BY group_id, julianday(last_seen) DESC, last_seen DESC")
            .all();
        return rows.map((row) => this.mapGroupMember(row));
    }
    mapGroup(row) {
        return {
            group_id: String(row.group_id),
            platform: String(row.platform),
            chat_id: String(row.chat_id),
            display_name: text(row.display_name),
            group_subject: text(row.group_subject),
            bot_names: this.parseStringArray(row.bot_names),
            first_seen: String(row.first_seen),
            updated_at: String(row.updated_at),
        };
    }
    // -------------------------------------------------------------------------
    // Dimensions
    // -------------------------------------------------------------------------
    ensureDefaultDimensions() {
        const statement = this.db.prepare("INSERT OR IGNORE INTO dimensions(key, label, active, sort) VALUES(?, ?, 1, ?)");
        for (const dimension of DEFAULT_DIMENSIONS) {
            statement.run(dimension.key, dimension.label, dimension.sort);
        }
    }
    upsertDimension(key, label, active, sort = 999) {
        this.db
            .prepare(`INSERT INTO dimensions(key, label, active, sort) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET label=excluded.label, active=excluded.active, sort=excluded.sort`)
            .run(key.trim(), label.trim(), active ? 1 : 0, sort);
    }
    listDimensions() {
        const rows = this.db.prepare("SELECT * FROM dimensions ORDER BY sort, key").all();
        return rows.map((row) => ({
            key: String(row.key),
            label: String(row.label),
            active: number(row.active) !== 0,
            sort: number(row.sort),
        }));
    }
    getDimension(key) {
        const row = this.db.prepare("SELECT * FROM dimensions WHERE key=?").get(key);
        if (!row)
            return null;
        return {
            key: String(row.key),
            label: String(row.label),
            active: number(row.active) !== 0,
            sort: number(row.sort),
        };
    }
    // -------------------------------------------------------------------------
    // Scan state
    // -------------------------------------------------------------------------
    upsertScanChannel(input) {
        this.transaction(() => {
            const row = this.db
                .prepare("SELECT last_scan_at FROM scan_channels WHERE workspace_key=? AND channel_key=?")
                .get(this.workspaceKey, input.channelKey);
            const current = text(row?.last_scan_at);
            const requested = text(input.lastScanAt);
            const lastScanAt = requested
                ? current ? laterTimestamp(current, requested) : requested
                : null;
            this.db
                .prepare(`INSERT INTO scan_channels(workspace_key, channel_key, session_key, display_name, kind, platform, group_id, last_scan_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_key, channel_key) DO UPDATE SET
             session_key=COALESCE(excluded.session_key, scan_channels.session_key),
             display_name=COALESCE(excluded.display_name, scan_channels.display_name),
             kind=COALESCE(excluded.kind, scan_channels.kind),
             platform=COALESCE(excluded.platform, scan_channels.platform),
             group_id=COALESCE(excluded.group_id, scan_channels.group_id),
             last_scan_at=COALESCE(excluded.last_scan_at, scan_channels.last_scan_at)`)
                .run(this.workspaceKey, input.channelKey, text(input.sessionKey), text(input.displayName), text(input.kind), text(input.platform), text(input.groupId), lastScanAt);
        });
    }
    setScanMeta(lastFullScanAt) {
        this.transaction(() => {
            const current = this.getScanMeta().lastFullScanAt;
            const requested = text(lastFullScanAt);
            const next = requested
                ? current ? laterTimestamp(current, requested) : requested
                : null;
            this.db
                .prepare(`INSERT INTO scan_meta(workspace_key, last_full_scan_at, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(workspace_key) DO UPDATE SET last_full_scan_at=excluded.last_full_scan_at, updated_at=excluded.updated_at`)
                .run(this.workspaceKey, next, nowIso());
        });
    }
    getScanMeta() {
        const row = this.db
            .prepare("SELECT * FROM scan_meta WHERE workspace_key=?")
            .get(this.workspaceKey);
        return {
            lastFullScanAt: row ? text(row.last_full_scan_at) : null,
            updatedAt: row ? text(row.updated_at) : null,
        };
    }
    // -------------------------------------------------------------------------
    // Counts
    // -------------------------------------------------------------------------
    counts() {
        const tables = [
            "accounts",
            "persons",
            "person_accounts",
            "groups",
            "group_members",
            "group_events",
            "group_observations",
            "impressions",
            "traits",
            "dimensions",
            "scan_channels",
        ];
        const result = {};
        for (const table of tables) {
            const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
            result[table] = number(row?.n);
        }
        return result;
    }
    hasLegacyJson() {
        const names = ["accounts.json", "groups.json", "persons.json", "person_accounts.json", "scan-state.json"];
        return names.some((name) => fs.existsSync(path.join(path.dirname(this.dbPath), name)));
    }
    parseStringArray(value) {
        if (Array.isArray(value))
            return value.filter((item) => typeof item === "string");
        if (typeof value !== "string" || !value.trim())
            return [];
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
        }
        catch {
            return [];
        }
    }
}
