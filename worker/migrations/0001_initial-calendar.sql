-- Same schema as the retired Python gateway's CalendarStore, plus its seed events.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  exceptions TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO events (id, data, version, updated_by) VALUES (
  'group-meeting-2026',
  '{"title":"Group Meeting","start":"2026-09-16T12:00:00","end":"2026-09-16T13:00:00","timezone":"America/New_York","location":"","description":"","repeat":"weekly","until":null}',
  1,
  'seed'
);
INSERT OR IGNORE INTO events (id, data, version, updated_by) VALUES (
  'laser-safety-2026',
  '{"title":"Laser Safety Training","start":"2026-09-17T09:00:00","end":"2026-09-17T10:00:00","timezone":"America/New_York","location":"","description":"","repeat":"none","until":null}',
  1,
  'seed'
);
INSERT OR IGNORE INTO migrations (id) VALUES ('initial-calendar');
