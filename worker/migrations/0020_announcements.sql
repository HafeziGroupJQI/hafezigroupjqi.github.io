-- Site announcements (src/announcements.ts): posted by admins, shown to each member once in a
-- spotlight on the first page they open after it goes live, until they dismiss it, and kept on
-- /announcements. publish_at is when it goes live (ms); null is a draft only admins see.
CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  body_md    TEXT NOT NULL DEFAULT '',
  publish_at INTEGER,
  created_by TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL COLLATE NOCASE
);
CREATE INDEX IF NOT EXISTS announcements_publish_at ON announcements (publish_at);

-- Files attached to an announcement, kept in R2 (ARTIFACTS) under announcements/<id>/.
CREATE TABLE IF NOT EXISTS announcement_files (
  id              TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  type            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS announcement_files_announcement ON announcement_files (announcement_id);

-- Who dismissed which announcement: it never shows to them again, on any device.
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  login           TEXT NOT NULL COLLATE NOCASE,
  at              INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, login)
);

INSERT OR IGNORE INTO migrations (id) VALUES ('announcements');
