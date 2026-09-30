-- Edit conflicts (src/edit/conflicts.ts): two members' edits of one page that change the same
-- lines. The second is held (its draft's status is 'conflict') until the first editor or an admin
-- settles it; an open row here says why and who may settle it. Additive only.

-- A draft made on top of another member's sent draft goes in after it.
ALTER TABLE upload_drafts ADD COLUMN after_draft TEXT;
-- Counts a draft's saves, so a stale tab or a second device can't overwrite a newer save.
ALTER TABLE upload_drafts ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
-- What a revert from a page's History restores or undoes ({rev, mode}); null otherwise.
ALTER TABLE upload_drafts ADD COLUMN revert_json TEXT;

CREATE TABLE IF NOT EXISTS edit_conflicts (
  id             TEXT PRIMARY KEY,
  repo           TEXT NOT NULL CHECK (repo IN ('vault', 'vault-private')),
  path           TEXT NOT NULL,
  draft_id       TEXT NOT NULL REFERENCES upload_drafts (id) ON DELETE CASCADE, -- the second draft
  login          TEXT NOT NULL COLLATE NOCASE,   -- the second editor
  first_draft_id TEXT,                           -- null when the conflict is with main
  first_login    TEXT COLLATE NOCASE,            -- who may settle besides admins; null: admins only
  first_author   TEXT,                           -- the name shown
  first_blob     TEXT,                           -- git blob sha of the text it conflicted with
  reason         TEXT NOT NULL CHECK (reason IN ('pending', 'main', 'base-gone', 'moved')),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN
                   ('open', 'resolved', 'rejected', 'withdrawn', 'expired')),
  resolution     TEXT CHECK (resolution IN ('first', 'second', 'merged')),
  resolved_by    TEXT COLLATE NOCASE,
  opened_at      INTEGER NOT NULL,
  resolved_at    INTEGER,
  expires_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS edit_conflicts_one_open ON edit_conflicts (draft_id)
  WHERE state = 'open';
CREATE INDEX IF NOT EXISTS edit_conflicts_first ON edit_conflicts (first_login, state);
CREATE INDEX IF NOT EXISTS edit_conflicts_state ON edit_conflicts (state, opened_at);

INSERT OR IGNORE INTO migrations (id) VALUES ('edit-conflicts');
