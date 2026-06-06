// Session persistence: bearer tokens survive a host restart because they are
// backed by the auth_tokens table. "Restart" is modelled by clearing the
// in-memory map (initTokenStore re-runs) and reloading from the same DB.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  initTokenStore, mintToken, resolveToken, revokeToken, pruneExpiredTokens,
} from '../src/main/ipc/session';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

let db: ReturnType<typeof Database>;
// A real worker so the auth_tokens.worker_id FK holds (foreign_keys = ON).
const worker = { workerId: 'dev-counter-1', fullName: 'Dev Counter', role: 'CASHIER' };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  initTokenStore(db);
});
afterEach(() => db.close());

function rowCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM auth_tokens').get() as { c: number }).c;
}

describe('auth_tokens persistence', () => {
  it('writes a row on mint and resolves it', () => {
    const token = mintToken(worker, 'phone-1');
    expect(rowCount()).toBe(1);
    expect(resolveToken(token)).toEqual(worker);
  });

  it('survives a simulated host restart', () => {
    const token = mintToken(worker, 'phone-1');
    // Reboot: memory is cleared and reloaded from the same DB.
    initTokenStore(db);
    expect(resolveToken(token)).toEqual(worker);
  });

  it('revoke deletes the row, so it does not come back after a restart', () => {
    const token = mintToken(worker, 'phone-1');
    revokeToken(token);
    expect(rowCount()).toBe(0);
    initTokenStore(db);
    expect(resolveToken(token)).toBeNull();
  });

  it('reaps expired tokens on boot rather than rehydrating them', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fresh = mintToken(worker, 'phone-fresh');
      // Insert a stale token directly (13h old → past the 12h hard cap).
      const thirteenHours = 13 * 60 * 60 * 1000;
      db.prepare(
        `INSERT INTO auth_tokens (token, worker_id, full_name, role, device_id, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('stale', worker.workerId, worker.fullName, worker.role, 'phone-old',
            -thirteenHours, -thirteenHours);

      initTokenStore(db); // boot: prune + rehydrate
      expect(resolveToken('stale')).toBeNull();
      expect(resolveToken(fresh)).toEqual(worker);
      expect(db.prepare('SELECT COUNT(*) AS c FROM auth_tokens WHERE token = ?')
        .get('stale')).toEqual({ c: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles last_seen writes but keeps resolving (in-memory exact)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const token = mintToken(worker, 'phone-1');
      const persisted = () =>
        (db.prepare('SELECT last_seen AS t FROM auth_tokens WHERE token = ?').get(token) as { t: number }).t;
      expect(persisted()).toBe(0);

      vi.setSystemTime(30 * 1000);     // < 60s throttle window
      expect(resolveToken(token)).toEqual(worker);
      expect(persisted()).toBe(0);      // not yet written

      vi.setSystemTime(90 * 1000);     // past the throttle window
      expect(resolveToken(token)).toEqual(worker);
      expect(persisted()).toBe(90 * 1000); // now flushed
    } finally {
      vi.useRealTimers();
    }
  });

  it('pruneExpiredTokens clears expired rows from disk', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      mintToken(worker, 'phone-1');
      expect(rowCount()).toBe(1);
      vi.setSystemTime(13 * 60 * 60 * 1000); // past the 12h cap
      pruneExpiredTokens();
      expect(rowCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
