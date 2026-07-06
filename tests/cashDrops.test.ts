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
  getCurrentExpectedCash, getDrawingReport, listCashDropsForShift,
  recordCashDrop, upsertDrawingPolicy,
} from '../src/main/services/cashDrops';
import { recordExpense } from '../src/main/services/expenses';

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
  // After 0019 introduced sale_payments, getCurrentExpectedCash sums from
  // there (the source of truth for tender breakdowns). Insert BOTH rows so
  // the helper still simulates a complete cash sale.
  const saleId = `sa-${uuidv4()}`;
  db.prepare(
    `INSERT INTO sales (id, shift_id, worker_id, location_id, channel,
      subtotal_pesewas, total_pesewas, payment_method,
      created_by, updated_by, device_id)
      VALUES (?, ?, ?, ?, 'WALK_IN', ?, ?, 'CASH', ?, ?, ?)`,
  ).run(saleId, shiftId, W, L, amountPesewas, amountPesewas, W, W, D);
  db.prepare(
    `INSERT INTO sale_payments (id, sale_id, payment_method, amount_pesewas,
      created_by, updated_by, device_id)
      VALUES (?, ?, 'CASH', ?, ?, ?, ?)`,
  ).run(`sp-${uuidv4()}`, saleId, amountPesewas, W, W, D);
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

  it('records owner/family drawings separately from generic drops', () => {
    const r = recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: 'Dad',
      category: 'OWNER_DRAWING',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    const drawing = db.prepare('SELECT category, beneficiary_name, amount_pesewas FROM owner_drawings WHERE cash_count_id = ?')
      .get(r.cashCountId) as { category: string; beneficiary_name: string; amount_pesewas: number };
    expect(drawing).toEqual({ category: 'OWNER_DRAWING', beneficiary_name: 'Dad', amount_pesewas: 1000 });
    expect(listCashDropsForShift(db, shiftId)[0]?.category).toBe('OWNER_DRAWING');
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(r.cashCountId) as { action: string };
    expect(a.action).toBe('OWNER_DRAWING_RECORDED');
  });

  it('enforces recurring drawing policy caps and reports by period', () => {
    const policy = upsertDrawingPolicy(db, {
      category: 'FAMILY_SUPPORT',
      beneficiaryName: 'Family',
      cadence: 'MONTHLY',
      limitPesewas: 1500,
      workerId: W,
      deviceId: D,
    });
    recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 1000, recipient: 'Family',
      category: 'FAMILY_SUPPORT', drawingPolicyId: policy.policyId,
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    });
    expect(() => recordCashDrop(db, {
      shiftId, workerId: W, amountPesewas: 600, recipient: 'Family',
      category: 'FAMILY_SUPPORT', drawingPolicyId: policy.policyId,
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    })).toThrow(/policy limit exceeded/);
    const today = new Date().toISOString().slice(0, 10);
    const rows = getDrawingReport(db, { period: 'MONTHLY', fromDate: today.slice(0, 8) + '01', toDate: today });
    expect(rows[0]?.category).toBe('FAMILY_SUPPORT');
    expect(rows[0]?.totalPesewas).toBe(1000);
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

  it('subtracts petty cash expenses the same way shift close does', () => {
    addCashSale(3000);
    recordExpense(db, {
      shiftId, locationId: L, workerId: W,
      amountPesewas: 1200, category: 'TRANSPORT',
      description: 'runner fare', deviceId: D,
    });
    expect(getCurrentExpectedCash(db, shiftId)).toBe(6800);
    submitClosingCount(db, shiftId, 6800, W, D);
    const closed = computeAndCloseShift(db, shiftId, W, D);
    expect(closed.expectedPesewas).toBe(6800);
    expect(closed.variancePesewas).toBe(0);
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
