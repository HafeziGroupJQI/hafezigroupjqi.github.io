-- Access rules for restricted pages (src/acl/): named groups of members (GitHub logins, or People
-- pages for those without one yet) and rules over vault paths, each a file, a folder ("dir/") or a
-- glob, whose most specific match decides who reads a path (src/acl/policy.ts). Admins edit them in
-- /admin; every change bumps acl_meta.version and is committed to vault-private as
-- .hafezi/acl.json, which the members site's build reads.
CREATE TABLE IF NOT EXISTS acl_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,     -- group:<name> in a rule
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acl_group_members (
  group_id INTEGER NOT NULL REFERENCES acl_groups (id) ON DELETE CASCADE,
  login    TEXT COLLATE NOCASE,         -- a GitHub login, lowercase
  person   TEXT,                        -- or a People page, people/<slug>
  added_by TEXT,
  added_at INTEGER,
  CHECK ((login IS NULL) != (person IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS acl_group_members_login ON acl_group_members (group_id, login)
  WHERE login IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS acl_group_members_person ON acl_group_members (group_id, person)
  WHERE person IS NOT NULL;

CREATE TABLE IF NOT EXISTS acl_rules (
  id         TEXT PRIMARY KEY,            -- r<n>, never reused (acl_meta.next_rule)
  pattern    TEXT NOT NULL,
  allow_json TEXT NOT NULL DEFAULT '[]',  -- principals: group:<name>, login:<login>, person:people/<slug>
  deny_json  TEXT NOT NULL DEFAULT '[]',
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acl_meta (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  version           INTEGER NOT NULL,     -- bumped by every change
  next_rule         INTEGER NOT NULL,     -- the number of the next rule's id
  updated_at        INTEGER,
  committed_version INTEGER,              -- the last version committed to vault-private
  committed_at      INTEGER
);

-- The first group: the optical RL project (HafeziGroupJQI/vault-optical-rl, mounted at
-- projects/optical-rl/). Three of its people have GitHub logins in the org; the others are in it
-- by their People page, which counts once they sign in and their claim of it is approved.
INSERT OR IGNORE INTO acl_meta (id, version, next_rule, updated_at)
  VALUES (1, 1, 2, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO acl_groups (name, description, created_by, created_at)
  VALUES ('optical-rl', 'Optical PPO / optical RL project', 'migration',
          CAST(strftime('%s', 'now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO acl_group_members (group_id, login, person, added_by, added_at)
  SELECT g.id, json_extract(m.value, '$.login'), json_extract(m.value, '$.person'), 'migration',
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM acl_groups g, json_each('[
    {"login": "anishgoyal1108"}, {"login": "lidaxu-physics"}, {"login": "mjalalim3"},
    {"person": "people/mohammad-hafezi"}, {"person": "people/lida-xu"},
    {"person": "people/anish-goyal"}, {"person": "people/mahmoud-jalali-mehrabad"},
    {"person": "people/pavel-dolgirev"}, {"person": "people/shi-yuan-ma"}
  ]') m
  WHERE g.name = 'optical-rl';
INSERT OR IGNORE INTO acl_rules (id, pattern, allow_json, deny_json, note, created_by, updated_at)
  VALUES ('r1', 'projects/optical-rl/', '["group:optical-rl"]', '[]',
          'the optical rl project (vault-optical-rl)', 'migration',
          CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- The site's activity names each change's repository: restricted vaults (worker/vaults.json, e.g.
-- vault-optical-rl) are repositories of their own. SQLite can't change a CHECK in place, so the
-- table is made again with one that takes any vault-* repository, its rows, indexes and generated
-- column kept.
CREATE TABLE changes_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  login       TEXT COLLATE NOCASE,
  author      TEXT NOT NULL,
  repo        TEXT NOT NULL CHECK (repo = 'vault' OR repo GLOB 'vault-[a-z0-9]*'),
  path        TEXT NOT NULL,
  from_path   TEXT,
  slug        TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('new', 'edit', 'rename', 'delete', 'upload', 'profile')),
  state       TEXT NOT NULL CHECK (state IN
                ('draft', 'sent', 'review', 'failed', 'conflict', 'merged', 'discarded')),
  visibility  TEXT GENERATED ALWAYS AS
                (CASE WHEN repo = 'vault' AND state = 'merged' THEN 'public' ELSE 'members' END),
  summary     TEXT NOT NULL DEFAULT '',
  commit_sha  TEXT,
  pr_number   INTEGER,
  draft_id    TEXT,
  added       INTEGER,
  removed     INTEGER,
  bytes       INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('site', 'git'))
);
INSERT INTO changes_new (id, at, login, author, repo, path, from_path, slug, kind, state, summary,
                         commit_sha, pr_number, draft_id, added, removed, bytes, source)
  SELECT id, at, login, author, repo, path, from_path, slug, kind, state, summary, commit_sha,
         pr_number, draft_id, added, removed, bytes, source
  FROM changes;
DROP TABLE changes;
ALTER TABLE changes_new RENAME TO changes;
CREATE UNIQUE INDEX IF NOT EXISTS changes_commit ON changes (repo, commit_sha, path)
  WHERE commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS changes_at ON changes (at);
CREATE INDEX IF NOT EXISTS changes_page ON changes (repo, path, at);
CREATE INDEX IF NOT EXISTS changes_login ON changes (login, at);
CREATE INDEX IF NOT EXISTS changes_draft ON changes (draft_id) WHERE draft_id IS NOT NULL;

INSERT OR IGNORE INTO migrations (id) VALUES ('acl');
