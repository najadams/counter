// Owner close-out of an abandoned shift.
//
// sealDay() refuses while a shift is open, and it should: an open shift means
// nobody has counted the drawer. The cashier who opened it may be long gone,
// so an OWNER can do the count instead — but the money path has to stay the
// cashier's path, or the control is gone rather than delegated.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  listOpenShiftsOnOrBefore, openShift, ownerCloseShift,
} from '../src/main/services/shifts';
import { sealDay } from '../src/main/services/periods';
import bcrypt from 'bcryptjs';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const CASHIER = 'dev-counter-1';
const OWNER = 'dev-owner-1';
const LOC = 'loc-main-counter';
const DEVICE = 'test-device';
const today = new Date().toISOString().slice(0, 10);

let db: ReturnType<typeof Database>;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // The dev fixtures ship a cashier but no owner; sealing and force-closing
  // both require one.
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
       base_salary_pesewas, consumption_allowance_units, active,
       hired_at, created_by, updated_by, device_id)
     VALUES (?, ?, ?, 'OWNER', ?, 0, 0, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(OWNER, 'Aba Owner', '+233555000300', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS));
});
afterEach(() => db.close());

function openCashierShift(openingCashPesewas = 5000): string {
  return openShift(db, {
    workerId: CASHIER, locationId: LOC, shiftType: 'COUNTER',
    openingCashPesewas, deviceId: DEVICE,
  }).shiftId;
}

describe('listOpenShiftsOnOrBefore', () => {
  it('reports the shift that is blocking the seal, with what the books expect', () => {
    openCashierShift(5000);
    const open = listOpenShiftsOnOrBefore(db, LOC, today);
    expect(open).toHaveLength(1);
    expect(open[0]!.workerId).toBe(CASHIER);
    expect(open[0]!.openingCashPesewas).toBe(5000);
    // No sales yet, so the drawer should still hold exactly the float.
    expect(open[0]!.expectedPesewas).toBe(5000);
  });

  it('is empty once the shift is closed', () => {
    const shiftId = openCashierShift();
    ownerCloseShift(db, {
      shiftId, countedPesewas: 5000, reason: 'cashier went home',
      actorWorkerId: OWNER, deviceId: DEVICE,
    });
    expect(listOpenShiftsOnOrBefore(db, LOC, today)).toEqual([]);
  });
});

describe('ownerCloseShift', () => {
  it('unblocks the seal', () => {
    const shiftId = openCashierShift();
    expect(() => sealDay(db, {
      locationId: LOC, businessDate: today, actorWorkerId: OWNER, deviceId: DEVICE,
    })).toThrow(/open shift/i);

    ownerCloseShift(db, {
      shiftId, countedPesewas: 5000, reason: 'cashier went home',
      actorWorkerId: OWNER, deviceId: DEVICE,
    });

    expect(() => sealDay(db, {
      locationId: LOC, businessDate: today, actorWorkerId: OWNER, deviceId: DEVICE,
    })).not.toThrow();
  });

  it('computes variance from the counted cash, exactly as a normal close does', () => {
    const shiftId = openCashierShift(5000);
    const result = ownerCloseShift(db, {
      shiftId, countedPesewas: 4200, reason: 'drawer short, counted by owner',
      actorWorkerId: OWNER, deviceId: DEVICE,
    });
    expect(result.expectedPesewas).toBe(5000);
    expect(result.countedPesewas).toBe(4200);
    expect(result.variancePesewas).toBe(-800);
  });

  it('records that the owner counted it, not the cashier', () => {
    const shiftId = openCashierShift();
    ownerCloseShift(db, {
      shiftId, countedPesewas: 5000, reason: 'cashier went home',
      actorWorkerId: OWNER, deviceId: DEVICE,
    });

    const count = db.prepare(
      `SELECT worker_id AS workerId, supervisor_id AS supervisorId, notes
         FROM cash_counts WHERE shift_id = ? AND count_type = 'SHIFT_CLOSE'`,
    ).get(shiftId) as { workerId: string; supervisorId: string | null; notes: string | null };
    expect(count.supervisorId).toBe(OWNER);
    expect(count.notes).toContain('cashier went home');

    const audit = db.prepare(
      `SELECT after_value AS afterValue FROM audit_log
        WHERE action = 'SHIFT_FORCE_CLOSED' AND entity_id = ?`,
    ).get(shiftId) as { afterValue: string } | undefined;
    expect(audit).toBeDefined();
    const detail = JSON.parse(audit!.afterValue);
    expect(detail.openedByWorkerId).toBe(CASHIER);
    expect(detail.reason).toBe('cashier went home');
  });

  it('refuses a cashier trying to close their own shift this way', () => {
    const shiftId = openCashierShift();
    expect(() => ownerCloseShift(db, {
      shiftId, countedPesewas: 5000, reason: 'closing up',
      actorWorkerId: CASHIER, deviceId: DEVICE,
    })).toThrow(/OWNER or FOUNDER/);
  });

  it('refuses without a reason, so the audit trail is never empty', () => {
    const shiftId = openCashierShift();
    expect(() => ownerCloseShift(db, {
      shiftId, countedPesewas: 5000, reason: '  ',
      actorWorkerId: OWNER, deviceId: DEVICE,
    })).toThrow(/reason is required/);
  });

  it('refuses to close a shift twice', () => {
    const shiftId = openCashierShift();
    const args = {
      shiftId, countedPesewas: 5000, reason: 'cashier went home',
      actorWorkerId: OWNER, deviceId: DEVICE,
    };
    ownerCloseShift(db, args);
    expect(() => ownerCloseShift(db, args)).toThrow(/already closed/);
  });
});
