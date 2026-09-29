-- A member's claim of a People page waits for an admin (src/profile/routes.ts, /admin): a GitHub
-- sign-in proves the login, not whose page it is. A pending claim holds the page but changes
-- nothing anyone sees: the navbar and Hafezi GPT keep the member's GitHub name, and nothing goes
-- into the vault until an admin approves it. Every link made before this stays approved.
ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
  CHECK (status IN ('pending', 'approved'));
ALTER TABLE profiles ADD COLUMN claimed_at INTEGER;

INSERT OR IGNORE INTO migrations (id) VALUES ('profile-claims');
