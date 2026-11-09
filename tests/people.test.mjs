import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PeopleService } from "../dist/src/core/service.js";
import { encodeWorkspaceSegment, resolveStorePaths, resolveWorkspaceRoot } from "../dist/src/core/paths.js";
import { resolvePlatform, platformLookupKey } from "../dist/src/core/platform.js";
import { normalizeConfig } from "../dist/src/plugin/config.js";
import { PeopleRuntime } from "../dist/src/plugin/runtime.js";
import { registerMaintenanceService, readMaintenanceServiceState } from "../dist/src/plugin/service.js";
import { runSemanticMaintenance } from "../dist/src/plugin/maintenance.js";
import { retireLegacyCycleCrons } from "../dist/src/plugin/legacy-cron.js";
import {
  resolveInboundIdentity,
  resolveHookIdentity,
  resolveToolIdentity,
} from "../dist/src/plugin/identity.js";
import {
  authorizeWorkspace,
  canManage,
  createOwnerClaimStore,
  groupMatchesCurrent,
  WRITE_TOOL_NAMES,
} from "../dist/src/plugin/authz.js";
import { IdentityStore } from "../dist/src/plugin/identity-store.js";

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
  assert.equal(resolvePlatform({ provider: "bncr", backend: "tgBot" }), "bncr/tgBot");
  assert.equal(resolvePlatform({ channel: "telegram" }), "telegram");
  assert.equal(resolvePlatform({ channel: "telegram", backend: "default" }), "telegram");
  assert.equal(resolvePlatform({ channel: "discord", backend: "work" }), "discord");
  assert.equal(
    resolvePlatform({ channel: "telegram", backend: "default", overrides: { telegram: "telegram" } }),
    "telegram",
  );
  assert.equal(platformLookupKey("bncr/tgBot"), platformLookupKey("bncr:tgBot"));
  // No alias concept: GewePlus and GolemPlus stay separate platform labels.
  assert.equal(resolvePlatform({ provider: "bncr", backend: "GolemPlus" }), "bncr/GolemPlus");
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
    accountId: "Primary",
    senderId: "u9",
    senderName: "频道昵称",
    isGroup: true,
    conversationId: "-900",
    metadata: {
      to: "Bncr:tgBot:-900:0",
      group_subject: "频道群名",
    },
  });
  const result = await hooks.before_prompt_build(
    { prompt: "hi" },
    { workspaceDir: workspace, agentId: "tester", senderId: "u9", channel: "bncr", accountId: "Primary", chatId: "-900" },
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

test("agent tools trust only the host owner bit and never infer an internal admin", () => {
  // A turn without a sender is unauthenticated; plugin maintenance uses internal calls.
  assert.equal(canManage({ agentId: "main" }), false);
  assert.equal(canManage({}), false);
  assert.equal(canManage({ agentId: "main", requesterSenderId: "u1" }), false);
  assert.equal(canManage({ requesterSenderId: "u1", senderIsOwner: false }), false);
  assert.equal(canManage({ requesterSenderId: "u1", senderIsOwner: true }), true);

  const current = tempWorkspace();
  const other = tempWorkspace();
  assert.equal(authorizeWorkspace(undefined, current), undefined);
  assert.equal(authorizeWorkspace("", current), undefined);
  assert.throws(() => authorizeWorkspace(other, current), /只使用当前会话 agent 的工作区/);
  assert.throws(() => authorizeWorkspace(current, current), /只使用当前会话 agent 的工作区/);
  assert.throws(() => authorizeWorkspace(other, undefined), /无法确认当前会话 agent 的工作区/);
});

test("config keeps write tools on by default and ignores local admin allowlists", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.writeTools, true);
  assert.equal("internalAdminAgents" in defaults, false);

  const strict = normalizeConfig({ internalAdminAgents: ["main", " home "], writeTools: false });
  assert.equal("internalAdminAgents" in strict, false);
  assert.equal(strict.writeTools, false);
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

test("identity resolution uses standard fields, BNCR fallback and no host account ids", () => {
  const config = normalizeConfig({});
  const standard = resolveInboundIdentity({
    channel: "bncr", accountId: "Primary", senderId: "user-1",
    conversationId: "-100",
    metadata: { to: "Bncr:tgBot:-100:0" },
  }, config);
  assert.equal(standard.platform, "bncr/tgBot");
  assert.equal(standard.backend, "tgBot");
  assert.equal(standard.source, "standard");
  assert.equal(standard.chatId, "-100");

  const telegram = resolveInboundIdentity({
    channel: "telegram", accountId: "work", senderId: "user-1",
    conversationId: "-200",
    sessionKey: "agent:main:telegram:group:" + Buffer.from("tgBot:-100", "utf8").toString("hex"),
    metadata: { to: "Bncr:tgBot:-100:0" },
  }, config);
  assert.equal(telegram.platform, "telegram");
  assert.equal(telegram.backend, undefined);
  assert.equal(telegram.source, "standard");
  assert.equal(telegram.chatId, "-200");

  const hex = Buffer.from("Bncr:GewePlus:-300:0", "utf8").toString("hex");
  const fallback = resolveInboundIdentity({
    channel: "bncr", accountId: "Primary", senderId: "user-2",
    sessionKey: "agent:main:bncr:group:" + hex,
    metadata: {},
  }, config);
  assert.equal(fallback.platform, "bncr/GewePlus");
  assert.equal(fallback.source, "session_fallback");
  assert.equal(fallback.chatId, "-300");
  assert.equal(fallback.isGroup, true);

  const standardWins = resolveInboundIdentity({
    channel: "bncr", accountId: "Primary", senderId: "user-2",
    sessionKey: "agent:main:bncr:group:" + hex,
    metadata: { to: "Bncr:tgBot:-100:0" },
  }, config);
  assert.equal(standardWins.platform, "bncr/tgBot");
  assert.equal(standardWins.source, "standard");

  const hook = resolveHookIdentity({
    channel: "bncr", accountId: "Primary", senderId: "user-2",
    chatId: hex,
  }, config, standardWins);
  assert.equal(hook.platform, "bncr/tgBot");
  assert.equal(hook.chatId, "-100");

  const tool = resolveToolIdentity({
    messageChannel: "bncr", agentAccountId: "Primary", requesterSenderId: "user-2",
    nativeChannelId: hex,
    sessionKey: "agent:main:bncr:group:" + hex,
  }, config, standardWins);
  assert.equal(tool.platform, "bncr/tgBot");
  assert.equal(tool.chatId, "-100");
});

test("BNCR standard metadata writes the backend row while Primary stays out of identity", async () => {
  const entry = (await import("../dist/index.js")).default;
  const workspace = tempWorkspace();
  const hooks = {};
  const factories = {};
  let toolCtx = { workspaceDir: workspace, senderIsOwner: true };
  const tools = new Proxy({}, { get: (_, name) => factories[name](toolCtx) });
  const api = {
    pluginConfig: { dataDir: "{workspace}/people" },
    config: { agents: { defaults: { workspace }, entries: {} } },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: (factory) => { const tool = factory(toolCtx); factories[tool.name] = factory; },
    registerCli: () => {},
    id: "people", name: "People", source: "test", registrationMode: "runtime",
  };
  entry.register(api);
  const sessionKey = "agent:main:bncr:group:" + Buffer.from("Bncr:tgBot:-900:0", "utf8").toString("hex");
  await hooks.inbound_claim({
    channel: "bncr", accountId: "Primary", senderId: "u9", senderName: "频道昵称",
    isGroup: true, sessionKey,
    metadata: { to: "Bncr:tgBot:-900:0", group_subject: "频道群名" },
  });
  const injected = await hooks.before_prompt_build(
    { prompt: "hi" },
    { workspaceDir: workspace, agentId: "tester", senderId: "u9", channel: "bncr", accountId: "Primary", chatId: sessionKey.split(":").pop(), sessionKey },
  );
  assert.match(injected.prependContext, /频道昵称/);
  const status = await tools.people_status.execute("status", {});
  assert.match(status.content[0].text, /标准 1/);
  toolCtx = {
    workspaceDir: workspace,
    senderIsOwner: true,
    requesterSenderId: undefined,
    messageChannel: "bncr",
    sessionKey,
  };
  const lookup = await tools.people_lookup.execute(
    "lookup",
    { account: "bncr/tgBot:u9" },
  );
  assert.match(lookup.content[0].text, /频道昵称/);
});

test("standard host to/originatingTo wins over sessionKey fallback and workspace stays isolated", () => {
  const config = normalizeConfig({});
  const hex = Buffer.from("Bncr:GolemPlus:-700:0", "utf8").toString("hex");
  const sessionKey = "agent:main:bncr:group:" + hex;
  const event = {
    senderId: "u-standard",
    senderName: "标准字段",
    sessionKey,
    metadata: {
      channelId: "bncr",
      conversationId: "-700",
      from: "u-standard",
      to: "Bncr:tgBot:-100:0",
      originatingTo: "Bncr:GewePlus:-100:0",
    },
  };
  const standard = resolveInboundIdentity(event, config, { channelId: "bncr", conversationId: sessionKey.split(":").pop() }, "home");
  assert.equal(standard.platform, "bncr/tgBot");
  assert.equal(standard.source, "standard");
  assert.equal(standard.chatId, "-100");

  const hook = resolveHookIdentity(
    { channel: "bncr", senderId: "u-standard", chatId: sessionKey.split(":").pop(), sessionKey },
    config,
    standard,
    "home",
  );
  assert.equal(hook.platform, "bncr/tgBot");

  const store = new IdentityStore();
  store.put({ ...standard, workspaceKey: "home" });
  assert.equal(store.get("home", sessionKey)?.["platform"], "bncr/tgBot");
  assert.equal(store.get("public", sessionKey), undefined);
  store.clear();
});

test("owner lookup works without a current sender account row", async () => {
  const entry = (await import("../dist/index.js")).default;
  const workspace = tempWorkspace();
  const factories = {};
  let toolCtx = { workspaceDir: workspace };
  const tools = new Proxy({}, { get: (_, name) => factories[name](toolCtx) });
  const api = {
    pluginConfig: { dataDir: "{workspace}/people" },
    config: { agents: { defaults: { workspace }, entries: {} } },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: () => {},
    registerTool: (factory) => {
      const tool = factory(toolCtx);
      factories[tool.name] = factory;
    },
    registerCli: () => {},
    id: "people", name: "People", source: "test", registrationMode: "runtime",
  };
  entry.register(api);
  const service = open(workspace);
  service.capture({ platform: "bncr/tgBot", senderId: "target", senderName: "被查的人" });
  service.close();
  toolCtx = { workspaceDir: workspace, senderIsOwner: true, messageChannel: "telegram" };
  const allowed = await tools.people_lookup.execute("lookup", { account: "bncr/tgBot:target" });
  assert.match(allowed.content[0].text, /被查的人/);
  toolCtx = {
    workspaceDir: workspace,
    senderIsOwner: false,
    requesterSenderId: "guest",
    messageChannel: "telegram",
    sessionKey: "agent:main:telegram:direct:guest",
  };
  let deniedError;
  try {
    await tools.people_lookup.execute("lookup", { account: "bncr/tgBot:target" });
  } catch (error) {
    deniedError = error;
  }
  assert.match(deniedError?.message ?? "", /暂时不能查询他人画像/);
});

test("owner authority is only the current host-trusted bit", () => {
  assert.equal(canManage({ requesterSenderId: "owner-1", senderIsOwner: false }), false);
  assert.equal(canManage({ requesterSenderId: "owner-1", senderIsOwner: undefined }), false);
  assert.equal(canManage({ requesterSenderId: "owner-1", senderIsOwner: true }), true);
  assert.equal(
    canManage({ requesterSenderId: "owner-1", senderIsOwner: false, ownerAccountId: "bncr/tgBot:owner-1" }),
    false,
  );
});

test("inbound owner claims match one workspace, session and sender exactly", () => {
  const claims = createOwnerClaimStore();
  const store = new IdentityStore();
  const claim = { workspaceKey: "home", sessionKey: "session-1", senderId: "owner-1" };
  store.ownerClaims.claims.add(["home", "session-1", "owner-1"].join(String.fromCharCode(0)));
  assert.equal(claims.claims.size, 0, "claim state is scoped to its explicit store");
  assert.equal(store.consumeOwnerClaim({ ...claim, workspaceKey: "public" }), false);
  assert.equal(store.consumeOwnerClaim({ ...claim, sessionKey: "session-2" }), false);
  assert.equal(store.consumeOwnerClaim({ ...claim, senderId: "guest" }), false);
  assert.equal(store.ownerClaimState(claim).pending, true);
  assert.equal(store.consumeOwnerClaim(claim), true);
  assert.equal(store.ownerClaimState(claim).pending, false);
  assert.equal(store.consumeOwnerClaim(claim), false, "claim is consumed once");
});

test("blank requester sender is not an internal maintenance authorization", () => {
  assert.equal(canManage({ requesterSenderId: null }), false);
  assert.equal(canManage({ requesterSenderId: "  " }), false);
  assert.equal(canManage({ requesterSenderId: "guest" }), false);
});

test("status is de-identified and diagnostics stay owner-only", async () => {
  const entry = (await import("../dist/index.js")).default;
  const workspace = tempWorkspace();
  const factories = {};
  let toolCtx = {};
  const tools = new Proxy({}, { get: (_, name) => factories[name](toolCtx) });
  const api = {
    pluginConfig: { dataDir: "{workspace}/people", importLegacy: false },
    config: { agents: { defaults: { workspace }, entries: { main: { workspace } } } },
    runtime: {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: () => {},
    registerTool: (factory) => { const tool = factory(toolCtx); factories[tool.name] = factory; },
    registerService: () => {},
    registerCli: () => {},
    id: "people", name: "People", source: "test", registrationMode: "runtime",
  };
  entry.register(api);
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "private-sender", senderName: "隐私姓名" });
  service.remember({ accountId: "telegram:private-sender", content: "住在某个地方" });
  service.close();

  toolCtx = { workspaceDir: workspace, agentId: "main", requesterSenderId: "guest", sessionKey: "guest-session" };
  const status = await tools.people_status.execute("status", {});
  const plain = status.content[0].text;
  assert.match(plain, /识人库状态/);
  assert.doesNotMatch(plain, /dbPath|数据库|workspace|工作区|隐私姓名|private-sender|住在某个地方/);
  await assert.rejects(() => tools.people_health.execute("health", {}), /诊断信息仅 owner/);
  await assert.rejects(() => tools.people_validate.execute("validate", {}), /诊断信息仅 owner/);
  await assert.rejects(() => tools.people_cycle.execute("cycle", {}), /诊断信息仅 owner/);

  toolCtx = { ...toolCtx, senderIsOwner: true };
  for (const name of ["people_status", "people_health", "people_validate"]) {
    const result = await tools[name].execute(name, {});
    assert.match(result.content[0].text, /数据库|dbPath|工作区|识人库健康检查|校验/);
  }
  const ownerCycle = await tools.people_cycle.execute("cycle", {});
  assert.match(ownerCycle.content[0].text, /识人维护|后台 service/);

  const other = tempWorkspace();
  await assert.rejects(() => tools.people_status.execute("status", { workspace: other }), /只使用当前会话 agent 的工作区/);
});

test("a fresh host owner event replaces the single-use claim", async () => {
  const store = new IdentityStore();
  const event = {
    channel: "telegram", platform: "telegram", source: "standard",
    sessionKey: "session-1", runId: "run-1", senderId: "owner-1",
    senderIsOwner: true, workspaceKey: "home", at: Date.now(),
  };
  store.put(event);
  assert.equal(store.consumeOwnerClaim({ workspaceKey: "home", sessionKey: "session-1", senderId: "owner-1" }), true);
  assert.equal(store.consumeOwnerClaim({ workspaceKey: "home", sessionKey: "session-1", senderId: "owner-1" }), false);
  store.put({ ...event, runId: "run-2", at: Date.now() + 1 });
  assert.equal(store.consumeOwnerClaim({ workspaceKey: "home", sessionKey: "session-1", senderId: "owner-1" }), true);

  const passive = new IdentityStore();
  passive.put({ ...event, runId: "run-3", senderIsOwner: undefined, at: Date.now() });
  assert.equal(passive.consumeOwnerClaim({ workspaceKey: "home", sessionKey: "session-1", senderId: "owner-1" }), false);
});

test("retired cron cleanup removes only plugin-owned cycle jobs", async () => {
  const jobs = [
    { id: "cycle-home", name: "people-cycle-home", description: "旧识人任务" },
    { id: "cycle-public", name: "people-cycle-public", description: "people_cycle" },
    { id: "scan-public", name: "people-scan-public", description: "识人扫描" },
    { id: "declaration", name: "people-cycle-declarative", description: "识人周期维护", declarationKey: "people:cycle" },
    { id: "custom", name: "people-cycle-custom", description: "用户自建任务" },
    { id: "custom-reference", name: "people-cycle-custom", description: "people_cycle 文档备份" },
    { id: "other", name: "daily-sync", description: "people_cycle 文档备份" },
    { id: "person-scan-wind", name: "person-scan-wind", description: "旧识人任务" },
    { id: "person-scan-rain", name: "person-scan-rain", description: "旧识人任务" },
    { id: "declared-payload", name: "people-cycle-managed", description: "托管周期", declarationKey: "people:cycle", payload: { kind: "agentTurn", message: "people_cycle 周期维护" } },
    { id: "declared-no-evidence", name: "people-cycle-declared", description: "用户托管任务", declarationKey: "people:custom", payload: { kind: "agentTurn", message: "自有维护" } },
  ];
  const removed = [];
  const cron = {
    list: async () => jobs,
    remove: async (id) => { removed.push(id); return { removed: true }; },
  };
  const api = { logger: { info: () => {}, warn: () => {} } };
  assert.equal(await retireLegacyCycleCrons(() => cron, api), 7);
  assert.deepEqual(removed, ["cycle-home", "cycle-public", "scan-public", "declaration", "person-scan-wind", "person-scan-rain", "declared-payload"]);
  assert.ok(jobs.some((job) => job.id === "custom-reference"), "user job with a tool name in its description is preserved");
  assert.ok(jobs.some((job) => job.id === "declared-no-evidence"), "user-declared job without plugin cycle evidence is preserved");
  assert.equal(await retireLegacyCycleCrons(undefined, api), 0);
});

test("inbound identity cache is workspace scoped and can be bound later", () => {
  const home = new IdentityStore();
  const publicStore = new IdentityStore();
  const sessionKey = "agent:main:bncr:group:shared-session";
  const identity = {
    channel: "bncr",
    backend: "tgBot",
    platform: "bncr/tgBot",
    source: "standard",
    sessionKey,
    runId: "run-1",
    senderId: "u-isolated",
    at: Date.now(),
  };
  home.put(identity);
  assert.equal(home.get(undefined, sessionKey), undefined);
  home.registerWorkspace(sessionKey, "home");
  assert.equal(home.get("home", sessionKey)?.platform, "bncr/tgBot");
  assert.equal(home.get("public", sessionKey), undefined);
  assert.equal(publicStore.get("home", sessionKey), undefined);
  home.clear();
  assert.equal(home.get("home", sessionKey), undefined);
});

test("BNCR canonical target and a single-use inbound owner claim stay in one session", async () => {
  const entry = (await import("../dist/index.js")).default;
  const workspace = tempWorkspace();
  const hooks = {};
  const factories = {};
  let toolCtx = {};
  const tools = new Proxy({}, { get: (_, name) => factories[name](toolCtx) });
  const api = {
    pluginConfig: { dataDir: "{workspace}/people" },
    config: { agents: { defaults: { workspace }, entries: {} } },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: (factory) => { const tool = factory(toolCtx); factories[tool.name] = factory; },
    registerCli: () => {},
    id: "people",
    name: "People",
    source: "test",
    registrationMode: "runtime",
  };
  entry.register(api);
  const service = open(workspace);
  service.capture({ platform: "bncr/tgBot", senderId: "target-2", senderName: "被查的人 2" });
  service.close();
  const sessionKey = "agent:main:bncr:group:" + Buffer.from("Bncr:tgBot:-901:0", "utf8").toString("hex");
  await hooks.inbound_claim({
    channel: "bncr",
    accountId: "Primary",
    senderId: "owner-1",
    senderIsOwner: true,
    isGroup: true,
    sessionKey,
    metadata: { to: "Bncr:tgBot:-901:0" },
  });
  toolCtx = {
    workspaceDir: workspace,
    agentId: "tester",
    requesterSenderId: "owner-1",
    messageChannel: "bncr",
    sessionKey: "agent:main:bncr:group:other-session",
  };
  let otherSessionError;
  try {
    await tools.people_lookup.execute("lookup", { account: "bncr/tgBot:target-2" });
  } catch (error) {
    otherSessionError = error;
  }
  assert.match(otherSessionError?.message ?? "", /暂时不能查询他人画像/);
  toolCtx = { ...toolCtx, sessionKey };
  const allowed = await tools.people_lookup.execute("lookup", { account: "bncr/tgBot:target-2" });
  assert.match(allowed.content[0].text, /被查的人 2/);
  let laterTurnError;
  try {
    await tools.people_lookup.execute("lookup", { account: "bncr/tgBot:target-2" });
  } catch (error) {
    laterTurnError = error;
  }
  assert.match(laterTurnError?.message ?? "", /暂时不能查询他人画像/);
  const otherWorkspace = tempWorkspace();
  toolCtx = { ...toolCtx, workspaceDir: otherWorkspace };
  let deniedError;
  try {
    await tools.people_lookup.execute("lookup", { account: "bncr/tgBot:target-2" });
  } catch (error) {
    deniedError = error;
  }
  assert.match(deniedError?.message ?? "", /暂时不能查询他人画像|没有找到账号/);
});

test("a host-only owner claim is admitted before owner-gated tool checks", async () => {
  const entry = (await import("../dist/index.js")).default;
  const workspace = tempWorkspace();
  const hooks = {};
  const factories = {};
  let toolCtx = {};
  const tools = new Proxy({}, { get: (_, name) => factories[name](toolCtx) });
  const api = {
    pluginConfig: { dataDir: "{workspace}/people", importLegacy: false },
    config: { agents: { defaults: { workspace }, entries: { main: { workspace } } } },
    runtime: {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: (factory) => { const tool = factory(toolCtx); factories[tool.name] = factory; },
    registerService: () => {},
    registerCli: () => {},
    id: "people", name: "People", source: "test", registrationMode: "runtime",
  };
  entry.register(api);
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "claim-target", senderName: "目标" });
  service.close();
  const sessionKey = "agent:main:telegram:direct:claim-session";
  await hooks.inbound_claim({
    channel: "telegram", senderId: "owner-2", senderIsOwner: true, isGroup: false, sessionKey,
    metadata: { conversationId: "claim-session" },
  });
  toolCtx = {
    workspaceDir: workspace, agentId: "main", requesterSenderId: "owner-2",
    messageChannel: "telegram", sessionKey,
  };
  const plainStatus = await tools.people_status.execute("status", {});
  assert.doesNotMatch(plainStatus.content[0].text, /数据库|工作区/, "status is a non-privileged view");
  const health = await tools.people_health.execute("health", {});
  assert.match(health.content[0].text, /识人库健康检查/);
  await assert.rejects(
    () => tools.people_health.execute("health", {}),
    /诊断信息仅 owner/,
    "the claim is consumed once",
  );
});

test("plugin-owned maintenance compacts profiles through an isolated completion", async () => {
  const workspace = tempWorkspace();
  const service = open(workspace);
  service.capture({ platform: "telegram", senderId: "compact-owner", senderName: "压缩对象" });
  for (let index = 0; index < 14; index += 1) {
    service.remember({ accountId: "telegram:compact-owner", content: `事实 ${index}` });
  }
  const cycle = service.cycle({ backupKeep: 2, forceBackup: true });
  const action = cycle.actions.find((item) => item.kind === "compact");
  assert.ok(action);
  const before = service.db.listImpressions("account", "telegram:compact-owner", 50);
  const complete = async (request) => {
    const prompt = JSON.parse(request.message);
    assert.equal(prompt.ownerId, "telegram:compact-owner");
    assert.ok(prompt.impressions.length > 3);
    assert.ok(prompt.allowedDimensions.some((dimension) => dimension.key === "preference"));
    return JSON.stringify({
      dimensions: [{ dimension: "preference", value: "有 14 条可核验事实" }],
      coveredIds: prompt.impressions.slice(0, -2).map((item) => item.id),
      keepIds: prompt.impressions.slice(-2).map((item) => item.id),
    });
  };
  const result = await runSemanticMaintenance({
    service,
    actions: cycle.actions,
    complete,
    agentId: "main",
    signal: AbortSignal.timeout(10_000),
    validateOk: cycle.health.ok,
    lastBackupAt: cycle.health.lastBackupAt,
  });
  assert.equal(result.processed, 1);
  assert.equal(result.compacted, 1);
  assert.equal(result.failed, 0);
  const after = service.db.listImpressions("account", "telegram:compact-owner", 50);
  assert.equal(after.length, 2, "covered originals are removed inside the plugin");
  assert.ok(after.length < before.length);
  assert.equal(
    service.db.getTraits("account", "telegram:compact-owner").find((trait) => trait.dimension === "preference")?.value,
    "有 14 条可核验事实",
  );
  service.close();
});

test("background service schedules one cycle per distinct workspace", async () => {
  const homeWorkspace = tempWorkspace();
  const publicWorkspace = tempWorkspace();
  let registration;
  const scheduled = [];
  const api = {
    pluginConfig: { dataDir: "{workspace}/people", importLegacy: false },
    config: {
      agents: {
        defaults: { workspace: homeWorkspace },
        entries: {
          main: { workspace: homeWorkspace },
          orion: { workspace: homeWorkspace },
          public: { workspace: publicWorkspace },
        },
      },
    },
    runtime: {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  };
  const runtime = new PeopleRuntime(api);
  registerMaintenanceService({ ...api, registerService: (svc) => { registration = svc; } }, runtime);
  assert.ok(registration);
  const serviceState = readMaintenanceServiceState(runtime);
  assert.ok(serviceState);
  const scheduler = {
    signal: new AbortController().signal,
    schedule: (job) => { scheduled.push(job); return { cancel() {}, async stop() {} }; },
  };
  const failures = [];
  const serviceHealth = { reportFailure: (error) => failures.push(error), clearFailure: () => {} };
  await registration.start({ scheduler, config: api.config, workspaceDir: homeWorkspace, serviceHealth });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].everyMs, 6 * 60 * 60_000);
  assert.equal(scheduled[0].mode, "replace");
  const hosts = runtime.resolveMaintenanceWorkspaces({ config: api.config });
  assert.equal(hosts.length, 2, "home and public are distinct; main/orion share one");
  assert.equal(serviceState.startedAt.length > 0, true);
  const homeStatus = open(homeWorkspace).status();
  assert.equal(homeStatus.maintenance.active, true);
  assert.equal(homeStatus.maintenance.startedAt, serviceState.startedAt);
  await scheduled[0].run();
  assert.equal(failures.length, 0, "scheduled cycle completes in the test host");
  const completed = open(homeWorkspace).status();
  assert.equal(completed.maintenance.completedAt, serviceState.completedAt);
  const secondRuntime = new PeopleRuntime(api);
  const persisted = secondRuntime.maintenanceSummary({ workspaceDir: homeWorkspace, agentId: "main" });
  assert.equal(persisted?.healthOk, true);
  assert.equal(typeof persisted?.cycledAt, "string");
  secondRuntime.closeAll();
  await registration.stop({ scheduler, config: api.config });
  assert.equal(readMaintenanceServiceState(runtime), null);
  assert.equal(open(homeWorkspace).status().maintenance.active, false);
});

test("owner-only maintenance diagnostics can be triggered from the host bit", async () => {
  const workspace = tempWorkspace();
  const entry = (await import("../dist/index.js")).default;
  const hooks = {};
  const factories = {};
  let toolCtx = {};
  const tools = new Proxy({}, { get: (_, name) => factories[name](toolCtx) });
  const api = {
    pluginConfig: { dataDir: "{workspace}/people", importLegacy: false },
    config: { agents: { defaults: { workspace }, entries: { main: { workspace } } } },
    runtime: {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: (factory) => { const tool = factory(toolCtx); factories[tool.name] = factory; },
    registerService: () => {},
    registerCli: () => {},
    id: "people",
    name: "People",
    source: "test",
    registrationMode: "runtime",
  };
  entry.register(api);
  toolCtx = { workspaceDir: workspace, agentId: "main" };
  await assert.rejects(
    () => tools.people_cycle.execute("cycle", { run: true }),
    /诊断信息仅 owner 可查看/,
  );
  toolCtx = { workspaceDir: workspace, agentId: "main", senderIsOwner: true };
  const result = await tools.people_cycle.execute("cycle", { run: true });
  assert.match(result.content[0].text, /识人维护摘要|识人维护周期/);
  assert.doesNotMatch(result.content[0].text, /事实 \d+|压缩对象/);
});

test("maintenance service startup and stop failures are persisted in the workspace DB", async () => {
  const workspace = tempWorkspace();
  const api = {
    pluginConfig: { dataDir: "{workspace}/people", importLegacy: false },
    config: { agents: { defaults: { workspace }, entries: { main: { workspace } } } },
    runtime: {},
    logger: { info: () => {}, warn: () => {} },
  };
  const runtime = new PeopleRuntime(api);
  let registration;
  registerMaintenanceService({ ...api, registerService: (svc) => { registration = svc; } }, runtime);
  const failures = [];
  const serviceHealth = { reportFailure: (error) => failures.push(error), clearFailure: () => {} };
  await assert.rejects(
    () => registration.start({ config: api.config, workspaceDir: workspace, serviceHealth }),
    /requires host scheduler/,
  );
  let status = open(workspace).status();
  assert.equal(status.maintenance.active, false);
  assert.equal(status.maintenance.lastError, "people-maintenance requires host scheduler (apiVersion 2)");
  assert.ok(status.maintenance.stoppedAt);
  assert.equal(failures.length, 1);

  runtime.closeAll();
  const emptyRuntime = new PeopleRuntime({ ...api, pluginConfig: { ...api.pluginConfig }, config: { agents: { entries: {} } } });
  let noHostRegistration;
  registerMaintenanceService({ ...api, registerService: (svc) => { noHostRegistration = svc; } }, emptyRuntime);
  const scheduler = {
    signal: new AbortController().signal,
    schedule: () => ({ cancel() {}, async stop() {} }),
  };
  await noHostRegistration.start({ scheduler, config: { agents: { entries: {} } }, workspaceDir: workspace, serviceHealth });
  status = open(workspace).status();
  assert.equal(status.maintenance.active, false);
  assert.equal(status.maintenance.lastError, "no enabled workspace agents");
  assert.equal(readMaintenanceServiceState(emptyRuntime).lastError, "no enabled workspace agents");
  await noHostRegistration.stop({ scheduler });
  assert.equal(readMaintenanceServiceState(emptyRuntime), null);
  emptyRuntime.closeAll();
});
