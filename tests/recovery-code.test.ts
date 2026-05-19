// Recovery code happy path + invalid + rate-limit-adjacent behaviors.
//
// Per CLAUDE.md §7, every OWNER has a one-time 16-char recovery code,
// regenerable from Settings, and consumed by the LoginScreen "Forgot PIN"
// flow. Disaster-recovery path with zero tests before this file.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  generateRecoveryCode, verifyRecoveryCode, resetOwnerPinWithCode,
  hasRecoveryCode, listOwnersForRecovery,
} from '../src/main/services/recovery';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const OWNER = 'dev-owner-1';
const D = 'test-device';

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // Add an OWNER for recovery tests — seed doesn't include one.
  db.prepare(
    `INSERT INTO workers (
      id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    OWNER, 'Dev Owner', '+233555000003',
    'OWNER', bcrypt.hashSync('1234', PIN_BCRYPT_ROUNDS),
    500000, 8, 1, '2026-01-01', OWNER, OWNER, D,
  );
});

afterEach(() => { db.close(); });

function lastAudit(action: string): { worker_id: string; after_value: string } | undefined {
  return db.prepare(
    `SELECT worker_id, after_value FROM audit_log
       WHERE action = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(action) as { worker_id: string; after_value: string } | undefined;
}

describe('generateRecoveryCode', () => {
  it('SETUP trigger writes hash + RECOVERY_CODE_GENERATED audit row', () => {
    const before = hasRecoveryCode(db, OWNER);
    expect(before).toBe(false);

    const { code } = generateRecoveryCode(db, OWNER, 'SETUP', D);

    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hasRecoveryCode(db, OWNER)).toBe(true);

    const audit = lastAudit('RECOVERY_CODE_GENERATED');
    expect(audit?.worker_id).toBe(OWNER);
    const meta = JSON.parse(audit?.after_value ?? '{}');
    expect(meta.trigger).toBe('SETUP');
  });

  it('REGENERATE invalidates the previous code', () => {
    const first = generateRecoveryCode(db, OWNER, 'SETUP', D).code;
    generateRecoveryCode(db, OWNER, 'REGENERATE', D);

    // First code no longer works.
    const r = verifyRecoveryCode(db, OWNER, first);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('WRONG_CODE');
  });

  it('refuses non-OWNER worker', () => {
    expect(() => generateRecoveryCode(db, 'dev-counter-1', 'SETUP', D))
      .toThrow(/OWNER\/FOUNDER/);
  });
});

describe('verifyRecoveryCode', () => {
  it('accepts the code case-insensitively and ignores hyphens', () => {
    const { code } = generateRecoveryCode(db, OWNER, 'SETUP', D);
    expect(verifyRecoveryCode(db, OWNER, code).ok).toBe(true);
    expect(verifyRecoveryCode(db, OWNER, code.toLowerCase()).ok).toBe(true);
    expect(verifyRecoveryCode(db, OWNER, code.replace(/-/g, '')).ok).toBe(true);
    expect(verifyRecoveryCode(db, OWNER, ` ${code} `).ok).toBe(true);
  });

  it('returns NO_CODE_SET when no code on file', () => {
    const r = verifyRecoveryCode(db, OWNER, 'AAAA-BBBB-CCCC-DDDD');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_CODE_SET');
  });

  it('returns WRONG_CODE for a typo', () => {
    generateRecoveryCode(db, OWNER, 'SETUP', D);
    const r = verifyRecoveryCode(db, OWNER, 'WRON-GWRO-NGWR-ONGW');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('WRONG_CODE');
  });

  it('returns NOT_OWNER when targeting a non-OWNER worker', () => {
    const r = verifyRecoveryCode(db, 'dev-counter-1', 'AAAA-BBBB-CCCC-DDDD');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_OWNER');
  });
});

describe('resetOwnerPinWithCode', () => {
  it('consumes the old code, sets a new PIN, returns a fresh code, audits both events', () => {
    const { code: original } = generateRecoveryCode(db, OWNER, 'SETUP', D);

    const { newRecoveryCode } = resetOwnerPinWithCode(db, OWNER, original, '5678', D);

    // 1. Old code no longer works
    expect(verifyRecoveryCode(db, OWNER, original).ok).toBe(false);
    // 2. New code works
    expect(verifyRecoveryCode(db, OWNER, newRecoveryCode).ok).toBe(true);
    // 3. New PIN is set (verify by hash compare on the workers row)
    const row = db.prepare('SELECT pin_hash FROM workers WHERE id = ?').get(OWNER) as { pin_hash: string };
    expect(bcrypt.compareSync('5678', row.pin_hash)).toBe(true);
    expect(bcrypt.compareSync('1234', row.pin_hash)).toBe(false);
    // 4. Audit trail: CONSUMED followed by GENERATED(POST_RESET)
    const consumed = lastAudit('RECOVERY_CODE_CONSUMED');
    expect(consumed?.worker_id).toBe(OWNER);
    const generated = lastAudit('RECOVERY_CODE_GENERATED');
    expect(generated?.worker_id).toBe(OWNER);
    const meta = JSON.parse(generated?.after_value ?? '{}');
    expect(meta.trigger).toBe('POST_RESET');
  });

  it('reusing a consumed code fails', () => {
    const { code } = generateRecoveryCode(db, OWNER, 'SETUP', D);
    resetOwnerPinWithCode(db, OWNER, code, '5678', D);
    expect(() => resetOwnerPinWithCode(db, OWNER, code, '9999', D)).toThrow(/wrong/i);
  });

  it('rejects when no code is on file', () => {
    expect(() => resetOwnerPinWithCode(db, OWNER, 'AAAA-BBBB-CCCC-DDDD', '5678', D))
      .toThrow(/No recovery code/i);
  });

  it('rejects an invalid new PIN', () => {
    const { code } = generateRecoveryCode(db, OWNER, 'SETUP', D);
    expect(() => resetOwnerPinWithCode(db, OWNER, code, '123', D)).toThrow(/4–6 digits/);
    expect(() => resetOwnerPinWithCode(db, OWNER, code, '12abcd', D)).toThrow(/4–6 digits/);
    // The original code should NOT be consumed when validation fails before the verify step.
    expect(verifyRecoveryCode(db, OWNER, code).ok).toBe(true);
  });

  it('clears pin_attempts lockouts as part of the reset', () => {
    const { code } = generateRecoveryCode(db, OWNER, 'SETUP', D);
    // Seed a fake lockout row.
    db.prepare(
      `INSERT INTO pin_attempts (worker_id, attempt_count, locked_until, updated_at, device_id)
       VALUES (?, 5, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).run(OWNER, new Date().toISOString(), D);

    resetOwnerPinWithCode(db, OWNER, code, '5678', D);

    const row = db.prepare(
      'SELECT attempt_count, locked_until FROM pin_attempts WHERE worker_id = ?',
    ).get(OWNER) as { attempt_count: number; locked_until: string | null };
    expect(row.attempt_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });
});

describe('listOwnersForRecovery', () => {
  it('shows hasCode flag per OWNER + excludes non-OWNERS', () => {
    generateRecoveryCode(db, OWNER, 'SETUP', D);
    const list = listOwnersForRecovery(db);
    expect(list.some((o) => o.id === OWNER && o.hasCode === true)).toBe(true);
    expect(list.some((o) => o.id === 'dev-counter-1')).toBe(false);
    expect(list.some((o) => o.id === 'dev-supervisor-1')).toBe(false);
  });
});
