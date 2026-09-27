-- Group admins, the member audit log, and Hafezi GPT (projects, skills, files, conversations,
-- shares, usage). *_at columns are integer milliseconds since the epoch; JSON lives in TEXT.

-- Admins beyond the GitHub org owners (who are always admins). Checked on every request, so a
-- promotion or demotion takes effect without signing in again.
CREATE TABLE IF NOT EXISTS admins (
  login    TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- Who signed in when, and what they did. Metadata only: never chat prompts or answers.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  login       TEXT NOT NULL,
  role        TEXT,
  action      TEXT NOT NULL,          -- auth.login, auth.denied, api.POST, device.create, gpt.message …
  target      TEXT,                   -- a path, device code, conversation id …
  status      INTEGER,
  detail_json TEXT,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_login_at ON audit_log (login, at);
CREATE INDEX IF NOT EXISTS audit_action_at ON audit_log (action, at);

-- ---- Hafezi GPT ----

CREATE TABLE IF NOT EXISTS gpt_projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  instructions      TEXT NOT NULL DEFAULT '',
  visibility        TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'group')),
  owner             TEXT NOT NULL,
  topics_json       TEXT NOT NULL DEFAULT '[]',   -- tag scopes, e.g. ["project/tfln"]
  pinned_slugs_json TEXT NOT NULL DEFAULT '[]',   -- site pages always in context
  default_model     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gpt_projects_owner ON gpt_projects (owner);

CREATE TABLE IF NOT EXISTS gpt_conversations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  owner       TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT 'New chat',
  model       TEXT NOT NULL,
  origin_slug TEXT,                  -- set when the chat began in a page's "Ask Hafezi GPT" modal
  forked_from TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gpt_conversations_owner ON gpt_conversations (owner, updated_at);
CREATE INDEX IF NOT EXISTS gpt_conversations_origin ON gpt_conversations (origin_slug);

-- Uploaded files: attached to a project (project knowledge) or a conversation (one chat).
CREATE TABLE IF NOT EXISTS gpt_files (
  id              TEXT PRIMARY KEY,
  project_id      TEXT,
  conversation_id TEXT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  r2_key          TEXT NOT NULL,
  tokens_est      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gpt_files_project ON gpt_files (project_id);
CREATE INDEX IF NOT EXISTS gpt_files_conversation ON gpt_files (conversation_id);

-- Member-written skills (repo skills come from the build manifest). SKILL.md shaped.
CREATE TABLE IF NOT EXISTS gpt_skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  body        TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'group')),
  owner       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Anthropic content blocks exactly as sent/received, so a chat replays byte-for-byte.
CREATE TABLE IF NOT EXISTS gpt_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json    TEXT NOT NULL,
  meta_json       TEXT,              -- mentions, files, skills, usage, citations for the UI
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gpt_messages_conversation ON gpt_messages (conversation_id, id);

-- Read-only shares. grantee is a GitHub login or '*' for the whole group.
CREATE TABLE IF NOT EXISTS gpt_shares (
  conversation_id TEXT NOT NULL,
  grantee         TEXT NOT NULL,
  shared_by       TEXT NOT NULL,
  shared_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, grantee)
);
CREATE INDEX IF NOT EXISTS gpt_shares_grantee ON gpt_shares (grantee);

CREATE TABLE IF NOT EXISTS gpt_budgets (
  login          TEXT PRIMARY KEY,
  monthly_tokens INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gpt_usage (
  login       TEXT NOT NULL,
  month       TEXT NOT NULL,          -- YYYY-MM (UTC)
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (login, month)
);

INSERT OR IGNORE INTO migrations (id) VALUES ('gpt-audit');
