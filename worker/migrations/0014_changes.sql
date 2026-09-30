-- The site's activity (src/changes.ts), like MediaWiki's recentchanges: each change to a file of
-- either vault, and what members did on the site to make one. Git keeps the content; this is the
-- index behind /recent and each member's contributions. The Worker writes rows as members act
-- (drafts sent, merged, refused or discarded; People page publishes), and every members deploy
-- imports both vaults' commits (tools/changes-import.mjs), changes made outside the site included.
-- A commit's file is one row: the import skips what the Worker already wrote (changes_commit).
CREATE TABLE IF NOT EXISTS changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,          -- ms: a commit's author time, or when the site acted
  login       TEXT COLLATE NOCASE,       -- the member's GitHub login, when known
  author      TEXT NOT NULL,             -- the name shown
  repo        TEXT NOT NULL CHECK (repo IN ('vault', 'vault-private')),
  path        TEXT NOT NULL,             -- the file, after the change
  from_path   TEXT,                      -- a rename's old path
  slug        TEXT,                      -- its page on the site, when it is one
  kind        TEXT NOT NULL CHECK (kind IN ('new', 'edit', 'rename', 'delete', 'upload', 'profile')),
  -- draft: saved, not sent; sent: its pull request waits for its hour; review: it waits for an
  -- admin; failed: its check failed; conflict: main changed the same file; merged: in the vault;
  -- discarded: taken back, or closed on GitHub
  state       TEXT NOT NULL CHECK (state IN
                ('draft', 'sent', 'review', 'failed', 'conflict', 'merged', 'discarded')),
  -- What a public feed could ever show: merged changes to the public vault.
  visibility  TEXT GENERATED ALWAYS AS
                (CASE WHEN repo = 'vault' AND state = 'merged' THEN 'public' ELSE 'members' END),
  summary     TEXT NOT NULL DEFAULT '',  -- the commit's or pull request's title
  commit_sha  TEXT,                      -- the commit on main, once merged
  pr_number   INTEGER,
  draft_id    TEXT,                      -- the site's draft (upload_drafts.id)
  added       INTEGER,                   -- lines, for pages
  removed     INTEGER,
  bytes       INTEGER,                   -- an upload's size
  source      TEXT NOT NULL CHECK (source IN ('site', 'git'))
);
CREATE UNIQUE INDEX IF NOT EXISTS changes_commit ON changes (repo, commit_sha, path)
  WHERE commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS changes_at ON changes (at);
CREATE INDEX IF NOT EXISTS changes_page ON changes (repo, path, at);
CREATE INDEX IF NOT EXISTS changes_login ON changes (login, at);
CREATE INDEX IF NOT EXISTS changes_draft ON changes (draft_id) WHERE draft_id IS NOT NULL;

INSERT OR IGNORE INTO migrations (id) VALUES ('changes');
