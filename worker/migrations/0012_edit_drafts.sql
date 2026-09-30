-- Page edits from the site's editor (src/edit/) are drafts of the uploads pipeline (src/uploads/):
-- a draft names its repository, now the public vault too, and its kind. An edit changes one page
-- (one upload_changes row, its base_sha the blob the member loaded) and carries a one-line summary.
-- A public page's edit is committed to the vault's main by the hourly run; a private one becomes a
-- pull request on vault-private, as uploads do.
ALTER TABLE upload_drafts ADD COLUMN repo TEXT NOT NULL DEFAULT 'vault-private'
  CHECK (repo IN ('vault', 'vault-private'));
ALTER TABLE upload_drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload'
  CHECK (kind IN ('upload', 'edit'));
ALTER TABLE upload_drafts ADD COLUMN summary TEXT;
-- The name its commit is authored under (the member's, as the site shows it), set when it is sent:
-- the hourly run that commits a public page's edit has no session to ask.
ALTER TABLE upload_drafts ADD COLUMN author TEXT;
-- Who else has a draft of a page open ("others are editing this page").
CREATE INDEX IF NOT EXISTS upload_changes_path ON upload_changes (path);
CREATE INDEX IF NOT EXISTS upload_drafts_repo_due ON upload_drafts (repo, status, due_at);

INSERT OR IGNORE INTO migrations (id) VALUES ('edit-drafts');
