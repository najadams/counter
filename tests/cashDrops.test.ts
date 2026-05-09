// Cash drops: supervisor required, can't exceed expected, deduction
// flows through computeAndCloseShift correctly.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  computeAndCloseShift, openShift, submitClosingCount,
} from '../src/main/services/shifts';
import {
  getCurrentExpectedCash, listCashDropsForShift, recordCashDrop,
} from '../src/main/services/cashDrops';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
});
afterEach(() => { db.close(); });

function addCashSale(amountPesewas: number) {
  db.prepare(
    `INSERT INTO sales (id, shift_id, worker_id, location_id, channel,
      subtotal_pesewas, total_pesewas, payment_method,
      created_by, updated_by, device_id)
      VALUES (?, ?, ?, ?, 'WALK_IN', ?, ?, 'CASH', ?, ?, ?)`,
  ).run(`sa-${uuidv4()}`, shiftId, W, L, amountPesewas, amountPesewas, W, W, D);
}

describe('recordCashDrop', () => {
  it('inserts a CASH_DROP cash_count row', () => {
    addCashSale(3000);
    const r = recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 2000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    const row = db.prepare('SELECT count_type, counted_pesewas, supervisor_id FROM cash_counts WHERE id = ?').get(r.cashCountId) as { count_type: string; counted_pesewas: number; supervisor_id: string };
    expect(row.count_type).toBe('CASH_DROP');
    expect(row.counted_pesewas).toBe(2000);
    expect(row.supervisor_id).toBe(SUP);
  });

  it('refuses without supervisor', () => {
    expect(() => recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '0000', deviceId: D,
    })).toThrow(/PIN check failed|locked/);
  });

  it('refuses non-supervisor approval', () => {
    expect(() => recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: 'Owner',
      supervisorWorkerId: W, supervisorPin: '1234', deviceId: D,
    })).toThrow(/COUNTER cannot approve/);
  });

  it('refuses if amount exceeds current expected cash', () => {
    // Opening 5000 + sales 0 - drops 0 = expected 5000. Try to drop 6000.
    expect(() => recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 6000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    })).toThrow(/exceeds current expected/);
  });

  it('rejects empty recipient', () => {
    expect(() => recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: '   ',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    })).toThrow(/recipient is required/);
  });

  it('rejects non-positive amount', () => {
    expect(() => recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 0, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    })).toThrow(/positive integer/);
  });

  it('audits CASH_DROP_RECORDED', () => {
    const r = recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(r.cashCountId) as { action: string };
    expect(a.action).toBe('CASH_DROP_RECORDED');
  });

  it('expectedCashAfterDropPesewas reports the new balance', () => {
    addCashSale(2000); // expected = 5000 + 2000 = 7000
    const r = recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 3000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    expect(r.expectedCashAfterDropPesewas).toBe(4000);
  });
});

describe('getCurrentExpectedCash', () => {
  it('opening + cash sales - drops', () => {
    expect(getCurrentExpectedCash(db, shiftId)).toBe(5000);
    addCashSale(3000);
    expect(getCurrentExpectedCash(db, shiftId)).toBe(8000);
    recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    expect(getCurrentExpectedCash(db, shiftId)).toBe(7000);
  });
});

describe('shift close incorporates drops', () => {
  it('expected = opening + cash sales - drops at close', () => {
    addCashSale(3000); // expected without drops = 8000
    recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 2000, recipient: 'Owner',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    // Counted 6000 to match expected of 6000 (5000 + 3000 - 2000).
    submitClosingCount(db, shiftId, 6000, W, D);
    const r = computeAndCloseShift(db, shiftId, W, D);
    expect(r.expectedPesewas).toBe(6000);
    expect(r.variancePesewas).toBe(0);
  });
});

describe('listCashDropsForShift', () => {
  it('returns rows for the shift only', () => {
    addCashSale(2000);
    recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1500, recipient: 'Bank deposit',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    const rows = listCashDropsForShift(db, shiftId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.amountPesewas).toBe(1500);
    expect(rows[0]?.workerName).toBe('Dev Counter');
    expect(rows[0]?.supervisorName).toBe('Dev Supervisor');
  });
});
