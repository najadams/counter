// PIN auth tests: rate-limiting, lockout expiry, success clears, SYSTEM rejected.
// Uses better-sqlite3 in-memory on the user's machine; vitest will skip
// gracefully if the prebuild can't load.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { verifyPin, listLoginCandidates, clearPinAttempts } from '../src/main/services/workers';
import { PIN_BCRYPT_ROUNDS, PIN_MAX_ATTEMPTS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});

afterEach(() => {
  db.close();
});

describe('listLoginCandidates', () => {
  it('returns active non-SYSTEM workers', () => {
    const cands = listLoginCandidates(db);
    expect(cands.map((c) => c.id).sort()).toEqual(['dev-counter-1', 'dev-supervisor-1']);
    expect(cands.every((c) => c.role !== 'SYSTEM')).toBe(true);
  });

  it('excludes terminated workers', () => {
    db.prepare(
      `UPDATE workers SET terminated_at = '2026-04-01', termination_reason = 'left'
         WHERE id = 'dev-counter-1'`,
    ).run();
    const cands = listLoginCandidates(db);
    expect(cands.find((c) => c.id === 'dev-counter-1')).toBeUndefined();
  });

  it('excludes inactive workers', () => {
    db.prepare(`UPDATE workers SET active = 0 WHERE id = 'dev-counter-1'`).run();
    const cands = listLoginCandidates(db);
    expect(cands.find((c) => c.id === 'dev-counter-1')).toBeUndefined();
  });
});

describe('verifyPin', () => {
  const DEVICE = 'test-device';

  it('accepts the correct PIN', () => {
    const r = verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workerId).toBe('dev-counter-1');
      expect(r.role).toBe('COUNTER');
    }
  });

  it('rejects the wrong PIN with attempts remaining', () => {
    const r = verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'INVALID_PIN') {
      expect(r.attemptsRemaining).toBe(PIN_MAX_ATTEMPTS - 1);
    } else {
      throw new Error(`expected INVALID_PIN, got ${(r as any).reason}`);
    }
  });

  it('locks after PIN_MAX_ATTEMPTS wrong PINs', () => {
    let last;
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      last = verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    }
    expect(last?.ok).toBe(false);
    if (!last?.ok && last?.reason === 'LOCKED_OUT') {
      expect(new Date(last.lockedUntil).getTime()).toBeGreaterThan(Date.now());
    } else {
      throw new Error(`expected LOCKED_OUT, got ${(last as any)?.reason}`);
    }
  });

  it('keeps the lock active for subsequent attempts even with the right PIN', () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    }
    const r = verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('LOCKED_OUT');
  });

  it('successful login clears the attempt counter', () => {
    verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    const row = db
      .prepare('SELECT attempt_count FROM pin_attempts WHERE worker_id = ? AND device_id = ?')
      .get('dev-counter-1', DEVICE) as { attempt_count: number };
    expect(row.attempt_count).toBe(0);
  });

  it('lockout is per (worker, device): another device is unaffected', () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      verifyPin(db, 'dev-counter-1', '0000', 'device-A');
    }
    const r = verifyPin(db, 'dev-counter-1', '1234', 'device-B');
    expect(r.ok).toBe(true);
  });

  it('expired lockout is cleared and a fresh PIN check proceeds', () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    }
    // Force the lock into the past.
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`UPDATE pin_attempts SET locked_until = ? WHERE worker_id = ? AND device_id = ?`)
      .run(past, 'dev-counter-1', DEVICE);

    const r = verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown worker', () => {
    const r = verifyPin(db, 'nonexistent', '1234', DEVICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNKNOWN_WORKER');
  });

  it('rejects SYSTEM role', () => {
    // Set a real bcrypt hash on SYSTEM so we know the rejection isn't from PIN mismatch.
    const hash = bcrypt.hashSync('1234', PIN_BCRYPT_ROUNDS);
    db.prepare(`UPDATE workers SET pin_hash = ? WHERE id = 'sys-system'`).run(hash);
    const r = verifyPin(db, 'sys-system', '1234', DEVICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SYSTEM_ROLE_REJECTED');
  });

  it('rejects inactive worker', () => {
    db.prepare(`UPDATE workers SET active = 0 WHERE id = 'dev-counter-1'`).run();
    const r = verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNKNOWN_WORKER');
  });

  it('rejects terminated worker', () => {
    db.prepare(
      `UPDATE workers SET terminated_at = '2026-04-01', termination_reason = 'quit' WHERE id = 'dev-counter-1'`,
    ).run();
    const r = verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNKNOWN_WORKER');
  });

  it('logs every attempt to audit_log', () => {
    verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    const rows = db
      .prepare(`SELECT action FROM audit_log WHERE entity_id = 'dev-counter-1' ORDER BY created_at`)
      .all() as Array<{ action: string }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('WORKER_LOGIN_FAILED');
    expect(actions).toContain('WORKER_LOGIN_SUCCESS');
  });

  it('clearPinAttempts unblocks a locked worker', () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      verifyPin(db, 'dev-counter-1', '0000', DEVICE);
    }
    clearPinAttempts(db, 'dev-counter-1', DEVICE);
    const r = verifyPin(db, 'dev-counter-1', '1234', DEVICE);
    expect(r.ok).toBe(true);
  });
});
