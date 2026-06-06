// Tiny helpers over the sync_state key/value table, shared by push and pull
// (push watermark, pull cursor, last-sync timestamps).

import type { Database as DB } from 'better-sqlite3';

export function getState(db: DB, key: string): string | undefined {
  return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setState(db: DB, key: string, value: string, at: string = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, at);
}
