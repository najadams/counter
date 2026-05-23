// Consumption: within_allowance auto-set, monthly boundary, supervisor
// required when over, two-row split when crossing the threshold mid-purchase.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { getMonthlyUsage, recordConsumption } from '../src/main/services/consumption';

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
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 24, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 24 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
});
afterEach(() => { db.close(); });

function star() { return db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }; }

describe('getMonthlyUsage', () => {
  it('reports 0 used when nothing logged', () => {
    const u = getMonthlyUsage(db, W);
    expect(u.unitsUsed).toBe(0);
    expect(u.unitsAllowed).toBe(8);
    expect(u.unitsRemaining).toBe(8);
  });
  it('respects per-worker allowance', () => {
    db.prepare('UPDATE workers SET consumption_allowance_units = ? WHERE id = ?').run(12, W);
    expect(getMonthlyUsage(db, W).unitsAllowed).toBe(12);
  });
});

describe('recordConsumption — within allowance', () => {
  it('logs free consumption, no supervisor needed', () => {
    const r = recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 2, deviceId: D });
    expect(r.unitsFree).toBe(2);
    expect(r.unitsPaid).toBe(0);
    expect(r.costToWorkerPesewas).toBe(0);
    expect(r.rowsInserted).toBe(1);
    expect(getMonthlyUsage(db, W).unitsUsed).toBe(2);
  });

  it('uses WORKER_CONSUMED_FREE reason for free units', () => {
    const r = recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 1, deviceId: D });
    void r;
    const sm = db.prepare(`SELECT reason_code FROM stock_movements WHERE worker_id = ? AND reason_code LIKE 'WORKER_CONSUMED%'`).get(W) as { reason_code: string };
    expect(sm.reason_code).toBe('WORKER_CONSUMED_FREE');
  });

  it('within_allowance flag is 1 in the consumption_log row', () => {
    recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 1, deviceId: D });
    const row = db.prepare('SELECT within_allowance, cost_to_worker_pesewas FROM worker_consumption_log WHERE worker_id = ? LIMIT 1').get(W) as { within_allowance: number; cost_to_worker_pesewas: number };
    expect(row.within_allowance).toBe(1);
    expect(row.cost_to_worker_pesewas).toBe(0);
  });
});

describe('recordConsumption — over allowance', () => {
  it('demands supervisor approval when over', () => {
    db.prepare('UPDATE workers SET consumption_allowance_units = 1 WHERE id = ?').run(W);
    expect(() => recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 2, deviceId: D })).toThrow(/supervisor approval required/);
  });

  it('with supervisor approval, splits into FREE + PAID rows', () => {
    db.prepare('UPDATE workers SET consumption_allowance_units = 1 WHERE id = ?').run(W);
    const r = recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 3, supervisorApprovalId: SUP, deviceId: D });
    expect(r.unitsFree).toBe(1);
    expect(r.unitsPaid).toBe(2);
    expect(r.rowsInserted).toBe(2);
    expect(r.costToWorkerPesewas).toBe(2 * 800); // walk-in price * paid units

    // FREE row is inserted before PAID inside the same transaction;
    // created_at can collide at the ms boundary so use rowid as
    // tiebreaker to keep the assertion order-stable.
    const reasons = db.prepare(`SELECT reason_code FROM stock_movements WHERE worker_id = ? AND reason_code LIKE 'WORKER_CONSUMED%' ORDER BY created_at, rowid`).all(W).map((r: any) => r.reason_code);
    expect(reasons).toEqual(['WORKER_CONSUMED_FREE', 'WORKER_CONSUMED_PAID']);
  });

  it('all-paid when allowance is already exhausted', () => {
    db.prepare('UPDATE workers SET consumption_allowance_units = 0 WHERE id = ?').run(W);
    const r = recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 2, supervisorApprovalId: SUP, deviceId: D });
    expect(r.unitsFree).toBe(0);
    expect(r.unitsPaid).toBe(2);
    expect(r.rowsInserted).toBe(1);
  });

  it('paid stock_movement records supervisor_approval_id', () => {
    db.prepare('UPDATE workers SET consumption_allowance_units = 0 WHERE id = ?').run(W);
    recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: star().id, quantity: 1, supervisorApprovalId: SUP, deviceId: D });
    const sm = db.prepare(`SELECT supervisor_approval_id FROM stock_movements WHERE reason_code = 'WORKER_CONSUMED_PAID'`).get() as { supervisor_approval_id: string };
    expect(sm.supervisor_approval_id).toBe(SUP);
  });
});

describe('monthly boundary', () => {
  it('previous-month consumption does not count toward this month usage', () => {
    // Insert a row with a created_at 2 months ago, bypassing the service.
    const now = new Date();
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 15).toISOString();
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        shift_id, worker_id, unit_cost_pesewas, total_value_pesewas,
        created_at, updated_at, created_by, updated_by, device_id)
        VALUES ('sm-old', ?, ?, -1, 'WORKER_CONSUMED_FREE', ?, ?, 600, -600, ?, ?, ?, ?, ?)`,
    ).run(star().id, L, shiftId, W, twoMonthsAgo, twoMonthsAgo, W, W, D);
    db.prepare(
      `INSERT INTO worker_consumption_log (id, shift_id, location_id, worker_id, product_id, quantity,
        within_allowance, cost_to_worker_pesewas, stock_movement_id, created_at, updated_at,
        created_by, updated_by, device_id)
        VALUES ('wc-old', ?, ?, ?, ?, 1, 1, 0, 'sm-old', ?, ?, ?, ?, ?)`,
    ).run(shiftId, L, W, star().id, twoMonthsAgo, twoMonthsAgo, W, W, D);
    const u = getMonthlyUsage(db, W);
    expect(u.unitsUsed).toBe(0);
  });
});
