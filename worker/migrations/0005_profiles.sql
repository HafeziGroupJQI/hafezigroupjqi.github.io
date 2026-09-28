-- Members' links to their People page in the public vault, and what the navbar shows for them
-- (src/profile/routes.ts). The page itself is changed by a vault commit; these rows let the
-- navbar show a new name or photo before that commit is deployed.
CREATE TABLE IF NOT EXISTS profiles (
  login      TEXT PRIMARY KEY COLLATE NOCASE,
  path       TEXT NOT NULL UNIQUE,  -- content/people/<slug>.md in the vault
  name       TEXT,                  -- the page's title (the member's name)
  photo_url  TEXT,                  -- the page's photo on the site, e.g. /assets/people/<slug>.jpg
  photo_at   INTEGER,               -- when a photo was uploaded here (ms); served from R2 until deployed
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO migrations (id) VALUES ('profiles');
