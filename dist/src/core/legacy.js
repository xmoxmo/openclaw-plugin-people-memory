import fs from "node:fs";
import path from "node:path";
import { parsePlatformFolder } from "./platform.js";
import { nowIso } from "./time.js";
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readJson(file, warnings) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        warnings.push(`无法读取 ${file}: ${error.message}`);
        return undefined;
    }
}
function listJsonFiles(dir) {
    if (!fs.existsSync(dir))
        return [];
    const output = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name.endsWith(".bak"))
                continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if (entry.isFile() && entry.name.endsWith(".json"))
                output.push(full);
        }
    };
    walk(dir);
    return output;
}
function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function entries(value, key) {
    if (!isObject(value))
        return {};
    if (isObject(value[key]))
        return value[key];
    return Object.fromEntries(Object.entries(value).filter(([entryKey]) => !entryKey.startsWith("_")));
}
function impressionText(value) {
    if (typeof value === "string")
        return text(value);
    if (!isObject(value))
        return null;
    return text(value.content) ?? text(value.text) ?? text(value.summary);
}
function impressionMeta(value) {
    if (!isObject(value))
        return {};
    return {
        createdAt: text(value.created_at) ?? text(value.createdAt) ?? undefined,
        agentId: text(value.agent_id) ?? text(value.agentId) ?? undefined,
        source: text(value.source) ?? undefined,
    };
}
function inferAccountFromPath(file) {
    const senderFile = path.basename(file, ".json");
    const folder = path.basename(path.dirname(file));
    if (!folder || folder === "accounts")
        return null;
    return { platform: parsePlatformFolder(folder), senderId: senderFile };
}
function inferGroupFromPath(file) {
    const name = path.basename(file, ".json");
    const colon = name.split(":");
    if (colon.length >= 3) {
        const channel = colon[0] ?? "";
        const account = colon[1] ?? "";
        const chatId = colon[2] ?? "";
        if (chatId)
            return { platform: `${channel}/${account}`, chatId };
    }
    const underscore = /^([^_]+)_([^_]+)_(.+)$/.exec(name);
    if (underscore) {
        return { platform: `${underscore[1]}/${underscore[2]}`, chatId: underscore[3] ?? "" };
    }
    return null;
}
export function extractChatId(groupId, platform) {
    const value = groupId.trim();
    const prefix = `${platform.replace(/\//g, ":")}:`;
    let chat = value;
    if (value.toLowerCase().startsWith(prefix.toLowerCase())) {
        chat = value.slice(prefix.length);
    }
    else {
        const parts = value.split(":");
        if (parts.length >= 3)
            chat = parts.slice(2).join(":");
    }
    chat = chat.replace(/:0$/, "");
    return chat || value;
}
function mergeBotNames(current, incoming) {
    const list = Array.isArray(incoming)
        ? incoming.filter((item) => typeof item === "string")
        : [];
    return [...new Set([...current, ...list].map((item) => item.trim()).filter(Boolean))];
}
export function importLegacyJson(db, options = {}) {
    const dataDir = path.dirname(db.dbPath);
    const report = {
        imported: false,
        sourceDir: dataDir,
        accounts: 0,
        persons: 0,
        bindings: 0,
        groups: 0,
        groupEvents: 0,
        groupMembers: 0,
        impressions: 0,
        traits: 0,
        scanChannels: 0,
        warnings: [],
    };
    const already = db.metaGet("legacy_imported_at");
    if (already && !options.force) {
        return { ...report, reason: `already imported at ${already}` };
    }
    if (!db.hasLegacyJson()) {
        return { ...report, reason: "no legacy json found" };
    }
    if (db.counts().accounts > 0 && !options.force) {
        return { ...report, reason: "database already has accounts" };
    }
    const accountsIndexFile = path.join(dataDir, "accounts.json");
    const personsIndexFile = path.join(dataDir, "persons.json");
    const bindingsFile = path.join(dataDir, "person_accounts.json");
    const groupsIndexFile = path.join(dataDir, "groups.json");
    const scanStateFile = path.join(dataDir, "scan-state.json");
    const dimensionsFile = path.join(dataDir, "trait-dimensions.json");
    const accountsIndex = entries(readJson(accountsIndexFile, report.warnings), "accounts");
    const personsIndex = entries(readJson(personsIndexFile, report.warnings), "persons");
    const bindingsIndex = entries(readJson(bindingsFile, report.warnings), "person_accounts");
    const groupsIndex = entries(readJson(groupsIndexFile, report.warnings), "groups");
    const scanState = readJson(scanStateFile, report.warnings);
    const dimensions = readJson(dimensionsFile, report.warnings);
    const accountProfiles = [];
    for (const file of listJsonFiles(path.join(dataDir, "accounts"))) {
        const raw = readJson(file, report.warnings);
        if (!isObject(raw))
            continue;
        const inferred = inferAccountFromPath(file);
        const platform = text(raw.platform) ?? inferred?.platform ?? "";
        const senderId = text(raw.sender_id) ?? inferred?.senderId ?? "";
        if (!platform || !senderId) {
            report.warnings.push(`账号画像缺少 platform/sender_id: ${file}`);
            continue;
        }
        accountProfiles.push({ platform, senderId, raw });
    }
    const personProfiles = new Map();
    for (const file of listJsonFiles(path.join(dataDir, "persons"))) {
        const raw = readJson(file, report.warnings);
        if (!isObject(raw))
            continue;
        const personId = text(raw.person_id) ?? path.basename(file, ".json");
        personProfiles.set(personId, raw);
    }
    const groupProfiles = [];
    for (const file of listJsonFiles(path.join(dataDir, "groups"))) {
        const raw = readJson(file, report.warnings);
        if (isObject(raw))
            groupProfiles.push({ ...raw, __file: file });
    }
    db.transaction(() => {
        if (isObject(dimensions) && Array.isArray(dimensions.dimensions)) {
            let sort = 0;
            for (const item of dimensions.dimensions) {
                if (!isObject(item))
                    continue;
                const key = text(item.key);
                const label = text(item.label);
                if (!key || !label)
                    continue;
                sort += 10;
                db.upsertDimension(key, label, item.active !== false, sort);
            }
        }
        // Persons first so bindings and account migration have a target.
        for (const [personId, raw] of personProfiles) {
            const person = db.createPerson({ personId, name: text(raw.name), createdAt: text(raw.created_at) ?? undefined });
            const profile = isObject(raw.profile) ? raw.profile : {};
            db.updatePerson(person.person_id, {
                notes: text(profile.notes),
                callName: text(raw.call_name) ?? text(profile.call_name),
            });
            const traits = isObject(profile.traits) ? profile.traits : {};
            for (const [dimension, value] of Object.entries(traits)) {
                const traitValue = text(value);
                if (!traitValue)
                    continue;
                db.setTrait("person", person.person_id, dimension, traitValue);
                report.traits += 1;
            }
            const impressions = Array.isArray(profile.impressions) ? profile.impressions : [];
            for (const impression of impressions) {
                const content = impressionText(impression);
                if (!content)
                    continue;
                const meta = impressionMeta(impression);
                if (db.addImpression({ ownerType: "person", ownerId: person.person_id, content, createdAt: meta.createdAt, agentId: meta.agentId, source: meta.source })) {
                    report.impressions += 1;
                }
            }
            report.persons += 1;
        }
        for (const [personId, raw] of Object.entries(personsIndex)) {
            if (!isObject(raw))
                continue;
            const existing = db.getPerson(personId);
            if (!existing) {
                db.createPerson({ personId, name: text(raw.name), createdAt: text(raw.created_at) ?? undefined });
                if (text(raw.call_name))
                    db.updatePerson(personId, { callName: text(raw.call_name) });
                report.persons += 1;
            }
            else if ((text(raw.name) && !existing.name) || text(raw.call_name)) {
                db.updatePerson(personId, {
                    name: text(raw.name) && !existing.name ? text(raw.name) : undefined,
                    callName: text(raw.call_name),
                });
            }
        }
        // Accounts: index entries first, then profile files (profiles carry richer data).
        for (const [, raw] of Object.entries(accountsIndex)) {
            if (!isObject(raw))
                continue;
            const platform = text(raw.platform);
            const senderId = text(raw.sender_id);
            if (!platform || !senderId) {
                report.warnings.push("accounts.json 存在缺少 platform/sender_id 的条目");
                continue;
            }
            const result = db.upsertAccount({
                platform,
                senderId,
                displayName: text(raw.display_name),
                currentRole: text(raw.current_role),
            });
            if (result.created)
                report.accounts += 1;
            if (text(raw.confirmed_name))
                db.setConfirmedName(result.account.account_id, text(raw.confirmed_name));
            if (text(raw.call_name))
                db.setCallName(result.account.account_id, text(raw.call_name));
        }
        for (const profile of accountProfiles) {
            const { raw } = profile;
            const platform = text(raw.platform) ?? profile.platform;
            const senderId = text(raw.sender_id) ?? profile.senderId;
            if (!platform || !senderId)
                continue;
            const account = db.upsertAccount({
                platform,
                senderId,
                displayName: text(raw.display_name),
                firstSeen: text(raw.first_seen) ?? undefined,
                lastInteraction: text(raw.last_interaction) ?? undefined,
            });
            if (account.created)
                report.accounts += 1;
            if (text(raw.call_name))
                db.setCallName(account.account.account_id, text(raw.call_name));
            const traits = isObject(raw.traits) ? raw.traits : {};
            for (const [dimension, value] of Object.entries(traits)) {
                const traitValue = text(value);
                if (!traitValue)
                    continue;
                db.setTrait("account", account.account.account_id, dimension, traitValue);
                report.traits += 1;
            }
            const impressions = Array.isArray(raw.impressions) ? raw.impressions : [];
            for (const impression of impressions) {
                const content = impressionText(impression);
                if (!content)
                    continue;
                const meta = impressionMeta(impression);
                if (db.addImpression({ ownerType: "account", ownerId: account.account.account_id, content, createdAt: meta.createdAt, agentId: meta.agentId, source: meta.source })) {
                    report.impressions += 1;
                }
            }
        }
        // Bindings from index and bridge table.
        const requestedBindings = new Map();
        for (const [, raw] of Object.entries(accountsIndex)) {
            if (!isObject(raw))
                continue;
            const platform = text(raw.platform);
            const senderId = text(raw.sender_id);
            const personId = text(raw.bound_person_id);
            if (platform && senderId && personId) {
                requestedBindings.set(`${platform}:${senderId}`, { personId, method: "manual", confidence: "confirmed" });
            }
        }
        for (const [accountId, raw] of Object.entries(bindingsIndex)) {
            if (!isObject(raw))
                continue;
            const personId = text(raw.person_id);
            if (!personId)
                continue;
            requestedBindings.set(accountId, {
                personId,
                method: text(raw.bind_method) ?? "manual",
                confidence: text(raw.confidence) ?? "confirmed",
            });
        }
        for (const [accountId, binding] of requestedBindings) {
            if (!db.getAccount(accountId)) {
                const separator = accountId.indexOf(":");
                if (separator > 0) {
                    const platform = accountId.slice(0, separator);
                    const senderId = accountId.slice(separator + 1);
                    db.upsertAccount({ platform, senderId, displayName: senderId });
                    report.accounts += 1;
                }
            }
            if (!db.getPerson(binding.personId))
                db.createPerson({ personId: binding.personId });
            if (db.getAccount(accountId)) {
                db.bindAccount(accountId, binding.personId, binding);
                report.bindings += 1;
            }
            else {
                report.warnings.push(`绑定引用了不存在的账号: ${accountId}`);
            }
        }
        // Groups: index first, then richer group files.
        for (const [groupId, raw] of Object.entries(groupsIndex)) {
            if (!isObject(raw))
                continue;
            const platform = text(raw.platform) ?? "unknown";
            const chatId = text(raw.group_id) ?? extractChatId(groupId, platform);
            const result = db.upsertGroup({
                groupId,
                platform,
                chatId,
                displayName: text(raw.displayName) ?? text(raw.display_name),
                subject: text(raw.group_subject),
                botNames: mergeBotNames([], raw.botNames),
            });
            if (result.created)
                report.groups += 1;
        }
        for (const raw of groupProfiles) {
            const platform = text(raw.known_platform) ?? text(raw.platform) ?? inferGroupFromPath(String(raw.__file ?? ""))?.platform ?? "unknown";
            const rawGroupId = text(raw.group_id) ?? text(raw.groupId) ?? "";
            const chatId = text(raw.chat_id) ?? extractChatId(rawGroupId, platform);
            if (!chatId) {
                report.warnings.push("群文件缺少 group_id/chat_id");
                continue;
            }
            const groupId = rawGroupId && rawGroupId.includes(":") ? rawGroupId : `${platform.replace(/\//g, ":")}:${chatId}`;
            const result = db.upsertGroup({
                groupId,
                platform,
                chatId,
                displayName: text(raw.displayName) ?? text(raw.display_name),
                subject: text(raw.group_subject),
                botNames: mergeBotNames(db.getGroup(groupId)?.bot_names ?? [], raw.botNames),
                firstSeen: text(raw.created_at) ?? undefined,
            });
            if (result.created)
                report.groups += 1;
            db.setGroupBotNames(result.group.group_id, mergeBotNames(result.group.bot_names, raw.botNames));
            const members = isObject(raw.members) ? raw.members : {};
            for (const [accountId, memberRaw] of Object.entries(members)) {
                if (!isObject(memberRaw))
                    continue;
                db.upsertGroupMember({
                    groupId: result.group.group_id,
                    accountId,
                    displayName: text(memberRaw.display_name) ?? text(memberRaw.displayName),
                    classification: text(memberRaw.classification) ?? "pending",
                    confidence: text(memberRaw.confidence) ?? "tentative",
                    roleInGroup: text(memberRaw.role_in_group) ?? text(memberRaw.role),
                    at: text(memberRaw.last_seen) ?? text(memberRaw.lastSeen) ?? undefined,
                });
                report.groupMembers += 1;
            }
            const events = Array.isArray(raw.group_memory) ? raw.group_memory : [];
            for (const eventRaw of events) {
                if (typeof eventRaw === "string") {
                    if (db.addGroupEvent({ groupId: result.group.group_id, summary: eventRaw })) {
                        report.groupEvents += 1;
                    }
                    continue;
                }
                if (!isObject(eventRaw))
                    continue;
                const headline = text(eventRaw.summary) ??
                    text(eventRaw.event) ??
                    text(eventRaw.title) ??
                    text(eventRaw.content);
                const detail = text(eventRaw.detail) ?? text(eventRaw.description) ?? text(eventRaw.note);
                const summary = headline && detail && !headline.includes(detail) ? `${headline}：${detail}` : headline;
                if (!summary)
                    continue;
                const tags = Array.isArray(eventRaw.tags)
                    ? eventRaw.tags.filter((tag) => typeof tag === "string")
                    : [];
                if (db.addGroupEvent({
                    groupId: result.group.group_id,
                    summary,
                    category: text(eventRaw.category) ?? "observation",
                    tags,
                    agentId: text(eventRaw.agent_id),
                    occurredAt: text(eventRaw.timestamp) ?? text(eventRaw.occurred_at) ?? undefined,
                })) {
                    report.groupEvents += 1;
                }
            }
            const observations = Array.isArray(raw.group_observations) ? raw.group_observations : [];
            for (const observation of observations) {
                const content = impressionText(observation);
                if (content && db.addGroupObservation(result.group.group_id, content)) {
                    report.groupEvents += 1;
                }
            }
        }
        // Scan state: dict or array.
        if (isObject(scanState)) {
            const channels = scanState.channels;
            const rows = [];
            if (isObject(channels)) {
                for (const [key, value] of Object.entries(channels)) {
                    if (isObject(value))
                        rows.push([key, value]);
                }
            }
            else if (Array.isArray(channels)) {
                for (const value of channels) {
                    if (!isObject(value))
                        continue;
                    const key = text(value.channel_id) ?? text(value.channelId) ?? text(value.key);
                    if (key)
                        rows.push([key, value]);
                }
            }
            for (const [key, value] of rows) {
                db.upsertScanChannel({
                    channelKey: key,
                    sessionKey: text(value.sessionKey) ?? text(value.session_key),
                    displayName: text(value.displayName) ?? text(value.display_name),
                    kind: text(value.kind),
                    platform: text(value.platform),
                    groupId: text(value.group_id),
                    lastScanAt: text(value.lastScanAt) ?? text(value.last_scan_at),
                });
                report.scanChannels += 1;
            }
            db.setScanMeta(text(scanState.lastScanAt) ?? text(scanState.lastFullScanAt));
        }
        db.metaSet("legacy_imported_at", nowIso());
        db.metaSet("legacy_source", dataDir);
        db.metaSet("legacy_mode", "imported-not-authoritative");
    });
    report.imported = true;
    return report;
}
