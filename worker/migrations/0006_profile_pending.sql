-- Members' saved but not yet published People page edits (src/profile/). Saving in /settings
-- queues an edit here; the hourly cron commits every edit that is due in one vault commit, so a
-- save rebuilds the site once, in the hour after next, and can be revised until then.
CREATE TABLE IF NOT EXISTS profile_pending (
  login       TEXT PRIMARY KEY COLLATE NOCASE,
  path        TEXT NOT NULL,             -- content/people/<slug>.md in the vault
  fields_json TEXT NOT NULL DEFAULT '{}', -- front matter keys to set: {"title": "Ada", "email": null}
  link        INTEGER NOT NULL DEFAULT 0, -- 1: also add `github: <login>` (a new link)
  photo_at    INTEGER,                   -- a new photo was saved (R2 profiles/<login>/pending.jpg)
  saved_at    INTEGER NOT NULL,
  due_at      INTEGER NOT NULL           -- published by the first hourly run at or after this
);

INSERT OR IGNORE INTO migrations (id) VALUES ('profile-pending');
