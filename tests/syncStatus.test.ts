// getSyncStatus reads provisioning (device_config), last-sync (sync_state),
// and backlog (sync_outbox) into one operator-facing snapshot.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { getSyncStatus } from '../src/main/sync/status';
import { writeSyncConfig } from '../src/main/sync/config';
import { setState } from '../src/main/sync/state';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => db.close());

describe('getSyncStatus', () => {
  it('reports not configured on a fresh single-shop install', () => {
    const s = getSyncStatus(db);
    expect(s.configured).toBe(false);
    expect(s.role).toBeNull();
    expect(s.pendingCount).toBe(0);
  });

  it('reflects provisioning, backlog, and last-sync timestamps', () => {
    writeSyncConfig(db, { shopId: 'osu', centralUrl: 'http://c', token: 't', role: 'SHOP' });
    db.prepare(
      `INSERT INTO audit_log (id, worker_id, action, entity_type, entity_id, device_id)
       VALUES ('a1','dev-counter-1','TEST','sales','e1','host')`,
    ).run(); // event insert -> one outbox row
    setState(db, 'last_push_at', '2026-06-05T10:00:00Z');

    const s = getSyncStatus(db);
    expect(s).toMatchObject({
      configured: true, role: 'SHOP', shopId: 'osu', centralUrl: 'http://c',
      pendingCount: 1, lastPushAt: '2026-06-05T10:00:00Z', lastPullAt: null,
    });
  });

  it('reports the HQ role', () => {
    writeSyncConfig(db, { shopId: 'hq', centralUrl: 'http://c', token: 't', role: 'HQ' });
    expect(getSyncStatus(db).role).toBe('HQ');
  });

  it('writeSyncConfig keeps the existing token when a blank one is given', () => {
    writeSyncConfig(db, { shopId: 'osu', centralUrl: 'http://c', token: 't', role: 'SHOP' });
    writeSyncConfig(db, { shopId: 'osu2', centralUrl: 'http://c2', role: 'SHOP' }); // no token
    expect(getSyncStatus(db).configured).toBe(true); // token still present
    expect((db.prepare("SELECT value FROM device_config WHERE key='central_token'").get() as { value: string }).value).toBe('t');
  });
});
