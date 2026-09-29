-- Signing out ends every session a member began before it (src/session.ts): their site bearers,
-- and the lab tickets issued from them, are refused when the session began before not_before
-- (seconds). The ComputeRelay keeps its own copy, so the lab's requests need no D1 read.
CREATE TABLE IF NOT EXISTS logouts (
  login      TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL
);

INSERT OR IGNORE INTO migrations (id) VALUES ('logouts');
