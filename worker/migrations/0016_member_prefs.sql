-- Each member's own look for the members site (worker/src/prefs.ts): dark mode off, on, or as the
-- device is set, the theme for each, and whether figures are matched to a dark theme. A member
-- with no row has the defaults, which is the site as everyone else sees it. Theme ids are the
-- site's (tools/themes/); the Worker only checks their shape.
CREATE TABLE IF NOT EXISTS member_prefs (
  login       TEXT PRIMARY KEY COLLATE NOCASE,
  theme_mode  TEXT NOT NULL DEFAULT 'light' CHECK (theme_mode IN ('light', 'dark', 'system')),
  theme_light TEXT NOT NULL DEFAULT 'default',
  theme_dark  TEXT NOT NULL DEFAULT 'default-dark',
  figures     INTEGER NOT NULL DEFAULT 1 CHECK (figures IN (0, 1)),
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO migrations (id) VALUES ('member-prefs');
