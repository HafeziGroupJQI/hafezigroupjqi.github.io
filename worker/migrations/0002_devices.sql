-- Multi-device instrument system: device registry, per-device instruments and readings,
-- experiments, commands, and the instrument catalog. See the plan and worker/README.md.
--
-- Time columns are integer nanoseconds (ts_ns, matching the bus record schema) except audit
-- *_at columns, which are integer milliseconds since the epoch. The live reading/log firehose
-- is coalesced by the DeviceHub Durable Object before it reaches these tables; reading_latest is
-- the only thing the browser reads at rest, reading_history is a small rolling buffer, and full
-- CSV / plot artifacts live in the ARTIFACTS R2 bucket, never in D1.

CREATE TABLE IF NOT EXISTS devices (
  code_name     TEXT PRIMARY KEY,
  key_hash      TEXT UNIQUE,            -- SHA-256 hex of the device key; null until enrolled
  hostname      TEXT,
  platform      TEXT,
  agent_version TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  enrolled_at   INTEGER,
  last_seen_ns  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id         TEXT PRIMARY KEY,
  code_name  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_enroll_token ON enrollment_tokens (token_hash);

CREATE TABLE IF NOT EXISTS instruments (
  device_code  TEXT NOT NULL,
  local_id     TEXT NOT NULL,
  title        TEXT,
  model        TEXT,
  driver       TEXT,
  address_kind TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',   -- JSON array of capability names
  metrics      TEXT NOT NULL DEFAULT '[]',   -- JSON array of metric names
  ports        TEXT NOT NULL DEFAULT '[]',   -- JSON array of {id,label,direction}
  declared_ns  INTEGER NOT NULL,
  PRIMARY KEY (device_code, local_id)
);

-- Separate from instruments so a frequent heartbeat never rewrites the stable declaration row.
CREATE TABLE IF NOT EXISTS instrument_status (
  device_code TEXT NOT NULL,
  local_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unpolled',  -- online | offline | unpolled
  updated_ns  INTEGER,
  PRIMARY KEY (device_code, local_id)
);

CREATE TABLE IF NOT EXISTS reading_latest (
  device_code TEXT NOT NULL,
  local_id    TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL,
  value_text  TEXT,               -- for the "NaN"/"Inf"/"-Inf" string encoding
  ts_ns       INTEGER NOT NULL,
  seq         INTEGER,
  PRIMARY KEY (device_code, local_id, metric)
);

CREATE TABLE IF NOT EXISTS reading_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_code TEXT NOT NULL,
  local_id    TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL,
  value_text  TEXT,
  ts_ns       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_history_window ON reading_history (device_code, ts_ns);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_code TEXT NOT NULL,
  local_id    TEXT,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  ts_ns       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_logs_cursor ON logs (device_code, id);

CREATE TABLE IF NOT EXISTS experiments (
  id          TEXT PRIMARY KEY,       -- Experiment_<ts>_<label>
  device_code TEXT NOT NULL,
  label       TEXT,
  spec        TEXT NOT NULL DEFAULT '{}',   -- the Setup.json spec
  script      TEXT,                          -- the generated Runexp.py
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | generating | running | stopped | failed
  created_by  TEXT,
  created_ns  INTEGER NOT NULL,
  started_ns  INTEGER,
  stopped_ns  INTEGER,
  artifacts   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_experiments_device ON experiments (device_code, created_ns);

CREATE TABLE IF NOT EXISTS datasets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  device_code   TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}',   -- parsed CSV #-header fields
  created_ns    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_datasets_exp ON datasets (experiment_id);

CREATE TABLE IF NOT EXISTS commands (
  id           TEXT PRIMARY KEY,
  device_code  TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- poll | experiment.start | experiment.stop | reconfigure
  args         TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | done | failed
  result       TEXT,
  requested_by TEXT,
  created_ns   INTEGER NOT NULL,
  delivered_ns INTEGER,
  completed_ns INTEGER
);
CREATE INDEX IF NOT EXISTS ix_commands_queue ON commands (device_code, status);

-- The instrument catalog: descriptor metadata per family, shared by the site and the generator.
CREATE TABLE IF NOT EXISTS catalog (
  family       TEXT PRIMARY KEY,
  display_name TEXT,
  description  TEXT,
  ports        TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '{}',
  examples     TEXT NOT NULL DEFAULT '[]',
  updated_ns   INTEGER
);

CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  name        TEXT,
  spec        TEXT NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_ns  INTEGER
);

-- Seed the two families ported from the Scripts reference (ports + capabilities; examples added
-- with Part 4). Keithley 2450 SourceMeter over VISA, Zurich MFLI lock-in over zhinst-toolkit.
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'Keithley2450',
  'Keithley 2450 SourceMeter',
  'Precision source-measure unit for voltage/current sourcing and measurement.',
  '[{"id":"force_hi","label":"Force HI","direction":"source"},{"id":"force_lo","label":"Force LO","direction":"source"},{"id":"sense_hi","label":"Sense HI","direction":"measure"},{"id":"sense_lo","label":"Sense LO","direction":"measure"}]',
  '{"readable":true,"settable":true,"switchable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'ZurichMFLI',
  'Zurich Instruments MFLI',
  'Digital lock-in amplifier for signal generation, demodulation, gain, phase, and noise measurements.',
  '[{"id":"current_input","label":"Signal Input I","direction":"measure"},{"id":"voltage_input_pos","label":"Signal Input +V","direction":"measure"},{"id":"voltage_input_neg","label":"Signal Input -V Diff","direction":"measure"},{"id":"signal_output_pos","label":"Signal Output +V","direction":"source"},{"id":"signal_output_neg","label":"Signal Output -V Diff","direction":"source"},{"id":"aux_input_1","label":"Aux Input 1","direction":"measure"},{"id":"aux_input_2","label":"Aux Input 2","direction":"measure"},{"id":"aux_output_1","label":"Aux Output 1","direction":"source"},{"id":"aux_output_2","label":"Aux Output 2","direction":"source"},{"id":"aux_output_3","label":"Aux Output 3","direction":"source"},{"id":"aux_output_4","label":"Aux Output 4","direction":"source"},{"id":"trigger_input_1","label":"Trigger In 1","direction":"measure"},{"id":"trigger_input_2","label":"Trigger In 2","direction":"measure"},{"id":"trigger_output_1","label":"Trigger Out 1","direction":"source"},{"id":"trigger_output_2","label":"Trigger Out 2","direction":"source"},{"id":"clock_input_10mhz","label":"Clk 10 MHz In","direction":"measure"},{"id":"clock_output_10mhz","label":"Clk 10 MHz Out","direction":"source"},{"id":"dio","label":"DIO 32-bit","direction":"bidirectional"}]',
  '{"readable":true,"trace":true}',
  '[]',
  0
);

INSERT OR IGNORE INTO migrations (id) VALUES ('devices');
