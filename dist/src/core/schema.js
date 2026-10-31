export const SCHEMA_VERSION = 2;
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_key TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  display_name TEXT,
  confirmed_name TEXT,
  call_name TEXT,
  current_role TEXT,
  bound_person_id TEXT,
  first_seen TEXT NOT NULL,
  last_interaction TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform_key, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_person ON accounts(bound_person_id);
CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts(display_name);

CREATE TABLE IF NOT EXISTS persons (
  person_id TEXT PRIMARY KEY,
  name TEXT,
  call_name TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
  bind_method TEXT NOT NULL DEFAULT 'manual',
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  bound_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_accounts_person ON person_accounts(person_id);

CREATE TABLE IF NOT EXISTS impressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('account','person')),
  owner_id TEXT NOT NULL,
  content TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  source TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(owner_type, owner_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_impressions_owner ON impressions(owner_type, owner_id, created_at);

CREATE TABLE IF NOT EXISTS traits (
  owner_type TEXT NOT NULL CHECK(owner_type IN ('account','person')),
  owner_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_type, owner_id, dimension)
);

CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  display_name TEXT,
  group_subject TEXT,
  bot_names TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform_key, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_groups_chat ON groups(chat_id);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  display_name TEXT,
  classification TEXT NOT NULL DEFAULT 'pending',
  confidence TEXT NOT NULL DEFAULT 'tentative',
  role_in_group TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY(group_id, account_id)
);

CREATE TABLE IF NOT EXISTS group_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'observation',
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(group_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_group_events_group ON group_events(group_id, occurred_at);

CREATE TABLE IF NOT EXISTS group_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(group_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS dimensions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scan_channels (
  workspace_key TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  session_key TEXT,
  display_name TEXT,
  kind TEXT,
  platform TEXT,
  group_id TEXT,
  last_scan_at TEXT,
  PRIMARY KEY(workspace_key, channel_key)
);

CREATE TABLE IF NOT EXISTS scan_meta (
  workspace_key TEXT PRIMARY KEY,
  last_full_scan_at TEXT,
  updated_at TEXT
);
`;
export const DEFAULT_DIMENSIONS = [
    { key: "basic_name", label: "称呼", sort: 10 },
    { key: "basic_origin", label: "所在地", sort: 20 },
    { key: "basic_role", label: "身份", sort: 30 },
    { key: "good_at", label: "擅长", sort: 40 },
    { key: "dislike", label: "反感", sort: 50 },
    { key: "personality", label: "性格", sort: 60 },
    { key: "communicate_style", label: "沟通风格", sort: 70 },
    { key: "preference", label: "偏好", sort: 80 },
    { key: "values", label: "价值观", sort: 90 },
    { key: "relationship", label: "关系", sort: 100 },
    { key: "active_pattern", label: "活跃模式", sort: 110 },
];
