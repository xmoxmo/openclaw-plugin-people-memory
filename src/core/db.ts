import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./paths.js";
import { platformLookupKey } from "./platform.js";
import { SCHEMA_SQL, SCHEMA_VERSION, DEFAULT_DIMENSIONS } from "./schema.js";
import { nowIso } from "./time.js";
import type {
  AccountRecord,
  Dimension,
  GroupEvent,
  GroupMember,
  GroupRecord,
  Impression,
  PersonRecord,
  Trait,
} from "./types.js";

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

export function normalizeContent(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function contentKey(value: string): string {
  return crypto.createHash("sha256").update(normalizeContent(value)).digest("hex").slice(0, 32);
}

export function newPersonId(): string {
  return `p_${crypto.randomBytes(4).toString("hex")}`;
}

export class PeopleDatabase {
  readonly dbPath: string;
  readonly workspaceKey: string;
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(dbPath: string, workspaceKey = path.dirname(dbPath)) {
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

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = Number(this.metaGet("schema_version") ?? 0);
    this.ensureColumn("accounts", "call_name", "TEXT");
    this.ensureColumn("persons", "call_name", "TEXT");
    if (current < SCHEMA_VERSION) {
      this.metaSet("schema_version", String(SCHEMA_VERSION));
    }
  }

  private ensureColumn(table: "accounts" | "persons", column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `people_sp_${this.transactionDepth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = fn();
        this.db.exec(`RELEASE ${savepoint}`);
        this.transactionDepth -= 1;
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } catch {
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
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures
      }
      this.transactionDepth = 0;
      throw error;
    }
  }

  metaGet(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? text(row.value) : null;
  }

  metaSet(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  schemaVersion(): number {
    return Number(this.metaGet("schema_version") ?? 0);
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  upsertAccount(input: {
    platform: string;
    senderId: string;
    displayName?: string | null;
    currentRole?: string | null;
    firstSeen?: string;
    lastInteraction?: string;
  }): { account: AccountRecord; created: boolean; displayNameChanged: boolean } {
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
        .prepare(
          `INSERT INTO accounts(account_id, platform, platform_key, sender_id, display_name, current_role, first_seen, last_interaction, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          accountId,
          platform,
          platformKey,
          senderId,
          displayName,
          text(input.currentRole),
          firstSeen,
          at,
          at,
        );
      return {
        account: this.getAccount(accountId)!,
        created: true,
        displayNameChanged: Boolean(displayName),
      };
    }

    const changed = Boolean(displayName && displayName !== existing.display_name);
    this.db
      .prepare(
        `UPDATE accounts SET
           platform = ?,
           platform_key = ?,
           sender_id = ?,
           display_name = COALESCE(?, display_name),
           current_role = COALESCE(?, current_role),
           last_interaction = ?,
           updated_at = ?
         WHERE account_id = ?`,
      )
      .run(
        platform,
        platformKey,
        senderId,
        displayName,
        text(input.currentRole),
        at,
        at,
        existing.account_id,
      );
    return {
      account: this.getAccount(existing.account_id)!,
      created: false,
      displayNameChanged: changed,
    };
  }

  getAccount(accountId: string): AccountRecord | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId) as Row | undefined;
    return row ? this.mapAccount(row) : null;
  }

  getAccountByPlatformSender(platform: string, senderId: string): AccountRecord | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE platform_key = ? AND sender_id = ?")
      .get(platformLookupKey(platform), senderId) as Row | undefined;
    return row ? this.mapAccount(row) : null;
  }

  /** Drop one group membership row (a member that is not a tracked account). */
  removeGroupMember(groupId: string, accountId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM group_members WHERE group_id=? AND account_id=?")
      .run(groupId, accountId);
    return number(result.changes) > 0;
  }

  /** Delete a person and its bindings; refuses when the person still has data. */
  deletePerson(personId: string): boolean {
    const impressions = this.countImpressions("person", personId);
    const traits = this.getTraits("person", personId).length;
    const bindingRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM person_accounts WHERE person_id=?")
      .get(personId) as Row | undefined;
    const bindings = number(bindingRow?.c);
    if (impressions > 0 || traits > 0 || bindings > 0) return false;
    return this.transaction(() => {
      this.db.prepare("DELETE FROM persons WHERE person_id=?").run(personId);
      return true;
    });
  }

  deleteAccount(accountId: string): void {
    this.db.prepare("DELETE FROM accounts WHERE account_id = ?").run(accountId);
  }
  setAccountRole(accountId: string, role: string): void {
    this.db.prepare("UPDATE accounts SET current_role=?, updated_at=? WHERE account_id=?").run(role.trim(), nowIso(), accountId);
  }

  /** Move account-level data (impressions, traits, group memberships) from
   *  `sourceId` to `targetId`, then drop the source row. If the source was
   *  bound to a person and the target was not, the target inherits that person.
   *  Runs in one transaction.
   */
  mergeAccounts(sourceId: string, targetId: string): { impressions: number; traits: number; groupMembers: number; bindingMoved: boolean } {
    const source = this.getAccount(sourceId);
    const target = this.getAccount(targetId);
    if (!source || !target) throw new Error(`账号不存在: ${sourceId} 或 ${targetId}`);
    if (source.account_id === target.account_id) throw new Error("源账号和目标账号不能相同");
    return this.transaction(() => {
      const impressions = number(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
             SELECT 'account', ?, content, dedupe_key, source, agent_id, created_at
             FROM impressions WHERE owner_type='account' AND owner_id=?`,
          )
          .run(targetId, sourceId).changes,
      );
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

      const traits = number(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
             SELECT 'account', ?, dimension, value, confidence, updated_at
             FROM traits WHERE owner_type='account' AND owner_id=?`,
          )
          .run(targetId, sourceId).changes,
      );
      this.db.prepare("DELETE FROM traits WHERE owner_type='account' AND owner_id=?").run(sourceId);

      const groupMembers = number(
        this.db
          .prepare(
            "UPDATE group_members SET account_id=? WHERE account_id=? AND group_id NOT IN (SELECT group_id FROM group_members WHERE account_id=?)",
          )
          .run(targetId, sourceId, targetId).changes,
      );
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

  searchAccounts(query: string, limit = 10): AccountRecord[] {
    const value = `%${query.trim()}%`;
    if (!query.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM accounts
         WHERE account_id LIKE ? COLLATE NOCASE
            OR sender_id LIKE ? COLLATE NOCASE
            OR display_name LIKE ? COLLATE NOCASE
            OR confirmed_name LIKE ? COLLATE NOCASE
            OR call_name LIKE ? COLLATE NOCASE
         ORDER BY last_interaction DESC LIMIT ?`,
      )
      .all(value, value, value, value, value, limit) as Row[];
    return rows.map((row) => this.mapAccount(row));
  }

  listAllAccounts(): AccountRecord[] {
    const rows = this.db.prepare("SELECT * FROM accounts ORDER BY last_interaction DESC").all() as Row[];
    return rows.map((row) => this.mapAccount(row));
  }
  listAccountsBySender(senderId: string): AccountRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts WHERE sender_id=? ORDER BY last_interaction DESC")
      .all(senderId.trim()) as Row[];
    return rows.map((row) => this.mapAccount(row));
  }

  listAllPersonAccounts(): Array<{
    account_id: string;
    person_id: string;
    bind_method: string;
    confidence: string;
    bound_at: string;
  }> {
    const rows = this.db.prepare("SELECT * FROM person_accounts ORDER BY bound_at").all() as Row[];
    return rows.map((row) => ({
      account_id: String(row.account_id),
      person_id: String(row.person_id),
      bind_method: String(row.bind_method),
      confidence: String(row.confidence),
      bound_at: String(row.bound_at),
    }));
  }

  setConfirmedName(accountId: string, name: string): void {
    const at = nowIso();
    this.db
      .prepare("UPDATE accounts SET confirmed_name = ?, updated_at = ? WHERE account_id = ?")
      .run(name.trim(), at, accountId);
  }

  setCallName(accountId: string, name: string): void {
    const at = nowIso();
    this.db
      .prepare("UPDATE accounts SET call_name = ?, updated_at = ? WHERE account_id = ?")
      .run(name.trim(), at, accountId);
  }

  touchAccount(accountId: string, at = nowIso()): void {
    this.db
      .prepare("UPDATE accounts SET last_interaction = ?, updated_at = ? WHERE account_id = ?")
      .run(at, at, accountId);
  }

  private mapAccount(row: Row): AccountRecord {
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

  createPerson(input: { name?: string | null; personId?: string; notes?: string | null; createdAt?: string } = {}): PersonRecord {
    const personId = input.personId?.trim() || newPersonId();
    const at = input.createdAt?.trim() || nowIso();
    this.db
      .prepare("INSERT OR IGNORE INTO persons(person_id, name, notes, created_at, updated_at) VALUES(?, ?, ?, ?, ?)")
      .run(personId, text(input.name), text(input.notes), at, at);
    return this.getPerson(personId)!;
  }

  getPerson(personId: string): PersonRecord | null {
    const row = this.db.prepare("SELECT * FROM persons WHERE person_id = ?").get(personId) as Row | undefined;
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

  listAllPersons(): PersonRecord[] {
    const rows = this.db.prepare("SELECT * FROM persons ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => ({
      person_id: String(row.person_id),
      name: text(row.name),
      call_name: text(row.call_name),
      notes: text(row.notes),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));
  }

  mergePersons(
    sourcePersonId: string,
    targetPersonId: string,
  ): {
    accounts: number;
    impressions: number;
    traits: number;
    deletedSource: boolean;
  } {
    if (sourcePersonId === targetPersonId) throw new Error("源人物和目标人物不能相同。");
    const source = this.getPerson(sourcePersonId);
    const target = this.getPerson(targetPersonId);
    if (!source) throw new Error(`源人物不存在: ${sourcePersonId}`);
    if (!target) throw new Error(`目标人物不存在: ${targetPersonId}`);

    return this.transaction(() => {
      const impressions = number(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
             SELECT 'person', ?, content, dedupe_key, source, agent_id, created_at
             FROM impressions WHERE owner_type='person' AND owner_id=?`,
          )
          .run(targetPersonId, sourcePersonId).changes,
      );
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

      const traits = number(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
             SELECT 'person', ?, dimension, value, confidence, updated_at
             FROM traits WHERE owner_type='person' AND owner_id=?`,
          )
          .run(targetPersonId, sourcePersonId).changes,
      );
      this.db.prepare("DELETE FROM traits WHERE owner_type='person' AND owner_id=?").run(sourcePersonId);

      const accounts = number(
        this.db
          .prepare("UPDATE OR REPLACE person_accounts SET person_id=?, bound_at=? WHERE person_id=?")
          .run(targetPersonId, nowIso(), sourcePersonId).changes,
      );
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

  unbindAccount(accountId: string, copyProfile = true): { impressionsCopied: number; traitsCopied: number } {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    const personId = account.bound_person_id;
    if (!personId) return { impressionsCopied: 0, traitsCopied: 0 };

    return this.transaction(() => {
      let impressionsCopied = 0;
      let traitsCopied = 0;
      if (copyProfile) {
        impressionsCopied = number(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
               SELECT 'account', ?, content, dedupe_key, source, agent_id, created_at
               FROM impressions WHERE owner_type='person' AND owner_id=?`,
            )
            .run(accountId, personId).changes,
        );
        traitsCopied = number(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
               SELECT 'account', ?, dimension, value, confidence, updated_at
               FROM traits WHERE owner_type='person' AND owner_id=?`,
            )
            .run(accountId, personId).changes,
        );
      }
      this.db.prepare("DELETE FROM person_accounts WHERE account_id=?").run(accountId);
      this.db
        .prepare("UPDATE accounts SET bound_person_id=NULL, updated_at=? WHERE account_id=?")
        .run(nowIso(), accountId);
      return { impressionsCopied, traitsCopied };
    });
  }

  updatePerson(
    personId: string,
    input: { name?: string | null; callName?: string | null; notes?: string | null },
  ): void {
    const at = nowIso();
    this.db
      .prepare(
        "UPDATE persons SET name = COALESCE(?, name), call_name = COALESCE(?, call_name), notes = COALESCE(?, notes), updated_at = ? WHERE person_id = ?",
      )
      .run(text(input.name), text(input.callName), text(input.notes), at, personId);
  }

  searchPersons(query: string, limit = 10): PersonRecord[] {
    const value = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        "SELECT * FROM persons WHERE person_id LIKE ? OR name LIKE ? OR call_name LIKE ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(value, value, value, limit) as Row[];
    return rows.map((row) => ({
      person_id: String(row.person_id),
      name: text(row.name),
      call_name: text(row.call_name),
      notes: text(row.notes),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));
  }

  bindAccount(
    accountId: string,
    personId: string,
    options: { method?: string; confidence?: string; migrate?: boolean } = {},
  ): { impressionsMoved: number; traitsMoved: number } {
    const at = nowIso();
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO person_accounts(account_id, person_id, bind_method, confidence, bound_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             person_id=excluded.person_id,
             bind_method=excluded.bind_method,
             confidence=excluded.confidence,
             bound_at=excluded.bound_at`,
        )
        .run(accountId, personId, options.method ?? "manual", options.confidence ?? "confirmed", at);
      this.db
        .prepare("UPDATE accounts SET bound_person_id = ?, updated_at = ? WHERE account_id = ?")
        .run(personId, at, accountId);

      let impressionsMoved = 0;
      let traitsMoved = 0;
      if (options.migrate !== false) {
        impressionsMoved = number(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
               SELECT 'person', ?, content, dedupe_key, source, agent_id, created_at
               FROM impressions WHERE owner_type='account' AND owner_id=?`,
            )
            .run(personId, accountId).changes,
        );
        this.db
          .prepare("DELETE FROM impressions WHERE owner_type='account' AND owner_id=?")
          .run(accountId);

        traitsMoved = number(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
               SELECT 'person', ?, dimension, value, confidence, updated_at
               FROM traits WHERE owner_type='account' AND owner_id=?`,
            )
            .run(personId, accountId).changes,
        );
        this.db.prepare("DELETE FROM traits WHERE owner_type='account' AND owner_id=?").run(accountId);
      }
      this.db.prepare("UPDATE persons SET updated_at=? WHERE person_id=?").run(at, personId);
      return { impressionsMoved, traitsMoved };
    });
  }

  listPersonAccounts(personId: string): AccountRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM accounts a JOIN person_accounts pa ON pa.account_id = a.account_id
         WHERE pa.person_id = ? ORDER BY a.last_interaction DESC`,
      )
      .all(personId) as Row[];
    return rows.map((row) => this.mapAccount(row));
  }

  // -------------------------------------------------------------------------
  // Traits and impressions
  // -------------------------------------------------------------------------

  setTrait(
    ownerType: "account" | "person",
    ownerId: string,
    dimension: string,
    value: string,
    confidence: string | null = null,
  ): void {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO traits(owner_type, owner_id, dimension, value, confidence, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_type, owner_id, dimension) DO UPDATE SET
           value=excluded.value, confidence=excluded.confidence, updated_at=excluded.updated_at`,
      )
      .run(ownerType, ownerId, dimension, value.trim(), confidence, at);
    if (ownerType === "person") {
      this.db.prepare("UPDATE persons SET updated_at=? WHERE person_id=?").run(at, ownerId);
    }
  }

  getTraits(ownerType: "account" | "person", ownerId: string): Trait[] {
    const rows = this.db
      .prepare(
        `SELECT t.dimension, t.value, t.confidence, t.updated_at, d.sort
         FROM traits t LEFT JOIN dimensions d ON d.key = t.dimension
         WHERE t.owner_type=? AND t.owner_id=?
         ORDER BY COALESCE(d.sort, 999), t.dimension`,
      )
      .all(ownerType, ownerId) as Row[];
    return rows.map((row) => ({
      dimension: String(row.dimension),
      value: String(row.value),
      confidence: text(row.confidence),
      updated_at: String(row.updated_at),
    }));
  }

  addImpression(input: {
    ownerType: "account" | "person";
    ownerId: string;
    content: string;
    source?: string | null;
    agentId?: string | null;
    createdAt?: string;
  }): boolean {
    const content = input.content.trim();
    if (!content) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO impressions(owner_type, owner_id, content, dedupe_key, source, agent_id, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerType,
        input.ownerId,
        content,
        contentKey(content),
        text(input.source),
        text(input.agentId),
        input.createdAt ?? nowIso(),
      );
    return number(result.changes) > 0;
  }

  listImpressions(ownerType: "account" | "person", ownerId: string, limit = 50): Impression[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM impressions WHERE owner_type=? AND owner_id=? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(ownerType, ownerId, limit) as Row[];
    return rows.map((row) => ({
      id: number(row.id),
      owner_type: String(row.owner_type) as "account" | "person",
      owner_id: String(row.owner_id),
      content: String(row.content),
      source: text(row.source),
      agent_id: text(row.agent_id),
      created_at: String(row.created_at),
    }));
  }

  countImpressions(ownerType: "account" | "person", ownerId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM impressions WHERE owner_type=? AND owner_id=?")
      .get(ownerType, ownerId) as Row | undefined;
    return number(row?.n);
  }

  removeImpressions(ownerType: "account" | "person", ownerId: string, match: string): number {
    const result = this.db
      .prepare("DELETE FROM impressions WHERE owner_type=? AND owner_id=? AND content LIKE ?")
      .run(ownerType, ownerId, `%${match.trim()}%`);
    return number(result.changes);
  }

  removeImpressionsByIds(
    ownerType: "account" | "person",
    ownerId: string,
    ids: number[],
  ): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `DELETE FROM impressions WHERE owner_type=? AND owner_id=? AND id IN (${placeholders})`,
      )
      .run(ownerType, ownerId, ...ids);
    return number(result.changes);
  }

  removeTraitsMatching(ownerType: "account" | "person", ownerId: string, match: string): number {
    const result = this.db
      .prepare("DELETE FROM traits WHERE owner_type=? AND owner_id=? AND value LIKE ?")
      .run(ownerType, ownerId, `%${match.trim()}%`);
    return number(result.changes);
  }

  listAllTraits(): Array<Trait & { owner_type: "account" | "person"; owner_id: string }> {
    const rows = this.db.prepare("SELECT * FROM traits ORDER BY owner_type, owner_id, dimension").all() as Row[];
    return rows.map((row) => ({
      owner_type: String(row.owner_type) as "account" | "person",
      owner_id: String(row.owner_id),
      dimension: String(row.dimension),
      value: String(row.value),
      confidence: text(row.confidence),
      updated_at: String(row.updated_at),
    }));
  }

  profileStats(limit = 20): Array<{
    owner_type: "account" | "person";
    owner_id: string;
    impressions: number;
    oldest: string;
    newest: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT owner_type, owner_id, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
         FROM impressions GROUP BY owner_type, owner_id ORDER BY n DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({
      owner_type: String(row.owner_type) as "account" | "person",
      owner_id: String(row.owner_id),
      impressions: number(row.n),
      oldest: String(row.oldest),
      newest: String(row.newest),
    }));
  }

  searchImpressions(query: string, limit = 10): Impression[] {
    const value = `%${query.trim()}%`;
    if (!query.trim()) return [];
    const rows = this.db
      .prepare("SELECT * FROM impressions WHERE content LIKE ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?")
      .all(value, limit) as Row[];
    return rows.map((row) => ({
      id: number(row.id),
      owner_type: String(row.owner_type) as "account" | "person",
      owner_id: String(row.owner_id),
      content: String(row.content),
      source: text(row.source),
      agent_id: text(row.agent_id),
      created_at: String(row.created_at),
    }));
  }

  searchGroupEvents(query: string, limit = 10): GroupEvent[] {
    const value = `%${query.trim()}%`;
    if (!query.trim()) return [];
    const rows = this.db
      .prepare("SELECT * FROM group_events WHERE summary LIKE ? COLLATE NOCASE ORDER BY occurred_at DESC LIMIT ?")
      .all(value, limit) as Row[];
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

  backupTo(file: string): void {
    ensureDir(path.dirname(file));
    if (fs.existsSync(file)) throw new Error(`备份文件已存在: ${file}`);
    this.db.exec("PRAGMA wal_checkpoint(FULL);");
    const escaped = file.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  /** Erase deleted pages from the live database and truncate the WAL. */
  purgeStorage(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.exec("VACUUM;");
  }

  dump(): Record<string, unknown> {
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
    const data: Record<string, unknown> = {
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

  upsertGroup(input: {
    groupId: string;
    platform: string;
    chatId: string;
    displayName?: string | null;
    subject?: string | null;
    botNames?: string[];
    firstSeen?: string;
  }): { group: GroupRecord; created: boolean; subjectChanged: boolean } {
    const platformKey = platformLookupKey(input.platform);
    const existing = this.getGroup(input.groupId) ?? this.findGroup(input.platform, input.chatId);
    const at = nowIso();
    const subject = text(input.subject);
    const displayName = text(input.displayName);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO groups(group_id, platform, platform_key, chat_id, display_name, group_subject, bot_names, first_seen, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.groupId,
          input.platform,
          platformKey,
          input.chatId,
          displayName,
          subject,
          JSON.stringify(input.botNames ?? []),
          input.firstSeen?.trim() || at,
          at,
        );
      return { group: this.getGroup(input.groupId)!, created: true, subjectChanged: Boolean(subject) };
    }

    const changed = Boolean(subject && subject !== existing.group_subject);
    this.db
      .prepare(
        `UPDATE groups SET
           platform=?, platform_key=?, chat_id=?,
           display_name=COALESCE(?, display_name),
           group_subject=COALESCE(?, group_subject),
           updated_at=?
         WHERE group_id=?`,
      )
      .run(input.platform, platformKey, input.chatId, displayName, subject, at, existing.group_id);
    return {
      group: this.getGroup(existing.group_id)!,
      created: false,
      subjectChanged: changed,
    };
  }

  getGroup(groupId: string): GroupRecord | null {
    const row = this.db.prepare("SELECT * FROM groups WHERE group_id=?").get(groupId) as Row | undefined;
    return row ? this.mapGroup(row) : null;
  }

  findGroup(platform: string, chatId: string): GroupRecord | null {
    const row = this.db
      .prepare("SELECT * FROM groups WHERE platform_key=? AND chat_id=?")
      .get(platformLookupKey(platform), chatId) as Row | undefined;
    return row ? this.mapGroup(row) : null;
  }

  findGroupByChat(chatId: string): GroupRecord | null {
    const row = this.db
      .prepare("SELECT * FROM groups WHERE chat_id=? ORDER BY updated_at DESC LIMIT 1")
      .get(chatId) as Row | undefined;
    return row ? this.mapGroup(row) : null;
  }
  /** All group rows sharing the same chat id, newest first (multi-backend independence). */
  findGroupsByChatAll(chatId: string): GroupRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM groups WHERE chat_id=? ORDER BY updated_at DESC")
      .all(chatId.trim()) as Row[];
    return rows.map((row) => this.mapGroup(row));
  }

  listAllGroups(): GroupRecord[] {
    const rows = this.db.prepare("SELECT * FROM groups ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => this.mapGroup(row));
  }

  updateGroupSubject(groupId: string, subject: string): void {
    const at = nowIso();
    this.db
      .prepare("UPDATE groups SET group_subject=?, updated_at=? WHERE group_id=?")
      .run(subject.trim(), at, groupId);
  }

  setGroupBotNames(groupId: string, names: string[]): void {
    this.db.prepare("UPDATE groups SET bot_names=? WHERE group_id=?").run(JSON.stringify(names), groupId);
  }
  countGroupEvents(groupId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM group_events WHERE group_id=?").get(groupId) as Row | undefined;
    return number(row?.n ?? 0);
  }

  countGroupMembers(groupId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id=?").get(groupId) as Row | undefined;
    return number(row?.n ?? 0);
  }

  mergeGroups(sourceId: string, targetId: string): {
    events: number;
    members: number;
    observations: number;
    botNames: string[];
    subjectAdopted: boolean;
  } {
    const source = this.getGroup(sourceId);
    const target = this.getGroup(targetId);
    if (!source || !target) throw new Error("群不存在: " + sourceId + " 或 " + targetId);
    if (source.group_id === target.group_id) throw new Error("源群和目标群不能相同");
    return this.transaction(() => {
      const events = number(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO group_events(group_id, occurred_at, category, summary, tags, agent_id, dedupe_key, created_at) " +
            "SELECT ?, occurred_at, category, summary, tags, agent_id, dedupe_key, created_at FROM group_events WHERE group_id=?",
          )
          .run(targetId, sourceId).changes,
      );
      this.db.prepare("DELETE FROM group_events WHERE group_id=?").run(sourceId);
      const observations = number(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO group_observations(group_id, content, dedupe_key, created_at) " +
            "SELECT ?, content, dedupe_key, created_at FROM group_observations WHERE group_id=?",
          )
          .run(targetId, sourceId).changes,
      );
      this.db.prepare("DELETE FROM group_observations WHERE group_id=?").run(sourceId);
      const members = number(
        this.db
          .prepare(
            "UPDATE group_members SET group_id=? " +
            "WHERE group_id=? AND account_id NOT IN (SELECT account_id FROM group_members WHERE group_id=?)",
          )
          .run(targetId, sourceId, targetId).changes,
      );
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

  addGroupEvent(input: {
    groupId: string;
    summary: string;
    category?: string;
    tags?: string[];
    agentId?: string | null;
    occurredAt?: string;
  }): boolean {
    const summary = input.summary.trim();
    if (!summary) return false;
    const occurredAt = input.occurredAt ?? nowIso();
    const dedupe = contentKey(`${occurredAt.slice(0, 10)}:${summary}`);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO group_events(group_id, occurred_at, category, summary, tags, agent_id, dedupe_key, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.groupId,
        occurredAt,
        input.category?.trim() || "observation",
        summary,
        JSON.stringify(input.tags ?? []),
        text(input.agentId),
        dedupe,
        nowIso(),
      );
    if (number(result.changes) > 0) {
      this.db.prepare("UPDATE groups SET updated_at=? WHERE group_id=?").run(nowIso(), input.groupId);
      return true;
    }
    return false;
  }

  listGroupEvents(groupId: string, limit = 10): GroupEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM group_events WHERE group_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(groupId, limit) as Row[];
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

  addGroupObservation(groupId: string, content: string): boolean {
    const value = content.trim();
    if (!value) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO group_observations(group_id, content, dedupe_key, created_at)
         VALUES(?, ?, ?, ?)`,
      )
      .run(groupId, value, contentKey(value), nowIso());
    return number(result.changes) > 0;
  }

  upsertGroupMember(input: {
    groupId: string;
    accountId: string;
    displayName?: string | null;
    classification?: string;
    confidence?: string;
    roleInGroup?: string | null;
    at?: string;
  }): void {
    const at = input.at ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO group_members(group_id, account_id, display_name, classification, confidence, role_in_group, first_seen, last_seen)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, account_id) DO UPDATE SET
           display_name=COALESCE(excluded.display_name, group_members.display_name),
           classification=COALESCE(excluded.classification, group_members.classification),
           confidence=COALESCE(excluded.confidence, group_members.confidence),
           role_in_group=COALESCE(excluded.role_in_group, group_members.role_in_group),
           last_seen=excluded.last_seen`,
      )
      .run(
        input.groupId,
        input.accountId,
        text(input.displayName),
        input.classification?.trim() || "pending",
        input.confidence?.trim() || "tentative",
        text(input.roleInGroup),
        at,
        at,
      );
  }

  listGroupMembers(groupId: string, limit = 50): GroupMember[] {
    const rows = this.db
      .prepare("SELECT * FROM group_members WHERE group_id=? ORDER BY last_seen DESC LIMIT ?")
      .all(groupId, limit) as Row[];
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

  listAllGroupMembers(): GroupMember[] {
    const rows = this.db.prepare("SELECT * FROM group_members ORDER BY group_id, last_seen DESC").all() as Row[];
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

  private mapGroup(row: Row): GroupRecord {
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

  ensureDefaultDimensions(): void {
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO dimensions(key, label, active, sort) VALUES(?, ?, 1, ?)",
    );
    for (const dimension of DEFAULT_DIMENSIONS) {
      statement.run(dimension.key, dimension.label, dimension.sort);
    }
  }

  upsertDimension(key: string, label: string, active: boolean, sort = 999): void {
    this.db
      .prepare(
        `INSERT INTO dimensions(key, label, active, sort) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET label=excluded.label, active=excluded.active, sort=excluded.sort`,
      )
      .run(key.trim(), label.trim(), active ? 1 : 0, sort);
  }

  listDimensions(): Dimension[] {
    const rows = this.db.prepare("SELECT * FROM dimensions ORDER BY sort, key").all() as Row[];
    return rows.map((row) => ({
      key: String(row.key),
      label: String(row.label),
      active: number(row.active) !== 0,
      sort: number(row.sort),
    }));
  }

  getDimension(key: string): Dimension | null {
    const row = this.db.prepare("SELECT * FROM dimensions WHERE key=?").get(key) as Row | undefined;
    if (!row) return null;
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

  upsertScanChannel(input: {
    channelKey: string;
    sessionKey?: string | null;
    displayName?: string | null;
    kind?: string | null;
    platform?: string | null;
    groupId?: string | null;
    lastScanAt?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO scan_channels(workspace_key, channel_key, session_key, display_name, kind, platform, group_id, last_scan_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_key, channel_key) DO UPDATE SET
           session_key=COALESCE(excluded.session_key, scan_channels.session_key),
           display_name=COALESCE(excluded.display_name, scan_channels.display_name),
           kind=COALESCE(excluded.kind, scan_channels.kind),
           platform=COALESCE(excluded.platform, scan_channels.platform),
           group_id=COALESCE(excluded.group_id, scan_channels.group_id),
           last_scan_at=COALESCE(excluded.last_scan_at, scan_channels.last_scan_at)`,
      )
      .run(
        this.workspaceKey,
        input.channelKey,
        text(input.sessionKey),
        text(input.displayName),
        text(input.kind),
        text(input.platform),
        text(input.groupId),
        text(input.lastScanAt),
      );
  }

  setScanMeta(lastFullScanAt: string | null): void {
    this.db
      .prepare(
        `INSERT INTO scan_meta(workspace_key, last_full_scan_at, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(workspace_key) DO UPDATE SET last_full_scan_at=excluded.last_full_scan_at, updated_at=excluded.updated_at`,
      )
      .run(this.workspaceKey, lastFullScanAt, nowIso());
  }

  getScanMeta(): { lastFullScanAt: string | null; updatedAt: string | null } {
    const row = this.db
      .prepare("SELECT * FROM scan_meta WHERE workspace_key=?")
      .get(this.workspaceKey) as Row | undefined;
    return {
      lastFullScanAt: row ? text(row.last_full_scan_at) : null,
      updatedAt: row ? text(row.updated_at) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Counts
  // -------------------------------------------------------------------------

  counts(): Record<string, number> {
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
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row | undefined;
      result[table] = number(row?.n);
    }
    return result;
  }

  hasLegacyJson(): boolean {
    const names = ["accounts.json", "groups.json", "persons.json", "person_accounts.json", "scan-state.json"];
    return names.some((name) => fs.existsSync(path.join(path.dirname(this.dbPath), name)));
  }

  private parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
}
