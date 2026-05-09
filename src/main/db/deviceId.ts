// Device ID: a UUID identifying the physical device the row was created on.
// Stored once in counter.db as a config row, then cached in memory.
//
// Why in the DB instead of userData/device-id.txt: keeps the device identity
// bound to the data — moving the DB file to a new machine carries its
// identity with it. A "fresh" device gets a new ID at first run.

import { v4 as uuidv4 } from 'uuid';
import type { Database as DB } from 'better-sqlite3';

const CONFIG_DDL = `
CREATE TABLE IF NOT EXISTS device_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

let cached: string | null = null;

export function getDeviceId(db: DB): string {
  if (cached) return cached;

  db.exec(CONFIG_DDL);

  const row = db
    .prepare('SELECT value FROM device_config WHERE key = ?')
    .get('device_id') as { value: string } | undefined;

  if (row) {
    cached = row.value;
    return row.value;
  }

  const id = `dev-${uuidv4()}`;
  db.prepare('INSERT INTO device_config (key, value) VALUES (?, ?)').run(
    'device_id',
    id,
  );
  cached = id;
  return id;
}

/** Test-only: clear the in-memory cache so a fresh DB gets a fresh ID. */
export function _resetDeviceIdCache(): void {
  cached = null;
}
