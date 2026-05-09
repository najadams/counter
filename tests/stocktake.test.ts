// Stocktake: start snapshots expected qty per product; recordCount updates
// variance; complete emits one stock_movement per non-zero-variance line;
// supervisor required; refuses double-complete; cancel emits no movements.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  cancelStocktake, completeStocktake, getActiveStocktake,
  getStocktakeWithLines, listRecentStocktakes, recordStocktakeCount, startStocktake,
} from '../src/main/services/stocktake';
import { unitsOnHand } from '../src/main/services/stockMovements';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // Stock 24 of every product so expected qty is non-zero
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 24, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 24 * p.cost_price_pesewas, SUP, W, W, D);
  }
});
afterEach(() => { db.close(); });

function pickProduct(sku: string) {
  return db.prepare('SELECT id, cost_price_pesewas FROM products WHERE sku = ?').get(sku) as { id: string; cost_price_pesewas: number };
}

describe('startStocktake', () => {
  it('snapshots one line per active product with expected qty', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    expect(r.productCount).toBe(7);
    const lines = db.prepare('SELECT expected_qty, counted_qty, variance FROM stocktake_lines WHERE stocktake_event_id = ?').all(r.eventId) as Array<{ expected_qty: number; counted_qty: number | null; variance: number | null }>;
    expect(lines.length).toBe(7);
    expect(lines.every((l) => l.expected_qty === 24)).toBe(true);
    expect(lines.every((l) => l.counted_qty === null)).toBe(true);
    expect(lines.every((l) => l.variance === null)).toBe(true);
  });

  it('total_expected_stock_value_pesewas reflects on-hand × cost', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const event = db.prepare('SELECT total_expected_stock_value_pesewas FROM stocktake_events WHERE id = ?').get(r.eventId) as { total_expected_stock_value_pesewas: number };
    expect(event.total_expected_stock_value_pesewas).toBeGreaterThan(0);
    // Compute expected value across the 7 seed products
    const expected = (db.prepare(`SELECT COALESCE(SUM(p.cost_price_pesewas * 24), 0) AS v FROM products p WHERE p.active = 1`).get() as { v: number }).v;
    expect(event.total_expected_stock_value_pesewas).toBe(expected);
  });

  it('refuses if a DRAFT already exists', () => {
    startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    expect(() => startStocktake(db, { locationId: L, workerId: W, deviceId: D })).toThrow(/already exists/);
  });

  it('audits STOCKTAKE_STARTED', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(r.eventId) as { action: string };
    expect(a.action).toBe('STOCKTAKE_STARTED');
  });
});

describe('recordStocktakeCount', () => {
  it('updates counted, variance, variance_value', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    const res = recordStocktakeCount(db, r.eventId, star.id, 22, W, D);
    expect(res.variance).toBe(-2);
    expect(res.varianceValuePesewas).toBe(-2 * 600);
    const line = db.prepare('SELECT counted_qty, variance, variance_value_pesewas FROM stocktake_lines WHERE stocktake_event_id = ? AND product_id = ?').get(r.eventId, star.id) as { counted_qty: number; variance: number; variance_value_pesewas: number };
    expect(line.counted_qty).toBe(22);
    expect(line.variance).toBe(-2);
    expect(line.variance_value_pesewas).toBe(-1200);
  });

  it('counted_qty = expected gives zero variance', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    const res = recordStocktakeCount(db, r.eventId, star.id, 24, W, D);
    expect(res.variance).toBe(0);
  });

  it('counted_qty > expected gives positive variance (found)', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    const res = recordStocktakeCount(db, r.eventId, star.id, 26, W, D);
    expect(res.variance).toBe(2);
  });

  it('rejects negative count', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    expect(() => recordStocktakeCount(db, r.eventId, star.id, -1, W, D)).toThrow(/non-negative integer/);
  });

  it('refuses to record on a non-DRAFT event', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    cancelStocktake(db, r.eventId, W, D);
    const star = pickProduct('STAR-330');
    expect(() => recordStocktakeCount(db, r.eventId, star.id, 22, W, D)).toThrow(/CANCELLED/);
  });
});

describe('completeStocktake', () => {
  it('emits STOCKTAKE_VARIANCE_LOSS for negative variance', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 22, W, D);
    const res = completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    expect(res.movementsEmitted).toBe(1);
    expect(res.totalLossValuePesewas).toBe(1200);
    expect(unitsOnHand(db, star.id, L)).toBe(22); // adjusted to physical count
    const sm = db.prepare(`SELECT reason_code, quantity FROM stock_movements WHERE product_id = ? AND reason_code = 'STOCKTAKE_VARIANCE_LOSS'`).get(star.id) as { reason_code: string; quantity: number };
    expect(sm.quantity).toBe(-2);
  });

  it('emits STOCK_FOUND for positive variance', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 26, W, D);
    const res = completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    expect(res.totalFoundValuePesewas).toBe(1200);
    expect(unitsOnHand(db, star.id, L)).toBe(26);
    const sm = db.prepare(`SELECT quantity FROM stock_movements WHERE product_id = ? AND reason_code = 'STOCK_FOUND'`).get(star.id) as { quantity: number };
    expect(sm.quantity).toBe(2);
  });

  it('un-counted lines emit no movement', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 22, W, D);
    // Other products remain un-counted.
    const res = completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    expect(res.movementsEmitted).toBe(1);
    expect(res.productsCounted).toBe(1);
  });

  it('zero-variance counted lines emit no movement', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    for (const p of db.prepare('SELECT id FROM products').all() as Array<{ id: string }>) {
      recordStocktakeCount(db, r.eventId, p.id, 24, W, D); // perfect count
    }
    const res = completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    expect(res.movementsEmitted).toBe(0);
    expect(res.productsCounted).toBe(7);
    expect(res.productsWithVariance).toBe(0);
    expect(res.shrinkageRate).toBe(0);
  });

  it('shrinkage_rate = loss / total_expected_value', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 22, W, D); // -2 * 600 = -1200 loss
    const res = completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    const totalExpected = (db.prepare(`SELECT total_expected_stock_value_pesewas FROM stocktake_events WHERE id = ?`).get(r.eventId) as { total_expected_stock_value_pesewas: number }).total_expected_stock_value_pesewas;
    expect(res.shrinkageRate).toBeCloseTo(1200 / totalExpected, 6);
  });

  it('refuses without supervisor PIN', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    expect(() => completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '0000', deviceId: D })).toThrow(/PIN check failed|locked/);
  });

  it('refuses non-supervisor approval', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    expect(() => completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: W, supervisorPin: '1234', deviceId: D })).toThrow(/COUNTER cannot approve/);
  });

  it('refuses double-complete', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 22, W, D);
    completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    expect(() => completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D })).toThrow(/only DRAFT/);
  });

  it('updates stocktake_lines.stock_movement_id for variance lines', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 22, W, D);
    completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    const line = db.prepare('SELECT stock_movement_id FROM stocktake_lines WHERE stocktake_event_id = ? AND product_id = ?').get(r.eventId, star.id) as { stock_movement_id: string | null };
    expect(line.stock_movement_id).toBeTruthy();
  });

  it('audits STOCKTAKE_COMPLETED', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'STOCKTAKE_COMPLETED'`).get(r.eventId);
    expect(a).toBeDefined();
  });
});

describe('cancelStocktake', () => {
  it('marks event CANCELLED, no movements emitted', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const before = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;
    const star = pickProduct('STAR-330');
    recordStocktakeCount(db, r.eventId, star.id, 22, W, D);
    cancelStocktake(db, r.eventId, W, D);
    const ev = db.prepare('SELECT status, cancelled_at FROM stocktake_events WHERE id = ?').get(r.eventId) as { status: string; cancelled_at: string };
    expect(ev.status).toBe('CANCELLED');
    expect(ev.cancelled_at).toBeTruthy();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('refuses to cancel a COMPLETED event', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    expect(() => cancelStocktake(db, r.eventId, W, D)).toThrow(/only DRAFT/);
  });
});

describe('getActiveStocktake / listRecentStocktakes', () => {
  it('getActiveStocktake returns DRAFT or null', () => {
    expect(getActiveStocktake(db, L)).toBeNull();
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    expect(getActiveStocktake(db, L)?.id).toBe(r.eventId);
  });
  it('listRecentStocktakes returns events', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    completeStocktake(db, { eventId: r.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    const list = listRecentStocktakes(db);
    expect(list.find((e) => e.id === r.eventId)).toBeDefined();
  });
  it('getStocktakeWithLines returns event + lines', () => {
    const r = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const data = getStocktakeWithLines(db, r.eventId);
    expect(data.event.id).toBe(r.eventId);
    expect(data.lines.length).toBe(7);
  });
});
