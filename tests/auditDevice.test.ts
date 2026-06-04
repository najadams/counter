// Audit device attribution: logAudit records the request-scoped (remote)
// device id when one is active, else the caller-supplied host id. This is what
// makes a sale rung from a phone audit as that phone, not the counter PC.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { logAudit } from '../src/main/db/audit';
import { requestSession } from '../src/main/ipc/session';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => db.close());

function deviceOf(id: string): string {
  return (db.prepare('SELECT device_id FROM audit_log WHERE id = ?').get(id) as { device_id: string }).device_id;
}

const base = {
  workerId: 'dev-counter-1',
  action: 'BREAKAGE_REPORTED',
  entityType: 'breakage_events',
  entityId: 'be-1',
};

describe('logAudit device attribution', () => {
  it('uses the host deviceId when there is no request scope (IPC path)', () => {
    const id = logAudit(db, { ...base, deviceId: 'host-pc' });
    expect(deviceOf(id)).toBe('host-pc');
  });

  it('uses the remote device id when inside a request scope (HTTP path)', () => {
    const id = requestSession.run({ session: null, deviceId: 'phone-42' }, () =>
      logAudit(db, { ...base, deviceId: 'host-pc' }),
    );
    expect(deviceOf(id)).toBe('phone-42');
  });

  it('falls back to host when the scope carries no device id', () => {
    const id = requestSession.run({ session: null }, () =>
      logAudit(db, { ...base, deviceId: 'host-pc' }),
    );
    expect(deviceOf(id)).toBe('host-pc');
  });
});
