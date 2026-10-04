-- Page ratings and popularity (worker/src/ratings/): members' up and down votes on the site's
-- pages, and which member opened which page on which day. A page is its site path without a
-- leading slash, ".html" or a trailing "index" (the home page is "index"), so a page's changes
-- (changes.slug, the same form) credit its contributors with its votes and readers, on
-- /leaderboard.
CREATE TABLE IF NOT EXISTS page_votes (
  path   TEXT NOT NULL,
  login  TEXT NOT NULL COLLATE NOCASE,
  value  INTEGER NOT NULL CHECK (value IN (-1, 1)),
  at     INTEGER NOT NULL,          -- ms: when the member last changed their vote
  PRIMARY KEY (path, login)
);
-- The leaderboard's periods: votes cast since a time.
CREATE INDEX IF NOT EXISTS page_votes_at ON page_votes (at);

-- One row per member, page and day (UTC, 'YYYY-MM-DD') they opened it: unique readers, never a count
-- of loads.
CREATE TABLE IF NOT EXISTS page_views (
  path   TEXT NOT NULL,
  login  TEXT NOT NULL COLLATE NOCASE,
  day    TEXT NOT NULL,
  PRIMARY KEY (path, login, day)
);
-- The leaderboard's periods: readers since a day.
CREATE INDEX IF NOT EXISTS page_views_day ON page_views (day, path);

INSERT OR IGNORE INTO migrations (id) VALUES ('ratings');
