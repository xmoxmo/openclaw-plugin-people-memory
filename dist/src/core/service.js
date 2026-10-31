import fs from "node:fs";
import path from "node:path";
import { PeopleDatabase, newPersonId } from "./db.js";
import { importLegacyJson } from "./legacy.js";
import { groupKey, normalizePlatform } from "./platform.js";
import { ensureDir } from "./paths.js";
import { SCHEMA_VERSION } from "./schema.js";
import { nowIso } from "./time.js";
const DEFAULT_LOGGER = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
};
/** Sender ids that never become people (system/cron/scrollback auto-rows). */
const DEFAULT_CAPTURE_SKIP_SENDERS = [
    "^bncr-history-system$",
    "^history-system$",
    "^system:",
    "^cron$",
];
const DEFAULT_MULTI_ACCOUNT_CHANNELS = ["bncr"];
/** Same-sender family pairs: one human on two accesses of the same platform. */
const DEFAULT_SENDER_FAMILIES = [["bncr/GewePlus", "bncr/GolemPlus"]];
function truncate(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
export class PeopleService {
    db;
    paths;
    config;
    logger;
    constructor(input) {
        this.paths = input.paths;
        this.config = input.config ?? {};
        this.logger = input.logger ?? DEFAULT_LOGGER;
        ensureDir(this.paths.dataDir);
        this.db = new PeopleDatabase(this.paths.dbPath, this.paths.workspaceKey);
        if (this.config.importLegacy !== false) {
            try {
                const report = importLegacyJson(this.db);
                if (report.imported) {
                    this.logger.info(`[people] legacy imported: accounts=${report.accounts} persons=${report.persons} groups=${report.groups}`);
                }
            }
            catch (error) {
                this.logger.warn(`[people] legacy import failed: ${error.message}`);
            }
        }
    }
    close() {
        this.db.close();
    }
    importLegacy(force = false) {
        if (this.config.importLegacy === false) {
            throw new Error("当前配置已禁用旧 JSON 导入（importLegacy=false）。");
        }
        return importLegacyJson(this.db, { force });
    }
    // -------------------------------------------------------------------------
    // Identity capture
    // -------------------------------------------------------------------------
    capture(input) {
        const platform = normalizePlatform(input.platform);
        const senderId = input.senderId.trim();
        const skipped = this.isSkippedSender(senderId);
        const target = this.resolveWriteTarget(platform, senderId);
        const writePlatform = target.kind === "direct" ? target.platform : platform;
        let accountId = null;
        let created = false;
        let displayNameChanged = false;
        if (!skipped && target.kind !== "deferred") {
            const accountResult = this.db.upsertAccount({
                platform: writePlatform,
                senderId,
                displayName: input.senderName,
                currentRole: input.role,
            });
            accountId = accountResult.account.account_id;
            created = accountResult.created;
            displayNameChanged = accountResult.displayNameChanged;
            // Same-sender family rows (GewePlus + GolemPlus) collapse to one person.
            try {
                this.syncFamilyBinding(senderId);
            }
            catch (error) {
                this.logger.warn(`[people] family binding failed for ${senderId}: ${error.message}`);
            }
        }
        let groupId;
        let groupCreated;
        if (this.config.captureGroups !== false && input.chatId?.trim()) {
            const chatId = input.chatId.trim();
            const existing = this.db.findGroup(writePlatform, chatId) ??
                // A bare channel label has no backend of its own. When exactly one
                // backend row exists for this chat, its subject is kept in sync; no row
                // is created and no member is added, so backend records stay separate.
                (target.kind === "deferred" ? this.soleBackendGroup(chatId) : null);
            if (existing) {
                groupId = existing.group_id;
                if (input.chatTitle?.trim() && input.chatTitle.trim() !== existing.group_subject) {
                    this.db.updateGroupSubject(existing.group_id, input.chatTitle.trim());
                }
                if (!skipped && accountId) {
                    this.db.upsertGroupMember({
                        groupId: existing.group_id,
                        accountId,
                        displayName: input.senderName,
                    });
                }
            }
            else if (input.isGroup && target.kind !== "deferred") {
                const createdGroup = this.db.upsertGroup({
                    groupId: groupKey(writePlatform, chatId),
                    platform: writePlatform,
                    chatId,
                    displayName: input.chatTitle?.trim() || chatId,
                    subject: input.chatTitle?.trim() || null,
                });
                groupId = createdGroup.group.group_id;
                groupCreated = createdGroup.created;
                if (!skipped && accountId) {
                    this.db.upsertGroupMember({
                        groupId,
                        accountId,
                        displayName: input.senderName,
                    });
                }
            }
        }
        return {
            accountId,
            created,
            displayNameChanged,
            groupId,
            groupCreated,
        };
    }
    resolveAccount(ref) {
        const value = ref.trim();
        if (!value)
            return null;
        const direct = this.db.getAccount(value);
        if (direct)
            return direct;
        const matches = this.db.searchAccounts(value, 2);
        if (matches.length === 1)
            return matches[0] ?? null;
        return null;
    }
    searchAccounts(ref) {
        const direct = this.db.searchAccounts(ref, 10);
        if (direct.length > 0)
            return direct;
        // Channel-style refs ("bncr:GewePlus:<sender>") map to canonical ids
        // ("bncr/GewePlus:<sender>").
        const parts = ref.split(":");
        if (parts.length >= 3 && parts[0] && parts[1]) {
            return this.db.searchAccounts(`${parts[0]}/${parts[1]}:${parts.slice(2).join(":")}`, 10);
        }
        return direct;
    }
    snapshot(accountId) {
        const account = this.db.getAccount(accountId);
        if (!account)
            return null;
        const person = account.bound_person_id ? this.db.getPerson(account.bound_person_id) : null;
        const ownerType = person ? "person" : "account";
        const ownerId = person ? person.person_id : account.account_id;
        return {
            ownerType,
            ownerId,
            account,
            person,
            displayName: person?.call_name ||
                account.call_name ||
                person?.name ||
                account.confirmed_name ||
                account.display_name ||
                account.account_id,
            traits: this.db.getTraits(ownerType, ownerId),
            impressions: this.db.listImpressions(ownerType, ownerId, 20),
        };
    }
    personSnapshot(personId) {
        const person = this.db.getPerson(personId);
        if (!person)
            return null;
        return {
            ownerType: "person",
            ownerId: person.person_id,
            account: null,
            person,
            displayName: person.call_name || person.name || person.person_id,
            traits: this.db.getTraits("person", person.person_id),
            impressions: this.db.listImpressions("person", person.person_id, 20),
        };
    }
    profileTarget(input) {
        const personId = input.personId?.trim();
        if (personId) {
            const snapshot = this.personSnapshot(personId);
            if (!snapshot)
                throw new Error(`人物不存在: ${personId}`);
            return snapshot;
        }
        const accountId = input.accountId?.trim();
        if (!accountId)
            throw new Error("需要提供 accountId 或 personId");
        const snapshot = this.snapshot(accountId);
        if (!snapshot)
            throw new Error(`账号不存在: ${accountId}`);
        return snapshot;
    }
    // -------------------------------------------------------------------------
    // Prompt context
    // -------------------------------------------------------------------------
    contextCard(input) {
        const snapshot = this.snapshot(input.accountId);
        if (!snapshot)
            return "";
        const dimensions = new Map(this.db.listDimensions().map((dimension) => [dimension.key, dimension]));
        const traits = snapshot.traits
            .filter((trait) => !dimensions.get(trait.dimension) || dimensions.get(trait.dimension)?.active)
            .slice(0, 7)
            .map((trait) => `${dimensions.get(trait.dimension)?.label ?? trait.dimension}=${trait.value}`);
        const lines = ["<people_context>"];
        lines.push(`当前对象：${snapshot.displayName}（${snapshot.account.platform}）`);
        if (traits.length > 0)
            lines.push(`画像：${traits.join("；")}`);
        if (snapshot.person?.notes)
            lines.push(`备注：${snapshot.person.notes}`);
        const impressionCount = this.db.countImpressions(snapshot.ownerType, snapshot.ownerId);
        if (impressionCount > 12) {
            lines.push(`维护待办：本画像有 ${impressionCount} 条零散印象。与当前人物相关时，先用 people_remember { dimension, mode: "replace" } 归并到 traits，再用 people_forget { scope: "impressions" } 删除被替代的原文，避免误删 traits；不要向用户提及。`);
        }
        if (input.includeGroupMemory !== false && input.groupId) {
            const group = this.db.getGroup(input.groupId);
            if (group) {
                lines.push(`群：${group.group_subject || group.display_name || group.chat_id}`);
                const events = this.db.listGroupEvents(group.group_id, 4);
                if (events.length > 0) {
                    lines.push(`群记忆：${events
                        .map((event) => `${event.occurred_at.slice(0, 10)} ${event.summary}`)
                        .join("；")}`);
                }
            }
        }
        lines.push("使用规则：这些是内部记忆，不要原样展示；本人亲口说出的事实用 people_remember 记录。");
        lines.push("</people_context>");
        return truncate(lines.join("\n"), input.maxChars ?? this.config.injectMaxChars ?? 1200);
    }
    // -------------------------------------------------------------------------
    // Profile rendering
    // -------------------------------------------------------------------------
    formatProfileCard(snapshot) {
        const dimensions = this.db.listDimensions().filter((dimension) => dimension.active);
        const values = new Map(snapshot.traits.map((trait) => [trait.dimension, trait.value]));
        const label = (key) => dimensions.find((dimension) => dimension.key === key)?.label ?? key;
        const firstSeen = snapshot.account?.first_seen ?? snapshot.person?.created_at ?? "";
        const lastSeen = snapshot.account?.last_interaction ?? snapshot.person?.updated_at ?? "";
        const lines = [
            `📋 ${snapshot.displayName} 的画像`,
            "",
            `初次见面 · ${firstSeen}  |  最近 · ${lastSeen}`,
            "",
        ];
        const callName = snapshot.person?.call_name || snapshot.account?.call_name;
        if (callName)
            lines.push(`称呼 ┆ ${callName}`);
        for (const dimension of dimensions) {
            const value = values.get(dimension.key);
            if (value)
                lines.push(`${label(dimension.key)} ┆ ${value}`);
        }
        if (snapshot.impressions.length > 0) {
            lines.push("", "零散印象");
            for (const impression of snapshot.impressions.slice(0, 3)) {
                lines.push(`· ${impression.content}`);
            }
        }
        return lines.join("\n");
    }
    formatLookup(account, full = false) {
        const snapshot = this.snapshot(account.account_id);
        if (!snapshot)
            return "未找到该账号。";
        return full ? this.formatProfileDetail(snapshot) : this.formatProfileCard(snapshot);
    }
    formatPersonLookup(personId, full = false) {
        const snapshot = this.personSnapshot(personId);
        if (!snapshot)
            return "未找到该人物。";
        return full ? this.formatProfileDetail(snapshot) : this.formatProfileCard(snapshot);
    }
    formatProfileDetail(snapshot, limit = 300) {
        const dimensions = this.db.listDimensions().filter((dimension) => dimension.active);
        const label = (key) => dimensions.find((dimension) => dimension.key === key)?.label ?? key;
        const total = this.db.countImpressions(snapshot.ownerType, snapshot.ownerId);
        const impressions = this.db.listImpressions(snapshot.ownerType, snapshot.ownerId, Math.max(1, Math.min(500, Math.trunc(limit))));
        const lines = [
            `📋 ${snapshot.displayName}（${snapshot.ownerType}:${snapshot.ownerId}）`,
            `特征 ${snapshot.traits.length} 个 · 零散印象 ${total} 条`,
        ];
        if (snapshot.traits.length > 0) {
            lines.push("", "特征");
            for (const trait of snapshot.traits)
                lines.push(`${label(trait.dimension)} ┆ ${trait.value}`);
        }
        if (impressions.length > 0) {
            lines.push("", `零散印象（显示 ${impressions.length}/${total} 条）`);
            for (const impression of impressions)
                lines.push(`[${impression.id}] ${impression.content}`);
        }
        return lines.join("\n");
    }
    resolveGroup(ref) {
        const value = ref.trim();
        if (!value)
            return null;
        const direct = this.db.getGroup(value) ?? this.db.findGroupByChat(value);
        if (direct)
            return direct;
        // Accept legacy and channel-prefixed forms such as
        // "GewePlus:46192290892", "Bncr:GolemPlus:56154027594:0" or a bare chat id.
        const tokens = value.split(":").map((token) => token.trim()).filter(Boolean).reverse();
        for (const token of tokens) {
            if (!/^-?\d+$/.test(token))
                continue;
            const byChat = this.db.findGroupByChat(token);
            if (byChat)
                return byChat;
        }
        const lower = value.toLowerCase();
        return this.db.listAllGroups().find((group) => group.group_id.toLowerCase() === lower) ?? null;
    }
    /**
     * Resolve a group reference strictly: a bare chat id that maps to several
     * backend rows is ambiguous, because those rows are independent records.
     */
    resolveGroupStrict(ref) {
        const value = ref.trim();
        if (!value)
            throw new Error("group 引用不能为空");
        if (!value.includes("/") && !value.includes(":")) {
            const matches = this.db.findGroupsByChatAll(value);
            if (matches.length > 1) {
                throw new Error(`群号 ${value} 在多个后端下各有独立记录（${matches
                    .map((group) => group.group_id)
                    .join(", ")}）。请改用精确群 key 指定；同一件事需要在多个后端分别记录时各写一条。`);
            }
        }
        const group = this.resolveGroup(value);
        if (!group)
            throw new Error(`没有找到群：${ref}。可以只传数字群号。`);
        return group;
    }
    formatGroup(group) {
        const events = this.db.listGroupEvents(group.group_id, 8);
        const members = this.db.listGroupMembers(group.group_id, 8);
        const lines = [
            `📋 ${group.group_subject || group.display_name || group.chat_id}`,
            `平台：${group.platform}  群 ID：${group.chat_id}`,
            `成员记录：${members.length}  最近更新：${group.updated_at}`,
        ];
        if (events.length > 0) {
            lines.push("", "最近记忆");
            for (const event of events)
                lines.push(`· ${event.occurred_at.slice(0, 10)} [${event.category}] ${event.summary}`);
        }
        return lines.join("\n");
    }
    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------
    remember(input) {
        const snapshot = this.profileTarget(input);
        const content = input.content.trim();
        if (!content)
            throw new Error("content 不能为空");
        if (input.mode === "replace" && !input.dimension) {
            throw new Error("replace 模式需要同时提供 dimension，否则无法确定替换哪个特征。");
        }
        let traitUpdated = false;
        if (input.dimension) {
            const active = this.db.listDimensions().filter((item) => item.active);
            const requested = input.dimension.trim();
            const dimension = active.find((item) => item.key === requested) ??
                active.find((item) => item.label === requested) ??
                active.find((item) => item.label.toLowerCase() === requested.toLowerCase());
            if (!dimension) {
                const keys = active.map((item) => `${item.key}（${item.label}）`).join(", ");
                throw new Error(`未知或未启用的维度: ${input.dimension}。可用: ${keys}`);
            }
            const existing = snapshot.traits.find((trait) => trait.dimension === dimension.key)?.value;
            const mode = input.mode ?? "append";
            const value = mode === "replace" || !existing
                ? content
                : existing.includes(content)
                    ? existing
                    : `${existing}；${content}`;
            this.db.setTrait(snapshot.ownerType, snapshot.ownerId, dimension.key, value);
            traitUpdated = true;
        }
        // A replace writes the distilled trait value. Keeping a second copy as an
        // impression would make compacted profiles dense again on every cycle.
        const impressionStored = input.mode === "replace" && input.dimension
            ? false
            : this.db.addImpression({
                ownerType: snapshot.ownerType,
                ownerId: snapshot.ownerId,
                content,
                agentId: input.agentId,
                source: input.source,
            });
        return {
            stored: impressionStored,
            impressionStored,
            ownerType: snapshot.ownerType,
            ownerId: snapshot.ownerId,
            traitUpdated,
        };
    }
    note(input) {
        const group = this.db.getGroup(input.groupId) ?? this.db.findGroupByChat(input.groupId);
        if (!group)
            throw new Error(`群不存在: ${input.groupId}`);
        const stored = this.db.addGroupEvent({
            groupId: group.group_id,
            summary: input.summary,
            category: input.category,
            tags: input.tags,
            agentId: input.agentId,
        });
        return { stored, groupId: group.group_id };
    }
    bind(input) {
        const account = this.db.getAccount(input.accountId);
        if (!account)
            throw new Error(`账号不存在: ${input.accountId}`);
        let person = input.personId ? this.db.getPerson(input.personId) : null;
        let createdPerson = false;
        if (!person) {
            const byName = input.name ? this.db.searchPersons(input.name, 2) : [];
            person = byName.length === 1 ? byName[0] ?? null : null;
        }
        if (!person) {
            person = this.db.createPerson({
                personId: input.personId || newPersonId(),
                name: input.name || account.confirmed_name || account.display_name,
            });
            createdPerson = true;
        }
        const moved = this.db.bindAccount(account.account_id, person.person_id, {
            method: input.method ?? "manual",
            confidence: input.confidence ?? "confirmed",
            migrate: true,
        });
        return {
            accountId: account.account_id,
            personId: person.person_id,
            createdPerson,
            moved: { impressions: moved.impressionsMoved, traits: moved.traitsMoved },
        };
    }
    setName(input) {
        const account = this.db.getAccount(input.accountId);
        if (!account)
            throw new Error(`账号不存在: ${input.accountId}`);
        const callName = input.callName?.trim() || null;
        const confirmedName = input.confirmedName?.trim() || null;
        const personName = input.personName?.trim() || null;
        if (!callName && !confirmedName && !personName) {
            throw new Error("至少要提供 callName / confirmedName / personName 之一。");
        }
        if (account.bound_person_id) {
            const person = this.db.getPerson(account.bound_person_id);
            if (!person)
                throw new Error(`绑定的人物不存在: ${account.bound_person_id}`);
            this.db.updatePerson(person.person_id, { callName, name: personName });
            return { target: "person", callName: callName ?? person.call_name };
        }
        if (callName)
            this.db.setCallName(account.account_id, callName);
        if (confirmedName)
            this.db.setConfirmedName(account.account_id, confirmedName);
        return { target: "account", callName: callName ?? account.call_name };
    }
    forget(input) {
        const snapshot = this.profileTarget(input);
        const match = input.match.trim();
        if (!match)
            throw new Error("match 不能为空");
        const scope = input.scope ?? "all";
        return {
            impressions: scope === "traits" ? 0 : this.db.removeImpressions(snapshot.ownerType, snapshot.ownerId, match),
            traits: scope === "impressions"
                ? 0
                : this.db.removeTraitsMatching(snapshot.ownerType, snapshot.ownerId, match),
        };
    }
    mergePersons(sourcePersonId, targetPersonId) {
        const result = this.db.mergePersons(sourcePersonId, targetPersonId);
        return { accounts: result.accounts, impressions: result.impressions, traits: result.traits };
    }
    unbind(accountId, copyProfile = true) {
        return this.db.unbindAccount(accountId, copyProfile);
    }
    mergeAccounts(sourceId, targetId) {
        return this.db.mergeAccounts(sourceId.trim(), targetId.trim());
    }
    /** Split an account id into its platform and sender parts. */
    parseAccountId(accountId) {
        const separator = accountId.indexOf(":");
        if (separator <= 0)
            return null;
        const platform = accountId.slice(0, separator);
        const senderId = accountId.slice(separator + 1);
        if (!platform || !senderId)
            return null;
        return { platform, senderId };
    }
    /** Sender part of an account id, used for skip-pattern checks. */
    senderOf(accountId) {
        return this.parseAccountId(accountId)?.senderId ?? accountId;
    }
    /** An existing person that already owns another account of the same sender. */
    personForOwnerSender(senderId) {
        for (const row of this.db.listAccountsBySender(senderId)) {
            if (row.bound_person_id)
                return row.bound_person_id;
        }
        return null;
    }
    isSkippedSender(senderId) {
        const patterns = this.config.captureSkipSenders ?? DEFAULT_CAPTURE_SKIP_SENDERS;
        const value = senderId.trim();
        if (!value)
            return false;
        return patterns.some((pattern) => {
            try {
                return new RegExp(pattern, "i").test(value);
            }
            catch {
                return value === pattern;
            }
        });
    }
    findBotAccounts() {
        const accounts = this.db.listAllAccounts();
        const botNames = new Set();
        for (const group of this.db.listAllGroups()) {
            for (const name of group.bot_names) {
                const value = name.trim().toLowerCase();
                if (value)
                    botNames.add(value);
            }
        }
        const botMembers = new Set();
        for (const member of this.db.listAllGroupMembers()) {
            if (member.classification === "likely_bot" || (member.role_in_group ?? "").toLowerCase() === "bot") {
                botMembers.add(member.account_id);
            }
        }
        const result = [];
        for (const account of accounts) {
            if (botMembers.has(account.account_id)) {
                result.push(account);
                continue;
            }
            const identifiers = [account.display_name, account.confirmed_name, account.call_name, account.sender_id]
                .filter((value) => Boolean(value))
                .map((value) => value.trim().toLowerCase());
            if (identifiers.some((value) => botNames.has(value)))
                result.push(account);
        }
        return result;
    }
    resolveWriteTarget(platform, senderId) {
        const incoming = normalizePlatform(platform);
        const sender = senderId.trim();
        const exact = this.db.getAccountByPlatformSender(incoming, sender);
        if (exact)
            return { kind: "direct", platform: incoming };
        if (this.isBareMultiAccount(incoming))
            return { kind: "deferred", platform: null };
        return { kind: "direct", platform: incoming };
    }
    /** The only backend group row for a chat id, when the choice is unambiguous. */
    soleBackendGroup(chatId) {
        const rows = this.db.findGroupsByChatAll(chatId);
        return rows.length === 1 ? rows[0] : null;
    }
    resolveAccountForLookup(platform, senderId) {
        const target = this.resolveWriteTarget(platform, senderId);
        if (target.kind === "direct") {
            return this.db.getAccountByPlatformSender(target.platform, senderId.trim());
        }
        // A bare channel label has no unique backend. Reads fall back to the most
        // recently active backend row of this channel for the same sender.
        const rows = this.db.listAccountsBySender(senderId.trim()).filter((row) => row.platform.includes("/") && this.channelOf(row.platform) === this.channelOf(platform));
        if (rows.length === 0)
            return null;
        return [...rows].sort((a, b) => b.last_interaction.localeCompare(a.last_interaction))[0];
    }
    /** Platform labels that share a sender-id space (one same-sender family pair). */
    familyPairs() {
        const families = this.config.senderFamilies ?? DEFAULT_SENDER_FAMILIES;
        return families.map((family) => [normalizePlatform(family[0]), normalizePlatform(family[1])]);
    }
    familyKeyOf(platform) {
        const normalized = normalizePlatform(platform).toLowerCase();
        for (const [left, right] of this.familyPairs()) {
            if (normalized === left.toLowerCase() || normalized === right.toLowerCase()) {
                return [left, right].map((value) => value.toLowerCase()).sort().join("+");
            }
        }
        return null;
    }
    /** Rows of one sender that belong to the same same-sender family, e.g. GewePlus + GolemPlus. */
    familyRows(senderId) {
        const rows = this.db.listAccountsBySender(senderId);
        if (rows.length < 2)
            return [];
        const byFamily = new Map();
        for (const row of rows) {
            const key = this.familyKeyOf(row.platform);
            if (!key)
                continue;
            byFamily.set(key, [...(byFamily.get(key) ?? []), row]);
        }
        const result = [];
        for (const list of byFamily.values()) {
            if (list.length >= 2)
                result.push(...list);
        }
        return result;
    }
    /**
     * Same-sender family binding state machine. Rows that share a sender id inside one
     * family (GewePlus + GolemPlus) are one human on two accesses: bind them to one person.
     * Conflicting manual bindings are left untouched and reported instead.
     */
    syncFamilyBinding(senderId) {
        const rows = this.familyRows(senderId);
        if (rows.length < 2)
            return null;
        if (rows.some((row) => row.current_role === "bot"))
            return null;
        const personIds = new Set(rows.map((row) => row.bound_person_id).filter((value) => Boolean(value)));
        if (personIds.size >= 2)
            return null;
        const bound = personIds.size === 1 ? rows.filter((row) => row.bound_person_id) : [];
        const loose = rows.filter((row) => !row.bound_person_id);
        if (bound.length === 0 && loose.length < 2)
            return null;
        let personId = bound[0]?.bound_person_id ?? null;
        if (!personId) {
            const anchor = this.pickFamilyAnchor(rows);
            const person = this.db.createPerson({
                personId: newPersonId(),
                name: this.familyPersonName(anchor),
            });
            personId = person.person_id;
            for (const row of rows) {
                this.db.bindAccount(row.account_id, personId, {
                    method: "sender_family",
                    confidence: "confirmed",
                    migrate: true,
                });
            }
            return `同族归并：${rows.map((row) => row.account_id).join(" + ")} → 新人物 ${personId}`;
        }
        for (const row of loose) {
            this.db.bindAccount(row.account_id, personId, {
                method: "sender_family",
                confidence: "confirmed",
                migrate: true,
            });
        }
        // Rows already bound to the same person may still hold account-level
        // leftovers written before the binding existed; pull them up as well.
        for (const row of rows) {
            this.db.bindAccount(row.account_id, personId, {
                method: "sender_family",
                confidence: "confirmed",
                migrate: true,
            });
        }
        return `同族归并：${rows.map((row) => row.account_id).join(" + ")} → ${personId}`;
    }
    pickFamilyAnchor(rows) {
        const rank = (row) => [
            row.call_name ? 1 : 0,
            row.confirmed_name ? 1 : 0,
            row.display_name ? 1 : 0,
        ];
        return [...rows].sort((a, b) => {
            const ra = rank(a);
            const rb = rank(b);
            for (let i = 0; i < 3; i += 1) {
                if (ra[i] !== rb[i])
                    return rb[i] - ra[i];
            }
            return b.last_interaction.localeCompare(a.last_interaction);
        })[0] ?? rows[0];
    }
    familyPersonName(anchor) {
        return anchor.call_name || anchor.confirmed_name || anchor.display_name || anchor.sender_id;
    }
    /** Person binding conflicts created by manual owner bindings inside one family. */
    familyBindingConflicts() {
        const bySender = new Map();
        for (const account of this.db.listAllAccounts()) {
            if (!this.familyKeyOf(account.platform))
                continue;
            bySender.set(account.sender_id, [...(bySender.get(account.sender_id) ?? []), account]);
        }
        const conflicts = [];
        for (const [sender, rows] of bySender) {
            if (rows.length < 2)
                continue;
            if (rows.some((row) => row.current_role === "bot"))
                continue;
            const persons = [...new Set(rows.map((row) => row.bound_person_id).filter((value) => Boolean(value)))];
            if (persons.length >= 2)
                conflicts.push({ sender, rows, persons });
        }
        return conflicts;
    }
    multiAccountChannelSet() {
        const channels = this.config.multiAccountChannels ?? DEFAULT_MULTI_ACCOUNT_CHANNELS;
        return new Set(channels.map((channel) => channel.trim().toLowerCase()).filter((channel) => channel));
    }
    channelOf(platform) {
        return normalizePlatform(platform).split("/")[0]?.trim().toLowerCase() ?? "";
    }
    isBareMultiAccount(platform) {
        const normalized = normalizePlatform(platform);
        if (normalized.includes("/"))
            return false;
        return this.multiAccountChannelSet().has(normalized.toLowerCase());
    }
    isBareMultiAccountRow(account) {
        return this.isBareMultiAccount(account.platform);
    }
    hasBackendTwin(account) {
        return this.db.listAccountsBySender(account.sender_id).some((row) => row.account_id !== account.account_id &&
            row.platform.includes("/") &&
            this.channelOf(row.platform) === this.channelOf(account.platform));
    }
    upsertDimension(key, label, active = true, sort = 999) {
        const normalizedKey = key.trim();
        const normalizedLabel = label.trim() || normalizedKey;
        if (!/^[a-z][a-z0-9_]{1,47}$/.test(normalizedKey)) {
            throw new Error("维度 key 只能使用小写字母、数字和下划线，并以字母开头。");
        }
        this.db.upsertDimension(normalizedKey, normalizedLabel, active, sort);
        return this.db.getDimension(normalizedKey);
    }
    search(query, limit = 10) {
        const value = query.trim();
        if (!value)
            throw new Error("query 不能为空。");
        const capped = Math.max(1, Math.min(50, Math.trunc(limit)));
        return {
            accounts: this.db.searchAccounts(value, capped),
            persons: this.db.searchPersons(value, capped),
            impressions: this.db.searchImpressions(value, capped),
            groupEvents: this.db.searchGroupEvents(value, capped),
        };
    }
    backup(keep = 14) {
        const keepCount = Math.max(2, Math.min(100, Math.trunc(keep)));
        const backupDir = path.join(this.paths.dataDir, "backups");
        ensureDir(backupDir);
        const stamp = new Date().toISOString().replace(/[-:.]/g, "");
        const base = `people-${stamp}`;
        const dbBackup = path.join(backupDir, `${base}.db`);
        const jsonBackup = path.join(backupDir, `${base}.json`);
        this.db.backupTo(dbBackup);
        fs.writeFileSync(jsonBackup, `${JSON.stringify(this.db.dump(), null, 2)}\n`, { mode: 0o600 });
        const bases = new Set();
        for (const name of fs.readdirSync(backupDir)) {
            const match = /^(people-[^.]+)\.(db|json)$/.exec(name);
            if (match?.[1])
                bases.add(match[1]);
        }
        const ordered = [...bases].sort().reverse();
        let removedOld = 0;
        for (const oldBase of ordered.slice(keepCount)) {
            for (const suffix of ["db", "json"]) {
                const file = path.join(backupDir, `${oldBase}.${suffix}`);
                if (!fs.existsSync(file))
                    continue;
                fs.unlinkSync(file);
                removedOld += 1;
            }
        }
        return {
            backupDir,
            dbBackup,
            jsonBackup,
            dbBytes: fs.statSync(dbBackup).size,
            jsonBytes: fs.statSync(jsonBackup).size,
            removedOld,
            kept: Math.min(keepCount, ordered.length),
        };
    }
    health() {
        const validation = this.validate();
        const issues = validation.issues.filter((issue) => issue.level !== "info");
        const bindings = this.db.listAllPersonAccounts();
        const linkedPersons = new Set(bindings.map((binding) => binding.person_id));
        const persons = this.db.listAllPersons();
        for (const person of persons) {
            if (!linkedPersons.has(person.person_id)) {
                issues.push({
                    level: "warning",
                    code: "unlinked_person",
                    message: `人物 ${person.person_id}（${person.call_name || person.name || "未命名"}）没有绑定账号`,
                });
            }
        }
        const byName = new Map();
        for (const person of persons) {
            const name = (person.call_name || person.name || "").trim().toLowerCase();
            if (!name)
                continue;
            byName.set(name, [...(byName.get(name) ?? []), person.person_id]);
        }
        for (const [name, ids] of byName) {
            if (ids.length > 1) {
                issues.push({
                    level: "warning",
                    code: "duplicate_person_name",
                    message: `人物名「${name}」对应多个记录：${ids.join(", ")}`,
                });
            }
        }
        for (const conflict of this.familyBindingConflicts()) {
            issues.push({
                level: "warning",
                code: "person_binding_conflict",
                message: "同族两条接入绑到不同人物: " +
                    conflict.rows.map((row) => row.account_id).join(" 与 ") +
                    "，人物 " +
                    conflict.persons.join(" / ") +
                    "。由 owner 判断保留哪侧，再 people_unbind 另一侧。",
            });
        }
        for (const account of this.db.listAllAccounts()) {
            if (!this.isBareMultiAccountRow(account))
                continue;
            if (this.hasBackendTwin(account))
                continue;
            issues.push({
                level: "warning",
                code: "bare_platform_account",
                message: account.account_id +
                    " 是缺后端的裸 " +
                    this.channelOf(account.platform) +
                    " 行，无法自动确定后端，等待带后端的入站消息或人工指定",
            });
        }
        for (const account of this.findBotAccounts()) {
            if (account.current_role === "bot")
                continue;
            const hasData = account.bound_person_id !== null ||
                this.db.countImpressions("account", account.account_id) > 0 ||
                this.db.getTraits("account", account.account_id).length > 0;
            if (!hasData)
                continue;
            issues.push({
                level: "warning",
                code: "bot_profile_unmarked",
                message: "命中群 botNames 或成员 bot 分类但未标记 bot: " + account.account_id,
            });
        }
        for (const profile of this.db.profileStats(50)) {
            if (profile.impressions > 12) {
                issues.push({
                    level: "warning",
                    code: "profile_dense",
                    message: `${profile.owner_type}:${profile.owner_id} 有 ${profile.impressions} 条印象，建议归并到 traits`,
                });
            }
        }
        const backupDir = path.join(this.paths.dataDir, "backups");
        let lastBackupAt = null;
        if (fs.existsSync(backupDir)) {
            const backups = fs
                .readdirSync(backupDir)
                .filter((name) => /^people-.*\.db$/.test(name))
                .map((name) => path.join(backupDir, name))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            if (backups[0])
                lastBackupAt = fs.statSync(backups[0]).mtime.toISOString();
        }
        if (!lastBackupAt) {
            issues.push({ level: "warning", code: "no_backup", message: "尚未创建识人库备份" });
        }
        return {
            ok: !issues.some((issue) => issue.level === "error"),
            dataDir: this.paths.dataDir,
            dbPath: this.paths.dbPath,
            counts: validation.counts,
            issues,
            lastBackupAt,
        };
    }
    cycle(input = {}) {
        const before = this.health();
        const intervalHours = Math.max(1, Math.min(168, input.backupIntervalHours ?? 20));
        const backupAgeMs = before.lastBackupAt ? Date.now() - Date.parse(before.lastBackupAt) : Number.POSITIVE_INFINITY;
        const backupDue = input.forceBackup === true || !before.lastBackupAt || backupAgeMs >= intervalHours * 3_600_000;
        const backup = backupDue ? this.backup(input.backupKeep ?? 14) : null;
        // Run repair only after the fresh backup, so every automatic change has a rollback point.
        const repairActions = this.repair();
        const health = this.health();
        const actions = [];
        for (const issue of health.issues) {
            if (issue.code === "profile_dense") {
                const match = /^(account|person):(.+) 有 (\d+) 条印象/.exec(issue.message);
                if (match?.[1] && match[2]) {
                    actions.push({
                        kind: "compact",
                        target: match[2],
                        ownerType: match[1],
                        message: `画像有 ${match[3] ?? "?"} 条零散印象，归并到 traits 后删除重复原文。`,
                    });
                }
            }
            else if (issue.code === "duplicate_person_name") {
                const match = /人物名「(.+)」对应多个记录：(.+)$/.exec(issue.message);
                if (match?.[2]) {
                    actions.push({
                        kind: "merge_review",
                        target: match[2].trim(),
                        message: `人物名「${match[1]}」可能重复。核对账号和一手事实后再合并，证据不足则保留。`,
                    });
                }
            }
            else if (issue.code === "person_binding_conflict") {
                const match = /^同族两条接入绑到不同人物: (.+?)，人物 (.+)\./u.exec(issue.message);
                actions.push({
                    kind: "merge_review",
                    target: match?.[2] ?? "",
                    ownerType: "person",
                    message: `同族接入绑到不同人物（${match?.[1] ?? "见 health 详情"}）。不自动改绑：向 owner 报告并给出建议（保留哪侧 + people_unbind 另一侧）。`,
                });
            }
            else if (issue.code === "unlinked_person") {
                const match = /^人物 (\S+)/.exec(issue.message);
                if (match?.[1]) {
                    actions.push({
                        kind: "merge_review",
                        target: match[1],
                        ownerType: "person",
                        message: "人物没有绑定账号。确认是废弃记录且有明确目标时合并，否则保留。",
                    });
                }
            }
            else if (issue.code === "bare_platform_account") {
                const match = /^(\S+) 是/.exec(issue.message);
                if (match?.[1]) {
                    actions.push({
                        kind: "observe",
                        target: match[1],
                        ownerType: "account",
                        message: "裸行缺后端：等待该发送者带后端的入站消息自动建立规范化行，或人工指定后端。",
                    });
                }
            }
        }
        const cycledAt = nowIso();
        const previousCycle = this.db.metaGet("last_cycle_at");
        this.db.metaSet("last_cycle_at", cycledAt);
        this.db.metaSet("last_cycle_report", JSON.stringify({
            cycledAt,
            backup: backup ? { dbBackup: backup.dbBackup, jsonBackup: backup.jsonBackup } : null,
            repairActions,
            actions,
        }));
        return {
            cycledAt,
            backup,
            backupSkipped: !backupDue,
            repairActions,
            health,
            actions,
            lastCycleAt: previousCycle,
        };
    }
    // -------------------------------------------------------------------------
    // Status and validation
    // -------------------------------------------------------------------------
    status() {
        return {
            workspaceDir: this.paths.workspaceDir,
            dataDir: this.paths.dataDir,
            dbPath: this.paths.dbPath,
            schemaVersion: this.db.schemaVersion(),
            counts: this.db.counts(),
            dimensions: this.db.listDimensions(),
            lastFullScanAt: this.db.getScanMeta().lastFullScanAt,
            legacyImportedAt: this.db.metaGet("legacy_imported_at"),
        };
    }
    validate() {
        const issues = [];
        const counts = this.db.counts();
        const dimensions = new Map(this.db.listDimensions().map((dimension) => [dimension.key, dimension]));
        const accounts = this.db.listAllAccounts();
        const accountIds = new Set(accounts.map((account) => account.account_id));
        const groups = this.db.listAllGroups();
        const bindings = this.db.listAllPersonAccounts();
        if (this.db.schemaVersion() !== SCHEMA_VERSION) {
            issues.push({
                level: "error",
                code: "schema_version",
                message: `数据库 schema_version=${this.db.schemaVersion()}，期望 ${SCHEMA_VERSION}`,
            });
        }
        for (const account of accounts) {
            if (!account.platform || !account.sender_id) {
                issues.push({ level: "error", code: "account_identity", message: `${account.account_id} 缺少 platform/sender_id` });
            }
            if (account.bound_person_id && !this.db.getPerson(account.bound_person_id)) {
                issues.push({
                    level: "error",
                    code: "missing_person",
                    message: `${account.account_id} 绑定了不存在的 ${account.bound_person_id}`,
                });
            }
            if (!account.display_name && !account.confirmed_name) {
                issues.push({ level: "warning", code: "missing_name", message: `${account.account_id} 没有显示名` });
            }
        }
        for (const binding of bindings) {
            if (!accountIds.has(binding.account_id)) {
                issues.push({ level: "error", code: "binding_account", message: `绑定引用了不存在的账号 ${binding.account_id}` });
            }
            if (!this.db.getPerson(binding.person_id)) {
                issues.push({ level: "error", code: "binding_person", message: `绑定引用了不存在的人物 ${binding.person_id}` });
            }
        }
        for (const group of groups) {
            if (!group.chat_id) {
                issues.push({ level: "error", code: "group_chat", message: `${group.group_id} 缺少 chat_id` });
            }
        }
        for (const member of this.db.listAllGroupMembers()) {
            if (!accountIds.has(member.account_id)) {
                issues.push({
                    level: "warning",
                    code: "orphan_member",
                    message: `群 ${member.group_id} 的成员 ${member.account_id} 不在账号索引中`,
                });
            }
        }
        for (const trait of this.db.listAllTraits()) {
            if (!dimensions.has(trait.dimension)) {
                issues.push({
                    level: "warning",
                    code: "unknown_dimension",
                    message: `${trait.owner_type}:${trait.owner_id} 使用了未定义维度 ${trait.dimension}`,
                });
            }
        }
        if (!this.db.getScanMeta().lastFullScanAt) {
            issues.push({ level: "info", code: "scan_meta", message: "尚无全量扫描记录" });
        }
        if (this.db.hasLegacyJson() && !this.db.metaGet("legacy_imported_at")) {
            issues.push({ level: "warning", code: "legacy_not_imported", message: "存在旧 JSON 但尚未导入" });
        }
        return {
            ok: !issues.some((issue) => issue.level === "error"),
            dataDir: this.paths.dataDir,
            dbPath: this.paths.dbPath,
            counts,
            issues,
        };
    }
    repair() {
        const actions = [];
        this.db.transaction(() => {
            for (const binding of this.db.listAllPersonAccounts()) {
                if (!this.db.getPerson(binding.person_id)) {
                    this.db.createPerson({ personId: binding.person_id });
                    actions.push(`创建缺失人物 ${binding.person_id}`);
                }
                if (!this.db.getAccount(binding.account_id)) {
                    const separator = binding.account_id.indexOf(":");
                    if (separator > 0) {
                        this.db.upsertAccount({
                            platform: binding.account_id.slice(0, separator),
                            senderId: binding.account_id.slice(separator + 1),
                            displayName: binding.account_id.slice(separator + 1),
                        });
                        actions.push(`补建账号 ${binding.account_id}`);
                    }
                }
            }
            for (const account of this.db.listAllAccounts()) {
                if (account.bound_person_id && !this.db.getPerson(account.bound_person_id)) {
                    this.db.createPerson({ personId: account.bound_person_id, name: account.display_name });
                    actions.push(`补建人物 ${account.bound_person_id}`);
                }
            }
            for (const binding of this.db.listAllPersonAccounts()) {
                const account = this.db.getAccount(binding.account_id);
                if (account && account.bound_person_id !== binding.person_id) {
                    this.db.bindAccount(account.account_id, binding.person_id, {
                        method: binding.bind_method,
                        confidence: binding.confidence,
                        migrate: true,
                    });
                    actions.push(`同步绑定 ${account.account_id} → ${binding.person_id}`);
                }
            }
            // Drop system/cron auto-rows that carry no data and no binding.
            for (const account of this.db.listAllAccounts()) {
                if (!this.isSkippedSender(account.sender_id))
                    continue;
                if (account.bound_person_id)
                    continue;
                const impressions = this.db.countImpressions("account", account.account_id);
                const traits = this.db.getTraits("account", account.account_id).length;
                if (impressions > 0 || traits > 0)
                    continue;
                this.db.deleteAccount(account.account_id);
                actions.push(`移除系统账号 ${account.account_id}`);
            }
            // Backfill account rows for orphan group members. A member row without an
            // account row means the index lost the sender; rebuild it from the member
            // evidence instead of leaving a dangling reference.
            for (const member of this.db.listAllGroupMembers()) {
                if (this.db.getAccount(member.account_id))
                    continue;
                if (this.isSkippedSender(this.senderOf(member.account_id))) {
                    this.db.removeGroupMember(member.group_id, member.account_id);
                    actions.push(`移除系统成员 ${member.account_id}（${member.group_id}）`);
                    continue;
                }
                // A member id without a platform segment still carries the sender id;
                // take the platform from the group row the member was seen in.
                const parsed = this.parseAccountId(member.account_id);
                const groupPlatform = this.db.getGroup(member.group_id)?.platform;
                const platform = parsed?.platform ?? groupPlatform;
                const senderId = parsed?.senderId ?? member.account_id;
                if (!platform || !senderId)
                    continue;
                const created = this.db.upsertAccount({
                    platform,
                    senderId,
                    displayName: member.display_name ?? senderId,
                });
                const role = member.classification === "likely_bot"
                    ? "bot"
                    : member.role_in_group === "owner"
                        ? "owner"
                        : undefined;
                if (role)
                    this.db.setAccountRole(created.account.account_id, role);
                const ownerPerson = role === "owner" ? this.personForOwnerSender(senderId) : null;
                if (ownerPerson) {
                    this.db.bindAccount(created.account.account_id, ownerPerson, {
                        method: "member_backfill",
                        confidence: "tentative",
                        migrate: true,
                    });
                }
                // The account id is normalized (platform:sender), so the member row that
                // referenced a platform-less id must be rewritten to the new key.
                if (created.account.account_id !== member.account_id) {
                    this.db.removeGroupMember(member.group_id, member.account_id);
                    this.db.upsertGroupMember({
                        groupId: member.group_id,
                        accountId: created.account.account_id,
                        displayName: member.display_name ?? undefined,
                        classification: member.classification,
                        roleInGroup: member.role_in_group ?? undefined,
                    });
                }
                actions.push(`补建成员账号 ${member.account_id} → ${created.account.account_id}（${member.group_id}${role ? `，标记 ${role}` : ""}${ownerPerson ? `，绑定 ${ownerPerson}` : ""}）`);
            }
            // A member row we cannot turn into an account at all is a placeholder.
            for (const member of this.db.listAllGroupMembers()) {
                if (this.db.getAccount(member.account_id))
                    continue;
                this.db.removeGroupMember(member.group_id, member.account_id);
                actions.push(`移除无法定位的成员 ${member.account_id}（${member.group_id}）`);
            }
            // Accounts without any display name fall back to the sender id so cards
            // and lookups stay readable. Real names arrive with the next message.
            for (const account of this.db.listAllAccounts()) {
                if (account.display_name || account.confirmed_name || account.call_name)
                    continue;
                this.db.upsertAccount({
                    platform: account.platform,
                    senderId: account.sender_id,
                    displayName: account.sender_id,
                });
                actions.push(`补默认显示名 ${account.account_id}`);
            }
            // Persons with no binding and no profile carry no memory; drop them.
            for (const person of this.db.listAllPersons()) {
                if (this.db.listPersonAccounts(person.person_id).length > 0)
                    continue;
                if (this.db.countImpressions("person", person.person_id) > 0)
                    continue;
                if (this.db.getTraits("person", person.person_id).length > 0)
                    continue;
                // A person with notes may be a deliberate placeholder awaiting a binding.
                if ((person.notes ?? "").trim())
                    continue;
                if (this.db.deletePerson(person.person_id)) {
                    actions.push(`移除空人物 ${person.person_id}（${person.call_name || person.name || "未命名"}）`);
                }
            }
            // Same-sender family rows collapse to one person (GewePlus + GolemPlus).
            const familySenders = new Set();
            for (const account of this.db.listAllAccounts()) {
                if (this.familyKeyOf(account.platform))
                    familySenders.add(account.sender_id);
            }
            for (const sender of familySenders) {
                try {
                    const action = this.syncFamilyBinding(sender);
                    if (action)
                        actions.push(action);
                }
                catch (error) {
                    this.logger.warn(`[people] family sweep failed for ${sender}: ${error.message}`);
                }
            }
            for (const account of this.findBotAccounts()) {
                if (account.current_role === "bot")
                    continue;
                this.db.setAccountRole(account.account_id, "bot");
                actions.push("标记 " + account.account_id + " 为 bot");
            }
            for (const account of this.db.listAllAccounts()) {
                if (!this.isBareMultiAccountRow(account))
                    continue;
                const siblings = this.db
                    .listAccountsBySender(account.sender_id)
                    .filter((row) => row.account_id !== account.account_id &&
                    row.platform.includes("/") &&
                    this.channelOf(row.platform) === this.channelOf(account.platform));
                if (siblings.length > 0) {
                    // Backend-qualified rows exist: move any leftover data onto the newest one.
                    const target = [...siblings].sort((a, b) => b.last_interaction.localeCompare(a.last_interaction))[0];
                    const moved = this.db.mergeAccounts(account.account_id, target.account_id);
                    if (moved.impressions > 0 || moved.traits > 0 || moved.groupMembers > 0) {
                        actions.push(`裸行数据迁移 ${account.account_id} → ${target.account_id}（印象 ${moved.impressions} / 特征 ${moved.traits} / 群成员 ${moved.groupMembers}）`);
                    }
                    continue;
                }
                const impressions = this.db.countImpressions("account", account.account_id);
                const traits = this.db.getTraits("account", account.account_id).length;
                if (impressions > 0 || traits > 0)
                    continue;
                this.db.deleteAccount(account.account_id);
                actions.push("移除空裸账号 " + account.account_id);
            }
        });
        return actions;
    }
}
export function describeCounts(counts) {
    return Object.entries(counts)
        .map(([key, value]) => `${key}=${value}`)
        .join("  ");
}
export function describeDimensions(dimensions) {
    return dimensions
        .map((dimension) => `${dimension.key}(${dimension.label})${dimension.active ? "" : "[off]"}`)
        .join(", ");
}
export function resolvePersonName(person, account) {
    return (person?.call_name ||
        account.call_name ||
        person?.name ||
        account.confirmed_name ||
        account.display_name ||
        account.account_id);
}
