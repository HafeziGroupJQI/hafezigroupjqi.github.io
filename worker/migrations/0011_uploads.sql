-- Members' uploads to vault-private (src/uploads/). A draft is one change set: files added,
-- replaced, renamed or deleted, the new bytes staged in R2 under uploads/<id>/<path>. Sending it
-- makes a branch and a draft pull request on GitHub; the hourly cron merges it at the end of the
-- hour after it was last sent, once vault-private's validate check passes, so it can be revised
-- for at least one full hour. A draft with anything in it that runs waits for an admin instead.
CREATE TABLE IF NOT EXISTS upload_drafts (
  id           TEXT PRIMARY KEY,
  login        TEXT NOT NULL COLLATE NOCASE,
  note         TEXT NOT NULL DEFAULT '',
  -- editing: never sent; open: a pull request waits for its hour; failed: its check failed;
  -- conflict: main changed under it; review: checked, and waits for an admin to merge it on
  -- GitHub (something in it runs); merged; discarded (by the member or an admin)
  status       TEXT NOT NULL DEFAULT 'editing' CHECK (status IN
                 ('editing', 'open', 'failed', 'conflict', 'review', 'merged', 'discarded')),
  title        TEXT,             -- its commit's and pull request's title, as last sent
  branch       TEXT,             -- uploads/<login>/<id>, once sent
  pr_number    INTEGER,
  head_sha     TEXT,             -- the commit last sent
  detail_json  TEXT,             -- {message, url}: why it failed or was dropped
  created_at   INTEGER NOT NULL,
  edited_at    INTEGER NOT NULL, -- the last change to its files or note: after sent_at, not sent yet
  sent_at      INTEGER,
  due_at       INTEGER,          -- merged by the first hourly run at or after this, checks passing
  merged_at    INTEGER,
  merge_sha    TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_drafts_login ON upload_drafts (login, updated_at);
CREATE INDEX IF NOT EXISTS upload_drafts_due ON upload_drafts (status, due_at);

CREATE TABLE IF NOT EXISTS upload_changes (
  draft_id     TEXT NOT NULL REFERENCES upload_drafts (id) ON DELETE CASCADE,
  path         TEXT NOT NULL,    -- the file's path after the change (a deleted file's own)
  action       TEXT NOT NULL CHECK (action IN ('add', 'replace', 'rename', 'delete')),
  from_path    TEXT,             -- rename: where the file was
  base_sha     TEXT,             -- replace, rename, delete: its blob at main when staged
  size         INTEGER,          -- add, replace: the staged bytes
  content_type TEXT,
  review       TEXT,             -- why a person must merge it (it runs at build time or in browsers)
  staged_at    INTEGER NOT NULL,
  PRIMARY KEY (draft_id, path)
);

INSERT OR IGNORE INTO migrations (id) VALUES ('uploads');
