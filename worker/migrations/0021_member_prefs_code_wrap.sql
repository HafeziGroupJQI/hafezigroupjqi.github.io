-- Whether long lines in code blocks wrap for this member instead of scrolling sideways
-- (worker/src/prefs.ts `wrap`, /settings Appearance). On by default: a member who never chose
-- reads code without scrolling. The public site and signed-out visitors keep the site's own look.
ALTER TABLE member_prefs ADD COLUMN code_wrap INTEGER NOT NULL DEFAULT 1 CHECK (code_wrap IN (0, 1));

INSERT OR IGNORE INTO migrations (id) VALUES ('member-prefs-code-wrap');
