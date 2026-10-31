import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./paths.js";
import { platformLookupKey } from "./platform.js";
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
export function newPersonId() {
    return `p_${crypto.randomBytes(4).toString("hex")}`;
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
        this.db.exec("PRAGMA journal_mode=WAL;");
        this.db.exec("PRAGMA busy_timeout=5000;");
        this.db.exec("PRAGMA foreign_keys=ON;");
        this.db.exec("PRAGMA synchronous=NORMAL;");
        this.db.exec(SCHEMA_SQL);
        this.migrate();
        this.ensureDefaultDimensions();
    }
    close() {
        this.db.close();
    }
    migrate() {
        const current = Number(this.metaGet("schema_version") ?? 0);
        this.ensureColumn("accounts", "call_name", "TEXT");
        this.ensureColumn("persons", "call_name", "TEXT");
        if (current < SCHEMA_VERSION) {
            this.metaSet("schema_version", String(SCHEMA_VERSION));
        }
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
    schemaVersion() {
        return Number(this.metaGet("schema_version") ?? 0);
    }
    // -------------------------------------------------------------------------
    // Accounts
    // -------------------------------------------------------------------------
    upsertAccount(input) {
        const platform = input.platform.trim();
        const senderId = input.senderId.trim();
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
                .run(accountId, platform, platformKey, senderId, displayName, text(input.currentRole), firstSeen, at, at);
            return {
                account: this.getAccount(accountId),
                created: true,
                displayNameChanged: Boolean(displayName),
            };
        }
        const changed = Boolean(displayName && displayName !== existing.display_name);
        this.db
            .prepare(`UPDATE accounts SET
           platform = ?,
           platform_key = ?,
           sender_id = ?,
           display_name = COALESCE(?, display_name),
           current_role = COALESCE(?, current_role),
           last_interaction = ?,
           updated_at = ?
         WHERE account_id = ?`)
            .run(platform, platformKey, senderId, displayName, text(input.currentRole), at, at, existing.account_id);
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
        this.db.prepare("DELETE FROM accounts WHERE account_id = ?").run(accountId);
    }
    setAccountRole(accountId, role) {
        this.db.prepare("UPDATE accounts SET current_role=?, updated_at=? WHERE account_id=?").run(role.trim(), nowIso(), accountId);
    }
    /** Move account-level data (impressions, traits, group memberships) from
     *  `sourceId` to `targetId`, then drop the source row. If the source was
     *  bound to a person and the target was not, the target inherits that person.
     *  Runs in one transaction.
     */
    mergeAccounts(sourceId, targetId) {
        const source = this.getAccount(sourceId);
        const target = this.getAccount(targetId);
        if (!source || !target)
            throw new Error(`账号不存在: ${sourceId} 或 ${targetId}`);
        if (source.account_id === target.account_id)
            throw new Error("源账号和目标账号不能相同");
        return this.transaction(() => {
            const impressions = number(this.db
                .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
             SELECT 'account', ?, content, dedupe_key, source, agent_id, created_at
             FROM impressions WHERE owner_type='account' AND owner_id=?`)
                .run(targetId, sourceId).changes);
            this.db.prepare("DELETE FROM impressions WHERE owner_type='account' AND owner_id=?").run(sourceId);
            const traits = number(this.db
                .prepare(`INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
             SELECT 'account', ?, dimension, value, confidence, updated_at
             FROM traits WHERE owner_type='account' AND owner_id=?`)
                .run(targetId, sourceId).changes);
            this.db.prepare("DELETE FROM traits WHERE owner_type='account' AND owner_id=?").run(sourceId);
            const groupMembers = number(this.db
                .prepare("UPDATE group_members SET account_id=? WHERE account_id=? AND group_id NOT IN (SELECT group_id FROM group_members WHERE account_id=?)")
                .run(targetId, sourceId, targetId).changes);
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
        const value = `%${query.trim()}%`;
        if (!query.trim())
            return [];
        const rows = this.db
            .prepare(`SELECT * FROM accounts
         WHERE account_id LIKE ? COLLATE NOCASE
            OR sender_id LIKE ? COLLATE NOCASE
            OR display_name LIKE ? COLLATE NOCASE
            OR confirmed_name LIKE ? COLLATE NOCASE
            OR call_name LIKE ? COLLATE NOCASE
         ORDER BY last_interaction DESC LIMIT ?`)
            .all(value, value, value, value, value, limit);
        return rows.map((row) => this.mapAccount(row));
    }
    listAllAccounts() {
        const rows = this.db.prepare("SELECT * FROM accounts ORDER BY last_interaction DESC").all();
        return rows.map((row) => this.mapAccount(row));
    }
    listAccountsBySender(senderId) {
        const rows = this.db
            .prepare("SELECT * FROM accounts WHERE sender_id=? ORDER BY last_interaction DESC")
            .all(senderId.trim());
        return rows.map((row) => this.mapAccount(row));
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
        const rows = this.db.prepare("SELECT * FROM persons ORDER BY updated_at DESC").all();
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
        const source = this.getPerson(sourcePersonId);
        const target = this.getPerson(targetPersonId);
        if (!source)
            throw new Error(`源人物不存在: ${sourcePersonId}`);
        if (!target)
            throw new Error(`目标人物不存在: ${targetPersonId}`);
        return this.transaction(() => {
            const impressions = number(this.db
                .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
             SELECT 'person', ?, content, dedupe_key, source, agent_id, created_at
             FROM impressions WHERE owner_type='person' AND owner_id=?`)
                .run(targetPersonId, sourcePersonId).changes);
            this.db
                .prepare("DELETE FROM impressions WHERE owner_type='person' AND owner_id=?")
                .run(sourcePersonId);
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
            this.db.prepare("DELETE FROM persons WHERE person_id=?").run(sourcePersonId);
            return { accounts, impressions, traits, deletedSource: true };
        });
    }
    unbindAccount(accountId, copyProfile = true) {
        const account = this.getAccount(accountId);
        if (!account)
            throw new Error(`账号不存在: ${accountId}`);
        const personId = account.bound_person_id;
        if (!personId)
            return { impressionsCopied: 0, traitsCopied: 0 };
        return this.transaction(() => {
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
        const value = `%${query.trim()}%`;
        const rows = this.db
            .prepare("SELECT * FROM persons WHERE person_id LIKE ? OR name LIKE ? OR call_name LIKE ? ORDER BY updated_at DESC LIMIT ?")
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
            if (options.migrate !== false) {
                impressionsMoved = number(this.db
                    .prepare(`INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
               SELECT 'person', ?, content, dedupe_key, source, agent_id, created_at
               FROM impressions WHERE owner_type='account' AND owner_id=?`)
                    .run(personId, accountId).changes);
                this.db
                    .prepare("DELETE FROM impressions WHERE owner_type='account' AND owner_id=?")
                    .run(accountId);
                traitsMoved = number(this.db
                    .prepare(`INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
               SELECT 'person', ?, dimension, value, confidence, updated_at
               FROM traits WHERE owner_type='account' AND owner_id=?`)
                    .run(personId, accountId).changes);
                this.db.prepare("DELETE FROM traits WHERE owner_type='account' AND owner_id=?").run(accountId);
            }
            this.db.prepare("UPDATE persons SET updated_at=? WHERE person_id=?").run(at, personId);
            return { impressionsMoved, traitsMoved };
        });
    }
    listPersonAccounts(personId) {
        const rows = this.db
            .prepare(`SELECT a.* FROM accounts a JOIN person_accounts pa ON pa.account_id = a.account_id
         WHERE pa.person_id = ? ORDER BY a.last_interaction DESC`)
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
            .prepare(`SELECT * FROM impressions WHERE owner_type=? AND owner_id=? ORDER BY created_at DESC, id DESC LIMIT ?`)
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
    countImpressions(ownerType, ownerId) {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n FROM impressions WHERE owner_type=? AND owner_id=?")
            .get(ownerType, ownerId);
        return number(row?.n);
    }
    removeImpressions(ownerType, ownerId, match) {
        const result = this.db
            .prepare("DELETE FROM impressions WHERE owner_type=? AND owner_id=? AND content LIKE ?")
            .run(ownerType, ownerId, `%${match.trim()}%`);
        return number(result.changes);
    }
    removeTraitsMatching(ownerType, ownerId, match) {
        const result = this.db
            .prepare("DELETE FROM traits WHERE owner_type=? AND owner_id=? AND value LIKE ?")
            .run(ownerType, ownerId, `%${match.trim()}%`);
        return number(result.changes);
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
        const value = `%${query.trim()}%`;
        if (!query.trim())
            return [];
        const rows = this.db
            .prepare("SELECT * FROM impressions WHERE content LIKE ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?")
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
        const value = `%${query.trim()}%`;
        if (!query.trim())
            return [];
        const rows = this.db
            .prepare("SELECT * FROM group_events WHERE summary LIKE ? COLLATE NOCASE ORDER BY occurred_at DESC LIMIT ?")
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
    }
    dump() {
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
        const data = {
            exported_at: nowIso(),
            schema_version: this.schemaVersion(),
        };
        for (const table of tables) {
            data[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
        }
        return data;
    }
    // -------------------------------------------------------------------------
    // Groups
    // -------------------------------------------------------------------------
    upsertGroup(input) {
        const platformKey = platformLookupKey(input.platform);
        const existing = this.getGroup(input.groupId) ?? this.findGroup(input.platform, input.chatId);
        const at = nowIso();
        const subject = text(input.subject);
        const displayName = text(input.displayName);
        if (!existing) {
            this.db
                .prepare(`INSERT INTO groups(group_id, platform, platform_key, chat_id, display_name, group_subject, bot_names, first_seen, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(input.groupId, input.platform, platformKey, input.chatId, displayName, subject, JSON.stringify(input.botNames ?? []), input.firstSeen?.trim() || at, at);
            return { group: this.getGroup(input.groupId), created: true, subjectChanged: Boolean(subject) };
        }
        const changed = Boolean(subject && subject !== existing.group_subject);
        this.db
            .prepare(`UPDATE groups SET
           platform=?, platform_key=?, chat_id=?,
           display_name=COALESCE(?, display_name),
           group_subject=COALESCE(?, group_subject),
           updated_at=?
         WHERE group_id=?`)
            .run(input.platform, platformKey, input.chatId, displayName, subject, at, existing.group_id);
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
            .prepare("SELECT * FROM groups WHERE chat_id=? ORDER BY updated_at DESC LIMIT 1")
            .get(chatId);
        return row ? this.mapGroup(row) : null;
    }
    /** All group rows sharing the same chat id, newest first (multi-backend independence). */
    findGroupsByChatAll(chatId) {
        const rows = this.db
            .prepare("SELECT * FROM groups WHERE chat_id=? ORDER BY updated_at DESC")
            .all(chatId.trim());
        return rows.map((row) => this.mapGroup(row));
    }
    listAllGroups() {
        const rows = this.db.prepare("SELECT * FROM groups ORDER BY updated_at DESC").all();
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
        const source = this.getGroup(sourceId);
        const target = this.getGroup(targetId);
        if (!source || !target)
            throw new Error("群不存在: " + sourceId + " 或 " + targetId);
        if (source.group_id === target.group_id)
            throw new Error("源群和目标群不能相同");
        return this.transaction(() => {
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
            const members = number(this.db
                .prepare("UPDATE group_members SET group_id=? " +
                "WHERE group_id=? AND account_id NOT IN (SELECT account_id FROM group_members WHERE group_id=?)")
                .run(targetId, sourceId, targetId).changes);
            this.db.prepare("DELETE FROM group_members WHERE group_id=?").run(sourceId);
            const botNames = [...new Set([...target.bot_names, ...source.bot_names])];
            this.db.prepare("UPDATE groups SET bot_names=? WHERE group_id=?").run(JSON.stringify(botNames), targetId);
            let subjectAdopted = false;
            if (!target.group_subject && source.group_subject) {
                this.db
                    .prepare("UPDATE groups SET group_subject=?, updated_at=? WHERE group_id=?")
                    .run(source.group_subject, nowIso(), targetId);
                subjectAdopted = true;
            }
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
            .prepare("SELECT * FROM group_events WHERE group_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?")
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
        this.db
            .prepare(`INSERT INTO group_members(group_id, account_id, display_name, classification, confidence, role_in_group, first_seen, last_seen)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, account_id) DO UPDATE SET
           display_name=COALESCE(excluded.display_name, group_members.display_name),
           classification=COALESCE(excluded.classification, group_members.classification),
           confidence=COALESCE(excluded.confidence, group_members.confidence),
           role_in_group=COALESCE(excluded.role_in_group, group_members.role_in_group),
           last_seen=excluded.last_seen`)
            .run(input.groupId, input.accountId, text(input.displayName), input.classification?.trim() || "pending", input.confidence?.trim() || "tentative", text(input.roleInGroup), at, at);
    }
    listGroupMembers(groupId, limit = 50) {
        const rows = this.db
            .prepare("SELECT * FROM group_members WHERE group_id=? ORDER BY last_seen DESC LIMIT ?")
            .all(groupId, limit);
        return rows.map((row) => ({
            group_id: String(row.group_id),
            account_id: String(row.account_id),
            display_name: text(row.display_name),
            classification: String(row.classification),
            confidence: String(row.confidence),
            role_in_group: text(row.role_in_group),
            first_seen: String(row.first_seen),
            last_seen: String(row.last_seen),
        }));
    }
    listAllGroupMembers() {
        const rows = this.db.prepare("SELECT * FROM group_members ORDER BY group_id, last_seen DESC").all();
        return rows.map((row) => ({
            group_id: String(row.group_id),
            account_id: String(row.account_id),
            display_name: text(row.display_name),
            classification: String(row.classification),
            confidence: String(row.confidence),
            role_in_group: text(row.role_in_group),
            first_seen: String(row.first_seen),
            last_seen: String(row.last_seen),
        }));
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
            .run(this.workspaceKey, input.channelKey, text(input.sessionKey), text(input.displayName), text(input.kind), text(input.platform), text(input.groupId), text(input.lastScanAt));
    }
    setScanMeta(lastFullScanAt) {
        this.db
            .prepare(`INSERT INTO scan_meta(workspace_key, last_full_scan_at, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(workspace_key) DO UPDATE SET last_full_scan_at=excluded.last_full_scan_at, updated_at=excluded.updated_at`)
            .run(this.workspaceKey, lastFullScanAt, nowIso());
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
