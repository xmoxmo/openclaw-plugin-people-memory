export type PeoplePluginConfig = {
  dataDir?: string;
  workspaceDataDirs?: Record<string, string>;
  databaseFile?: string;
  injectContext?: boolean;
  injectGroupMemory?: boolean;
  injectMaxChars?: number;
  disabledAgents?: string[];
  capture?: boolean;
  captureGroups?: boolean;
  captureSkipSenders?: string[];
  writeTools?: boolean;
  importLegacy?: boolean;
  platformTemplate?: string;
  multiAccountChannels?: string[];
  platformOverrides?: Record<string, string>;
  senderFamilies?: string[][];
  debug?: boolean;
};

export type ResolvedStorePaths = {
  workspaceDir: string;
  dataDir: string;
  dbPath: string;
  workspaceKey: string;
};

export type BotHint = "unknown" | "human" | "bot" | "mixed";
export type BotHintSource = "history" | "group_evidence" | "manual";

export type AccountRecord = {
  account_id: string;
  platform: string;
  sender_id: string;
  display_name: string | null;
  confirmed_name: string | null;
  call_name: string | null;
  current_role: string | null;
  bot_hint: BotHint;
  bot_hint_source: BotHintSource | null;
  first_seen: string;
  last_interaction: string;
  updated_at: string;
  bound_person_id?: string | null;
};

export type PersonRecord = {
  person_id: string;
  name: string | null;
  call_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Impression = {
  id: number;
  owner_type: "account" | "person";
  owner_id: string;
  content: string;
  source: string | null;
  agent_id: string | null;
  created_at: string;
};

export type Trait = {
  dimension: string;
  value: string;
  confidence: string | null;
  updated_at: string;
};

export type Dimension = {
  key: string;
  label: string;
  active: boolean;
  sort: number;
};

export type GroupRecord = {
  group_id: string;
  platform: string;
  chat_id: string;
  display_name: string | null;
  group_subject: string | null;
  bot_names: string[];
  first_seen: string;
  updated_at: string;
};

export type GroupEvent = {
  id: number;
  group_id: string;
  occurred_at: string;
  category: string;
  summary: string;
  tags: string[];
  agent_id: string | null;
};

export type GroupMember = {
  group_id: string;
  account_id: string;
  display_name: string | null;
  classification: string;
  confidence: string;
  role_in_group: string | null;
  first_seen: string;
  last_seen: string;
};

export type ProfileSnapshot = {
  ownerType: "account" | "person";
  ownerId: string;
  account: AccountRecord | null;
  person: PersonRecord | null;
  displayName: string;
  traits: Trait[];
  impressions: Impression[];
};

export type WriteTarget =
  | { kind: "direct"; platform: string }
  | { kind: "deferred"; platform: null };

export type CaptureInput = {
  platform: string;
  senderId: string;
  senderName?: string;
  chatId?: string;
  chatTitle?: string;
  isGroup?: boolean;
  agentId?: string;
  role?: string;
  source?: "explicit" | "standard" | "session_fallback" | "deferred";
};

export type CaptureResult = {
  accountId: string | null;
  created: boolean;
  displayNameChanged: boolean;
  groupId?: string;
  groupCreated?: boolean;
};

export type ValidationIssue = {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
};

export type ValidationReport = {
  ok: boolean;
  dataDir: string;
  dbPath: string;
  counts: Record<string, number>;
  issues: ValidationIssue[];
};

export type StatusReport = {
  workspaceDir: string;
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  counts: Record<string, number>;
  dimensions: Dimension[];
  lastFullScanAt: string | null;
  legacyImportedAt: string | null;
  capture: {
    lastAt: string | null;
    deferredAt: string | null;
    standardCount: number;
    sessionFallbackCount: number;
    deferredCount: number;
  };
  maintenance: {
    active: boolean;
    startedAt: string | null;
    stoppedAt: string | null;
    intervalMs: number | null;
    scheduledAt: string | null;
    completedAt: string | null;
    lastSummary: string | null;
    lastError: string | null;
  };
  security: {
    ownerFromHost: true;
    writeTools: boolean;
  };
};

export type BackupReport = {
  backupDir: string;
  dbBackup: string;
  jsonBackup: string;
  dbBytes: number;
  jsonBytes: number;
  removedOld: number;
  kept: number;
};

export type HealthReport = {
  ok: boolean;
  dataDir: string;
  dbPath: string;
  counts: Record<string, number>;
  issues: ValidationIssue[];
  lastBackupAt: string | null;
  capture: StatusReport["capture"];
};

export type SearchReport = {
  accounts: AccountRecord[];
  persons: PersonRecord[];
  impressions: Impression[];
  groupEvents: GroupEvent[];
};

export type CycleAction = {
  kind: "compact" | "merge_review" | "observe";
  target: string;
  ownerType?: "account" | "person";
  message: string;
};

export type CycleReport = {
  cycledAt: string;
  backup: BackupReport | null;
  backupSkipped: boolean;
  repairActions: string[];
  health: HealthReport;
  actions: CycleAction[];
  lastCycleAt: string | null;
};

export type LegacyImportReport = {
  imported: boolean;
  reason?: string;
  sourceDir: string;
  accounts: number;
  persons: number;
  bindings: number;
  groups: number;
  groupEvents: number;
  groupMembers: number;
  impressions: number;
  traits: number;
  scanChannels: number;
  warnings: string[];
};
