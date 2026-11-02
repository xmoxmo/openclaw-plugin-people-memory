import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PeopleService } from "../dist/src/core/service.js";
import { encodeWorkspaceSegment, resolveStorePaths, resolveWorkspaceRoot } from "../dist/src/core/paths.js";
import { resolvePlatform, platformLookupKey } from "../dist/src/core/platform.js";
import { normalizeConfig } from "../dist/src/plugin/config.js";
import {
  authorizeWorkspace,
  canManage,
  groupMatchesCurrent,
  isInternalAdmin,
  WRITE_TOOL_NAMES,
} from "../dist/src/plugin/authz.js";

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "people-test-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function open(workspace, config = {}) {
  const paths = resolveStorePaths({ workspaceDir: workspace, config: { dataDir: "{workspace}/people" } });
  return new PeopleService({ paths, config: { importLegacy: true, ...config } });
}

test("platform labels stay channel neutral", () => {
  assert.equal(resolvePlatform({ provider: "bncr", accountId: "tgBot" }), "bncr/tgBot");
  assert.equal(resolvePlatform({ channel: "telegram" }), "telegram");
  assert.equal(resolvePlatform({ channel: "telegram", accountId: "default" }), "telegram");
  assert.equal(resolvePlatform({ channel: "discord", accountId: "work" }), "discord/work");
  assert.equal(
    resolvePlatform({ channel: "telegram", accountId: "default", overrides: { telegram: "telegram" } }),
    "telegram",
  );
  assert.equal(platformLookupKey("bncr/tgBot"), platformLookupKey("bncr:tgBot"));
  // No alias concept: GewePlus and GolemPlus stay separate platform labels.
  assert.equal(resolvePlatform({ provider: "bncr", accountId: "GolemPlus" }), "bncr/GolemPlus");
  assert.equal(resolvePlatform({ metadataPlatform: "bncr/GolemPlus" }), "bncr/GolemPlus");
});

test("CLI agent workspace follows OpenClaw default and per-agent directory rules", () => {
  const config = {
    agents: {
      defaults: { workspace: "/srv/openclaw/workspace" },
      entries: {
        main: { workspace: "/srv/openclaw/workspace" },
        orion: { workspace: "/srv/openclaw/workspace" },
        public: {},
        work: { workspace: "/srv/other-work" },
      },
    },
  };
  assert.equal(resolveWorkspaceRoot(config, "main"), "/srv/openclaw/workspace");
  assert.equal(resolveWorkspaceRoot(config, "orion"), "/srv/openclaw/workspace");
  assert.equal(resolveWorkspaceRoot(config, "public"), path.join("/srv/openclaw/workspace", "public"));
  assert.equal(resolveWorkspaceRoot(config, "work"), "/srv/other-work");
  assert.equal(resolveWorkspaceRoot(config, "new-agent"), path.join("/srv/openclaw/workspace", "new-agent"));
});

test("default data dir lives under stateDir/plugins/people and is per workspace", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "people-state-"));
  const wsA = tempWorkspace();
  const wsB = tempWorkspace();

  const a = resolveStorePaths({ workspaceDir: wsA, stateDir });
  const aAgain = resolveStorePaths({ workspaceDir: wsA, stateDir });
  const b = resolveStorePaths({ workspaceDir: wsB, stateDir });

  assert.equal(a.dbPath, path.join(stateDir, "plugins", "people", encodeWorkspaceSegment(wsA), "people.db"));
  assert.equal(a.dbPath, aAgain.dbPath, "same workspace resolves to the same database");
  assert.notEqual(a.dbPath, b.dbPath, "different workspaces resolve to different databases");

  // An explicit workspace-relative override still wins over the stateDir default.
  const pinned = resolveStorePaths({ workspaceDir: wsA, stateDir, config: { dataDir: "{workspace}/people" } });
  assert.equal(pinned.dbPath, path.join(wsA, "people", "people.db"));
});

test("legacy import handles wrapped groups, dict scan state and duplicate group files", () => {
  const workspace = tempWorkspace();
  const root = path.join(workspace, "people");
  writeJson(path.join(root, "accounts.json"), {
    _schema_version: 1,
    "telegram:u1": { platform: "telegram", sender_id: "u1", display_name: "甲", call_name: "甲哥" },
  });
  writeJson(path.join(root, "accounts/telegram/u1.json"), {
    _schema_version: 1,
    platform: "telegram",
    sender_id: "u1",
    first_seen: "2026-01-01T00:00:00+08:00",
    last_interaction: "2026-01-02T00:00:00+08:00",
    impressions: ["喜欢喝咖啡"],
    traits: { basic_origin: "青岛" },
  });
  writeJson(path.join(root, "persons.json"), {
    _schema_version: 1,
    p_9: { person_id: "p_9", name: "丙", call_name: "丙哥" },
  });
  writeJson(path.join(root, "persons/p_9.json"), { person_id: "p_9", name: "丙", call_name: "丙哥" });
  writeJson(path.join(root, "person_accounts.json"), { _schema_version: 1 });
  writeJson(path.join(root, "groups.json"), {
    _schema_version: 1,
    groups: {
      "telegram:-100": { displayName: "测试群", platform: "telegram", group_id: "-100" },
    },
  });
  const groupBody = {
    group_id: "telegram:-100",
    known_platform: "telegram",
    displayName: "测试群",
    members: { "telegram:u1": { display_name: "甲", classification: "likely_human" } },
    group_memory: [{ timestamp: "2026-01-01T10:00:00+08:00", event: "第一条", detail: "细节" }],
    group_observations: ["群观察"],
  };
  writeJson(path.join(root, "groups/telegram_-100.json"), groupBody);
  writeJson(path.join(root, "groups/telegram:-100:0.json"), {
    ...groupBody,
    group_memory: [{ timestamp: "2026-01-02T10:00:00+08:00", event: "第二条" }],
  });
  writeJson(path.join(root, "scan-state.json"), {
    _schema_version: 1,
    lastScanAt: "2026-01-02T00:00:00+08:00",
    channels: { "telegram:-100": { displayName: "测试群", kind: "group", lastScanAt: "2026-01-02T00:00:00+08:00" } },
  });
  writeJson(path.join(root, "trait-dimensions.json"), {
    _schema_version: 1,
    dimensions: [{ key: "basic_origin", label: "所在地", active: true }],
  });

  const service = open(workspace);
  const counts = service.status().counts;
  assert.equal(counts.accounts, 1);
  assert.equal(counts.groups, 1);
  assert.equal(counts.group_events, 2);
  assert.equal(counts.scan_channels, 1);
  assert.equal(service.snapshot("telegram:u1").traits[0].value, "青岛");
  assert.equal(service.db.getAccount("telegram:u1").call_name, "甲哥");
  assert.equal(service.snapshot("telegram:u1").displayName, "甲哥");
  assert.equal(service.db.getPerson("p_9").call_name, "丙哥");
  assert.ok(service.validate().ok);
  service.close();
});

test("group references resolve across prefixes and platform aliases", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  const captured = service.capture({
    platform: "GewePlus",
    senderId: "u3",
    senderName: "丙",
    chatId: "100000000001",
    chatTitle: "测试群",
    isGroup: true,
  });
  assert.ok(captured.groupId);
  const expected = captured.groupId;
  assert.equal(service.resolveGroup("100000000001").group_id, expected);
  assert.equal(service.resolveGroup("GewePlus:100000000001").group_id, expected);
  // Cross-backend chat ids are independent group rows; the legacy GolemPlus
  // alias form must not resolve to the GewePlus row.
  // Lookup stays tolerant of legacy prefixes, but never creates or merges rows:
  // the GewePlus record is the only row for this chat id.
  assert.equal(service.resolveGroup("Bncr:GolemPlus:100000000001:0")?.group_id, "GewePlus:100000000001");
  assert.equal(service.db.findGroupsByChatAll("100000000001").length, 1);
  assert.equal(service.resolveGroup("no-such-group"), null);
  service.capture({ platform: "bncr/GewePlus", senderId: "u4", senderName: "丁" });
  assert.equal(service.searchAccounts("bncr:GewePlus:u4").length, 1);
  assert.equal(service.searchAccounts("bncr/GewePlus:u4").length, 1);
  service.close();
});

test("trait dimensions accept configured labels as well as keys", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.db.upsertAccount({ platform: "telegram", senderId: "label1", displayName: "标签" });
  service.remember({ accountId: "telegram:label1", content: "不喜欢长篇", dimension: "反感" });
  const traits = service.db.getTraits("account", "telegram:label1");
  assert.equal(traits.find((trait) => trait.dimension === "dislike")?.value, "不喜欢长篇");
});

test("capture, remember, bind and forget keep one workspace store consistent", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  const capture = service.capture({
    platform: "telegram",
    senderId: "u2",
    senderName: "乙",
    chatId: "-200",
    chatTitle: "第二个群",
    isGroup: true,
  });
  assert.equal(capture.accountId, "telegram:u2");
  assert.equal(capture.groupId, "telegram:-200");

  service.remember({ accountId: "telegram:u2", content: "我在青岛", dimension: "basic_origin" });
  assert.equal(service.snapshot("telegram:u2").traits[0].value, "我在青岛");

  service.setName({ accountId: "telegram:u2", callName: "二哥" });
  assert.equal(service.snapshot("telegram:u2").displayName, "二哥");

  const bound = service.bind({ accountId: "telegram:u2", name: "乙" });
  assert.equal(bound.createdPerson, true);
  const snapshot = service.snapshot("telegram:u2");
  assert.equal(snapshot.ownerType, "person");
  assert.equal(snapshot.traits[0].value, "我在青岛");
  assert.equal(service.snapshot("telegram:u2").displayName, "二哥");
  service.setName({ accountId: "telegram:u2", callName: "二哥" });
  assert.equal(service.snapshot("telegram:u2").displayName, "二哥");
  assert.ok(service.formatLookup(service.db.getAccount("telegram:u2")).includes("称呼 ┆ 二哥"));

  const note = service.note({ groupId: capture.groupId, summary: "群规：周五复盘", category: "rule" });
  assert.equal(note.stored, true);
  assert.equal(service.formatGroup(service.db.getGroup(capture.groupId)).includes("周五复盘"), true);

  const forgotten = service.forget({ accountId: "telegram:u2", match: "青岛" });
  assert.equal(forgotten.impressions, 1);
  assert.equal(forgotten.traits, 1);
  assert.ok(service.validate().ok);
  service.close();
});

test("a symlinked people directory is one shared store", () => {
  const root = tempWorkspace();
  const first = path.join(root, "one");
  const second = path.join(root, "two");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const people = path.join(first, "people");
  fs.mkdirSync(people, { recursive: true });
  fs.symlinkSync(people, path.join(second, "people"), "dir");

  const a = open(first);
  const b = open(second);
  assert.equal(a.paths.workspaceKey, b.paths.workspaceKey);
  a.capture({ platform: "telegram", senderId: "u3", senderName: "丙" });
  assert.equal(b.db.getAccount("telegram:u3").display_name, "丙");
  a.close();
  b.close();
});

test("inbound identity fills sender name when channelContext is absent", async () => {
  const entry = (await import("../dist/index.js")).default;
  const workspace = tempWorkspace();
  const hooks = {};
  const api = {
    pluginConfig: { dataDir: "{workspace}/people" },
    config: { agents: { defaults: { workspace }, entries: {} } },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => {
      hooks[name] = handler;
    },
    registerTool: () => {},
    registerCli: () => {},
    id: "people",
    name: "People",
    source: "test",
    registrationMode: "runtime",
  };
  entry.register(api);
  await hooks.inbound_claim({
    channel: "bncr",
    accountId: "tgBot",
    senderId: "u9",
    senderName: "频道昵称",
    isGroup: true,
    conversationId: "-900",
    metadata: { group_subject: "频道群名" },
  });
  const result = await hooks.before_prompt_build(
    { prompt: "hi" },
    { workspaceDir: workspace, agentId: "tester", senderId: "u9", channel: "bncr", accountId: "tgBot", chatId: "-900" },
  );
  assert.match(result.prependContext, /频道昵称/);
  assert.match(result.prependContext, /频道群名/);
});

test("backup, health, merge, unbind and search support a self-managed workspace", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "a1", senderName: "甲" });
  service.capture({ platform: "telegram", senderId: "a2", senderName: "乙" });
  service.remember({ accountId: "telegram:a1", content: "我在杭州", dimension: "basic_origin" });
  service.remember({ accountId: "telegram:a2", content: "我喜欢喝茶", dimension: "preference" });

  const firstPerson = service.bind({ accountId: "telegram:a1", name: "甲" });
  const secondPerson = service.bind({ accountId: "telegram:a2", name: "乙" });
  assert.notEqual(firstPerson.personId, secondPerson.personId);

  const merged = service.mergePersons(secondPerson.personId, firstPerson.personId);
  assert.equal(merged.accounts, 1);
  assert.equal(merged.impressions, 1);
  assert.equal(service.db.getPerson(secondPerson.personId), null);
  assert.equal(service.snapshot("telegram:a2").ownerId, firstPerson.personId);

  const unbound = service.unbind("telegram:a2", true);
  assert.equal(unbound.impressionsCopied, 2);
  assert.equal(service.snapshot("telegram:a2").ownerType, "account");
  assert.equal(service.snapshot("telegram:a2").impressions.length, 2);

  const search = service.search("杭州");
  assert.ok(search.impressions.length >= 1);

  const dimension = service.upsertDimension("sleep_habit", "作息", true, 120);
  assert.equal(dimension.active, true);

  const before = service.health();
  assert.equal(before.lastBackupAt, null);
  const backup = service.backup(2);
  assert.ok(fs.existsSync(backup.dbBackup));
  assert.ok(fs.existsSync(backup.jsonBackup));
  assert.ok(JSON.parse(fs.readFileSync(backup.jsonBackup, "utf8")).accounts.length >= 2);
  const after = service.health();
  assert.ok(after.lastBackupAt);

  const secondBackup = service.backup(2);
  assert.notEqual(secondBackup.dbBackup, backup.dbBackup);
  assert.equal(fs.readdirSync(backup.backupDir).filter((name) => name.endsWith(".db")).length, 2);

  for (let index = 0; index < 13; index += 1) {
    service.remember({ accountId: "telegram:a1", content: `周期测试事实 ${index}` });
  }
  const cycle = service.cycle({ backupKeep: 2, forceBackup: true });
  assert.ok(cycle.backup);
  assert.ok(cycle.actions.some((action) => action.kind === "compact" && action.target.startsWith("p_")));
  assert.match(service.contextCard({ accountId: "telegram:a1" }), /维护待办/);
  service.close();
});

test("person-level profiles can be compacted without an account target", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "p1", senderName: "己" });
  const bound = service.bind({ accountId: "telegram:p1", name: "己" });
  for (let index = 0; index < 13; index += 1) {
    service.remember({ accountId: "telegram:p1", content: `人物级待归并事实 ${index}` });
  }

  const cycle = service.cycle({ backupKeep: 2, forceBackup: true });
  const compact = cycle.actions.find((action) => action.kind === "compact");
  assert.equal(compact?.ownerType, "person");
  assert.equal(compact?.target, bound.personId);
  assert.match(service.formatPersonLookup(bound.personId), /人物级待归并事实/);
  const detail = service.formatProfileDetail(service.personSnapshot(bound.personId));
  assert.match(detail, /零散印象 13 条/);
  assert.match(detail, /\[\d+\] 人物级待归并事实/);

  const remembered = service.remember({
    personId: bound.personId,
    content: "喜欢喝绿茶",
    dimension: "preference",
    mode: "replace",
  });
  assert.equal(remembered.traitUpdated, true);
  assert.equal(remembered.impressionStored, false);
  assert.equal(service.personSnapshot(bound.personId)?.impressions.length, 13);
  const removed = service.forget({
    personId: bound.personId,
    match: "人物级待归并事实",
    scope: "impressions",
  });
  assert.equal(removed.impressions, 13);
  assert.equal(removed.traits, 0);
  const snapshot = service.personSnapshot(bound.personId);
  assert.equal(snapshot?.traits.find((trait) => trait.dimension === "preference")?.value, "喜欢喝绿茶");
  assert.equal(snapshot?.impressions.length, 0);
  service.close();
});

test("system auto-rows are skipped and same-family duplicates auto-merge", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);

  const skipped = service.capture({
    platform: "bncr",
    senderId: "bncr-history-system",
    chatId: "-100",
    isGroup: true,
    agentId: "t",
  });
  assert.equal(skipped.accountId, null);
  assert.equal(service.db.getAccountByPlatformSender("bncr", "bncr-history-system"), null);
  assert.equal(skipped.groupId, undefined, "bare bncr writes are deferred, no bare group row");

  const backend = service.capture({
    platform: "bncr/tgBot",
    senderId: "bncr-history-system",
    chatId: "-100",
    isGroup: true,
    agentId: "t",
  });
  assert.equal(backend.accountId, null);
  assert.ok(backend.groupId, "the group itself is created on the backend-qualified platform");

  service.db.upsertAccount({ platform: "bncr", senderId: "42", displayName: "bare" });
  service.db.upsertAccount({ platform: "bncr/GewePlus", senderId: "42", displayName: "gplus" });
  service.db.upsertAccount({ platform: "bncr/GolemPlus", senderId: "42", displayName: "gle" });
  service.db.addImpression({ ownerType: "account", ownerId: "bncr/GewePlus:42", content: "我在青岛", agentId: "t" });
  service.db.addImpression({ ownerType: "account", ownerId: "bncr/GolemPlus:42", content: "喜欢喝茶", agentId: "t" });

  const actions = service.repair();
  assert.match(actions.join(" "), /同族归并/);
  const gewe = service.db.getAccount("bncr/GewePlus:42");
  const golem = service.db.getAccount("bncr/GolemPlus:42");
  assert.ok(gewe && golem, "same-sender family rows stay separate account records");
  assert.equal(gewe.bound_person_id, golem.bound_person_id);
  assert.ok(gewe.bound_person_id);
  // Impressions moved to the shared person.
  assert.equal(service.db.countImpressions("account", "bncr/GewePlus:42"), 0);
  assert.equal(service.db.countImpressions("account", "bncr/GolemPlus:42"), 0);
  const person = service.db.getPerson(gewe.bound_person_id);
  assert.equal(service.db.countImpressions("person", person.person_id), 2);
  // The bare channel row is migrated onto the newest backend row and dropped.
  assert.equal(service.db.getAccount("bncr:42"), null);

  service.close();
});

test("bare multi-channel writes defer and route to the backend row", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);

  const first = service.capture({ platform: "bncr", senderId: "77" });
  assert.equal(first.accountId, null, "brand-new bare bncr sender is deferred");
  assert.equal(service.db.getAccountByPlatformSender("bncr", "77"), null);

  const backend = service.capture({ platform: "bncr/tgBot", senderId: "77", senderName: "ta" });
  assert.equal(backend.accountId, "bncr/tgBot:77");

  const reroute = service.capture({ platform: "bncr", senderId: "77" });
  assert.equal(reroute.accountId, null, "bare writes never land on a backend row they were not addressed to");
  assert.equal(service.db.getAccountByPlatformSender("bncr", "77"), null, "no bare row is created");

  const target = service.resolveWriteTarget("bncr", "77");
  assert.equal(target.kind, "deferred");
  // Lookup falls back to this channel's same-sender rows (most recent first).
  assert.equal(service.resolveAccountForLookup("bncr", "77")?.account_id, "bncr/tgBot:77");
  // A second backend row for the same sender is not a duplicate: lookups fall
  // back to the most recently active row, and writes still defer.
  service.capture({ platform: "bncr/GewePlus", senderId: "77", senderName: "gw" });
  const fallback = service.resolveAccountForLookup("bncr", "77");
  assert.ok(fallback && (fallback.account_id === "bncr/tgBot:77" || fallback.account_id === "bncr/GewePlus:77"));
  assert.equal(service.resolveWriteTarget("bncr", "77").kind, "deferred");

  const deferredChat = service.capture({ platform: "bncr", senderId: "88", chatId: "g1", chatTitle: "t1", isGroup: true });
  assert.equal(deferredChat.groupId, undefined, "deferred writes do not spawn bare group rows");
  const backendGroup = service.capture({ platform: "bncr/GewePlus", senderId: "88", senderName: "x", chatId: "g1", isGroup: true });
  assert.ok(backendGroup.groupId);
  const titled = service.capture({ platform: "bncr", senderId: "88", chatId: "g1", chatTitle: "t2", isGroup: true });
  assert.equal(titled.groupId, backendGroup.groupId, "subject sync still reaches the existing group");
  assert.equal(service.db.getGroup(backendGroup.groupId).group_subject, "t2");
  assert.equal(service.db.countGroupMembers(backendGroup.groupId), 1);
  service.close();
});

test("same-sender family rows auto-bind to one person", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);

  // Both sides loose: one new person is created and both rows migrate into it.
  service.capture({ platform: "bncr/GewePlus", senderId: "u5", senderName: "小五" });
  service.capture({ platform: "bncr/GolemPlus", senderId: "u5", senderName: "小五" });
  service.db.addImpression({ ownerType: "account", ownerId: "bncr/GewePlus:u5", content: "gplus fact" });
  service.db.addImpression({ ownerType: "account", ownerId: "bncr/GolemPlus:u5", content: "golem fact" });
  service.repair();
  const gewe = service.db.getAccount("bncr/GewePlus:u5");
  const golem = service.db.getAccount("bncr/GolemPlus:u5");
  assert.ok(gewe?.bound_person_id && golem?.bound_person_id);
  assert.equal(gewe.bound_person_id, golem.bound_person_id);
  assert.equal(service.db.countImpressions("person", gewe.bound_person_id), 2);

  // One side already bound: the other side joins that person, not a new one.
  service.capture({ platform: "bncr/GewePlus", senderId: "u6", senderName: "小六" });
  const bound = service.bind({ accountId: "bncr/GewePlus:u6", name: "小六" });
  service.capture({ platform: "bncr/GolemPlus", senderId: "u6", senderName: "小六" });
  assert.equal(service.db.getAccount("bncr/GolemPlus:u6").bound_person_id, bound.personId);
  assert.equal(service.db.listAllPersons().length, 2);

  // Conflicting manual bindings are reported, never auto-merged.
  service.capture({ platform: "bncr/GewePlus", senderId: "u7", senderName: "小七" });
  service.capture({ platform: "bncr/GolemPlus", senderId: "u7", senderName: "小七" });
  service.bind({ accountId: "bncr/GewePlus:u7", name: "小七" });
  service.bind({ accountId: "bncr/GolemPlus:u7", name: "小七别名" });
  const before = service.health().issues.filter((issue) => issue.code === "person_binding_conflict").length;
  assert.equal(before, 1);
  service.repair();
  assert.equal(
    service.db.getAccount("bncr/GewePlus:u7").bound_person_id !== service.db.getAccount("bncr/GolemPlus:u7").bound_person_id,
    true,
    "conflicting bindings stay untouched",
  );
  assert.equal(service.health().issues.filter((issue) => issue.code === "person_binding_conflict").length, 1);
  const cycle = service.cycle({ backupKeep: 2, forceBackup: true });
  assert.ok(cycle.actions.some((action) => action.message.includes("同族接入绑到不同人物")));

  // Bot rows are excluded from family binding entirely.
  service.db.upsertAccount({ platform: "bncr/GewePlus", senderId: "bot7", displayName: "samplebot" });
  service.db.upsertAccount({ platform: "bncr/GolemPlus", senderId: "bot7", displayName: "samplebot" });
  service.db.setAccountRole("bncr/GewePlus:bot7", "bot");
  service.repair();
  assert.equal(service.db.getAccount("bncr/GewePlus:bot7").bound_person_id, null);
  assert.equal(service.db.getAccount("bncr/GolemPlus:bot7").bound_person_id, null);

  // Non-family same-sender rows (tgBot vs qqBot) are never auto-bound.
  service.capture({ platform: "bncr/tgBot", senderId: "u8", senderName: "小八" });
  service.capture({ platform: "bncr/qqBot", senderId: "u8", senderName: "小八" });
  service.repair();
  assert.equal(service.db.getAccount("bncr/tgBot:u8").bound_person_id, null);
  assert.equal(service.db.getAccount("bncr/qqBot:u8").bound_person_id, null);

  // Naming follows call_name > confirmed_name > display_name.
  service.capture({ platform: "bncr/GewePlus", senderId: "u9", senderName: "平台昵称" });
  service.setName({ accountId: "bncr/GewePlus:u9", confirmedName: "自述名" });
  service.capture({ platform: "bncr/GolemPlus", senderId: "u9", senderName: "平台昵称" });
  assert.equal(service.db.getPerson(service.db.getAccount("bncr/GewePlus:u9").bound_person_id).name, "自述名");
  const person = service.db.getPerson(service.db.getAccount("bncr/GewePlus:u9").bound_person_id);
  assert.equal(person.name, "自述名");

  service.close();
});

test("same sender ids stay isolated across separately configured sender families", () => {
  const workspace = tempWorkspace();
  const service = open(workspace, {
    senderFamilies: [
      ["family-a/one", "family-a/two"],
      ["family-b/one", "family-b/two"],
    ],
  });

  for (const platform of ["family-a/one", "family-a/two", "family-b/one", "family-b/two"]) {
    service.capture({ platform, senderId: "shared-id", senderName: "同名" });
  }
  service.repair();

  const a1 = service.db.getAccount("family-a/one:shared-id");
  const a2 = service.db.getAccount("family-a/two:shared-id");
  const b1 = service.db.getAccount("family-b/one:shared-id");
  const b2 = service.db.getAccount("family-b/two:shared-id");
  assert.ok(a1?.bound_person_id && a2?.bound_person_id && b1?.bound_person_id && b2?.bound_person_id);
  assert.equal(a1.bound_person_id, a2.bound_person_id);
  assert.equal(b1.bound_person_id, b2.bound_person_id);
  assert.notEqual(a1.bound_person_id, b1.bound_person_id);
  assert.equal(service.db.listAllPersons().length, 2);
  service.close();
});

test("group rows stay independent per backend and ambiguity is reported", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.capture({ platform: "bncr/GewePlus", senderId: "u1", senderName: "a", chatId: "g9", chatTitle: "g9", isGroup: true });
  service.capture({ platform: "bncr/GolemPlus", senderId: "u2", senderName: "b", chatId: "g9", isGroup: true });
  const geweGroup = service.db.getGroup("bncr:GewePlus:g9");
  const golemGroup = service.db.getGroup("bncr:GolemPlus:g9");
  assert.ok(geweGroup && golemGroup, "same chat id on two accesses is two group records");
  assert.equal(service.db.countGroupEvents(geweGroup.group_id), 0);
  assert.equal(service.db.countGroupEvents(golemGroup.group_id), 0);

  service.db.addGroupEvent({ groupId: geweGroup.group_id, summary: "gplus only" });
  service.repair();
  assert.ok(service.db.getGroup("bncr:GewePlus:g9"));
  assert.ok(service.db.getGroup("bncr:GolemPlus:g9"));
  assert.equal(service.db.countGroupEvents(geweGroup.group_id), 1);
  assert.equal(service.db.countGroupEvents(golemGroup.group_id), 0, "no cross-backend event copy");
  assert.ok(!service.health().issues.some((issue) => issue.code === "duplicate_group"));

  // A bare chat id that maps to several backend rows must raise ambiguity.
  const matches = service.db.findGroupsByChatAll("g9");
  assert.equal(matches.length, 2);
  assert.throws(() => service.resolveGroupStrict("g9"), /多个后端/);
  service.close();
});

test("repair backfills orphan members, drops placeholders and empty persons", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);

  // Owner sender appears in a group under a platform-less id.
  service.db.upsertAccount({ platform: "bncr/tgBot", senderId: "100000000002", displayName: "tester" });
  const bound = service.bind({ accountId: "bncr/tgBot:100000000002", name: "owner" });
  service.db.upsertGroup({ groupId: "bncr:tgBot:-100000000003", platform: "bncr/tgBot", chatId: "-100000000003" });
  service.db.upsertGroupMember({
    groupId: "bncr:tgBot:-100000000003",
    accountId: "100000000002",
    classification: "confirmed_human",
    role_in_group: "owner",
  });
  service.db.upsertGroupMember({
    groupId: "bncr:tgBot:-100000000003",
    accountId: "bncr/system:cron",
    displayName: "cron-system",
    classification: "likely_bot",
  });

  const actions = service.repair();
  assert.match(actions.join(" "), /补建成员账号 100000000002/);
  assert.match(actions.join(" "), /移除系统成员 bncr\/system:cron/);

  const backfilled = service.db.getAccount("bncr/tgBot:100000000002");
  assert.ok(backfilled, "platform-less member id gets a backend-qualified account row");
  assert.equal(backfilled.bound_person_id, bound.personId, "owner sender joins the existing person");
  assert.equal(
    service.db.listAllGroupMembers().some((m) => m.account_id === "bncr/system:cron"),
    false,
    "system member row is dropped",
  );
  assert.ok(!service.validate().issues.some((i) => i.code === "orphan_member"));

  // Bot members get an index row marked as bot, with no person.
  service.db.upsertGroupMember({
    groupId: "bncr:tgBot:-100000000003",
    accountId: "bncr/tgBot:999",
    classification: "likely_bot",
  });
  service.repair();
  assert.equal(service.db.getAccount("bncr/tgBot:999").current_role, "bot");
  assert.equal(service.db.getAccount("bncr/tgBot:999").bound_person_id, null);

  // A person with no binding, data or notes is a placeholder and gets dropped.
  service.db.createPerson({ personId: "p_deadbeef", name: "空壳" });
  service.repair();
  assert.equal(service.db.getPerson("p_deadbeef"), null);

  // Notes are treated as a deliberate placeholder and are kept.
  service.db.createPerson({ personId: "p_keepme", name: "待绑定", notes: "等 owner 确认" });
  service.repair();
  assert.ok(service.db.getPerson("p_keepme"));

  // Accounts without a name fall back to the sender id.
  service.db.upsertAccount({ platform: "bncr/GewePlus", senderId: "wxid_noname" });
  service.repair();
  assert.equal(service.db.getAccount("bncr/GewePlus:wxid_noname").display_name, "wxid_noname");

  service.close();
});

test("accounts that are group bots get marked as bot", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.capture({ platform: "bncr/GewePlus", senderId: "bot1", senderName: "fire", chatId: "g1", isGroup: true });
  service.db.setGroupBotNames("bncr:GewePlus:g1", ["fire"]);
  service.remember({ accountId: "bncr/GewePlus:bot1", content: "fire is a group bot" });
  service.capture({ platform: "bncr/GewePlus", senderId: "bot2", senderName: "samplebot", chatId: "g1" });
  service.db.upsertGroupMember({ groupId: "bncr:GewePlus:g1", accountId: "bncr/GewePlus:bot2", classification: "likely_bot" });
  service.remember({ accountId: "bncr/GewePlus:bot2", content: "sample fact" });

  const before = service.health().issues;
  assert.ok(before.some((x) => x.code === "bot_profile_unmarked" && x.message.includes("bot1")));
  assert.ok(before.some((x) => x.code === "bot_profile_unmarked" && x.message.includes("bot2")));
  service.repair();
  assert.equal(service.db.getAccount("bncr/GewePlus:bot1").current_role, "bot");
  assert.equal(service.db.getAccount("bncr/GewePlus:bot2").current_role, "bot");
  const after = service.health().issues;
  assert.ok(!after.some((x) => x.code === "bot_profile_unmarked"));
  service.close();
});


test("workspace key does not collide on underscore vs path separator", () => {
  assert.notEqual(encodeWorkspaceSegment("/a/b"), encodeWorkspaceSegment("/a__b"));
  // Backward compatible: a plain path keeps its previous directory name.
  assert.equal(encodeWorkspaceSegment("/root/.openclaw/workspace"), "root__.openclaw__workspace");
  assert.notEqual(encodeWorkspaceSegment("/a/中"), encodeWorkspaceSegment("/a/文"));
  assert.notEqual(encodeWorkspaceSegment("/a\\b"), encodeWorkspaceSegment("/a/b"));
});

test("merging accounts preserves conflicting trait values instead of dropping them", () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "m1", senderName: "源" });
  service.capture({ platform: "telegram", senderId: "m2", senderName: "目标" });
  service.remember({ accountId: "telegram:m1", content: "住在杭州", dimension: "basic_origin" });
  service.remember({ accountId: "telegram:m2", content: "住在青岛", dimension: "basic_origin" });

  service.mergeAccounts("telegram:m1", "telegram:m2");

  const traits = service.db.getTraits("account", "telegram:m2");
  const origin = traits.find((trait) => trait.dimension === "basic_origin");
  assert.equal(origin.value, "住在青岛", "target keeps its own trait value");
  const impressions = service.db.listImpressions("account", "telegram:m2", 50);
  assert.ok(
    impressions.some(
      (impression) => impression.content.includes("合并保留特征 basic_origin") && impression.content.includes("住在杭州"),
    ),
    "source conflict is preserved as an impression",
  );
});

test("strict internal admin is opt-in and keeps the compatible default", () => {
  // Default: an internal turn (no requester sender) keeps historical admin access.
  assert.equal(canManage({ agentId: "main" }, {}), true);
  assert.equal(isInternalAdmin({ agentId: "main" }, {}), true);

  // A normal non-owner sender never manages other profiles.
  assert.equal(canManage({ requesterSenderId: "u1", senderIsOwner: false }, {}), false);
  // Owner always manages.
  assert.equal(canManage({ requesterSenderId: "u1", senderIsOwner: true }, {}), true);

  // Strict mode: only listed agents act as internal admins.
  const strict = { internalAdminAgents: ["main"] };
  assert.equal(canManage({ agentId: "main" }, strict), true);
  assert.equal(canManage({ agentId: "public" }, strict), false);
  // A public gateway run has no sender and no known agent id.
  assert.equal(canManage({}, strict), false);
  // An explicit empty list denies all internal admin without affecting owner.
  assert.equal(canManage({ agentId: "main" }, { internalAdminAgents: [] }), false);
  assert.equal(canManage({ requesterSenderId: "u1", senderIsOwner: true }, { internalAdminAgents: [] }), true);

  // Internal maintenance identities cannot switch to another workspace.
  const current = tempWorkspace();
  const other = tempWorkspace();
  assert.equal(authorizeWorkspace({ agentId: "main" }, current, current), current);
  assert.throws(() => authorizeWorkspace({ agentId: "main" }, other, current), /只有 owner/);
  assert.equal(authorizeWorkspace({ requesterSenderId: "u1", senderIsOwner: true }, other, current), other);
});

test("config keeps write tools on by default and accepts strict mode", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.writeTools, true);
  assert.equal(defaults.internalAdminAgents, undefined);

  const strict = normalizeConfig({ internalAdminAgents: ["main", " home "], writeTools: false });
  assert.deepEqual(strict.internalAdminAgents, ["main", "home"]);
  assert.equal(strict.writeTools, false);

  assert.deepEqual(normalizeConfig({ internalAdminAgents: [] }).internalAdminAgents, []);
  assert.equal(WRITE_TOOL_NAMES.has("people_merge_account"), true);
});

test("group access matches the current conversation across id forms", () => {
  const group = { group_id: "bncr/tgBot:123", chat_id: "123" };
  assert.equal(groupMatchesCurrent(group, "123"), true);
  assert.equal(groupMatchesCurrent(group, "bncr/tgBot:123"), true);
  assert.equal(groupMatchesCurrent(group, "456"), false);
  assert.equal(groupMatchesCurrent(group, undefined), false);
});

test("forget purge removes backups and legacy archives only when requested", () => {
  const workspace = tempWorkspace();
  const root = path.join(workspace, "people");
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "p1", senderName: "Purge" });
  service.remember({ accountId: "telegram:p1", content: "秘密甲" });
  service.remember({ accountId: "telegram:p1", content: "秘密乙" });

  // Legacy archive that still carries personal details.
  writeJson(path.join(root, "accounts.json"), { _schema_version: 1, accounts: [] });
  writeJson(path.join(root, "trait-dimensions.json"), { dimensions: [] });
  fs.mkdirSync(path.join(root, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(root, "accounts", "legacy.json"), "{}");

  service.backup();
  assert.ok(fs.existsSync(path.join(root, "backups")), "backup exists before purge");

  // Default forget leaves backups and legacy archive alone.
  service.forget({ accountId: "telegram:p1", match: "秘密甲" });
  assert.ok(fs.existsSync(path.join(root, "backups")), "default forget keeps backups");
  assert.ok(fs.existsSync(path.join(root, "accounts.json")), "default forget keeps legacy archive");

  const result = service.forget({ accountId: "telegram:p1", match: "秘密乙", purge: true });
  assert.equal(result.impressions, 1);
  assert.ok(result.purged && result.purged.files >= 1);
  assert.equal(service.db.listImpressions("account", "telegram:p1", 50).length, 0);
  assert.equal(fs.existsSync(path.join(root, "backups")), false, "purge removes backups");
  assert.equal(fs.existsSync(path.join(root, "accounts.json")), false, "purge removes legacy index");
  assert.equal(fs.existsSync(path.join(root, "trait-dimensions.json")), false, "purge removes legacy dimensions");
  assert.equal(fs.existsSync(path.join(root, "accounts")), false, "purge removes legacy accounts dir");
  service.close();
  const wal = path.join(root, "people.db-wal");
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, "purge truncates the WAL");
});
