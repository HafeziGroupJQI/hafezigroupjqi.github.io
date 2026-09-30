-- Hafezi GPT usage by day, model and source, beside gpt_usage, the monthly rollup that budgets
-- read: so an admin sees what each model costs, and the lab's ghost text apart from the rest.
-- source: 'chat' (the site's chat and the lab's Hafezi GPT panel), 'agent' (the lab's coding
-- agent, its chats' titles included) or 'completion' (the lab's ghost text). model is the model id
-- as priced ('offline' for the site chat's answers without a model). Counted from this migration
-- on: earlier usage is only in gpt_usage.
CREATE TABLE IF NOT EXISTS gpt_usage_daily (
  login       TEXT NOT NULL,
  day         TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  model       TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('chat', 'agent', 'completion')),
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  requests    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (login, day, model, source)
);
CREATE INDEX IF NOT EXISTS gpt_usage_daily_day ON gpt_usage_daily (day);

INSERT OR IGNORE INTO migrations (id) VALUES ('gpt-usage-daily');
