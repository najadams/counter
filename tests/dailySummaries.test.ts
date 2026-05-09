// Daily summary: revenue, COGS, margin, breakage, consumption, cash variance,
// stocktake-derived shrinkage rate, credit aging, top SKUs, reorder alerts,
// per-shift breakdown, idempotent on regenerate.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import {
  generateDailySummary, getDailySummary, listRecentDailySummaries,
} from '../src/main/services/dailySummaries';
import { reportBreakage } from '../src/main/services/breakage';
import { recordConsumption } from '../src/main/services/consumption';
import { completeStocktake, recordStocktakeCount, startStocktake } from '../src/main/services/stocktake';
import os from 'node:os';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let userDataDir: string;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // Stock 24 of each
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 24, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 24 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-test-'));
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => {
  _resetPrinter();
  db.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

function star() { return db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }; }

describe('generateDailySummary — sales math', () => {
  it('revenue + cogs + margin computed correctly', async () => {
    const p = star();
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'T',
    });
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.totalRevenuePesewas).toBe(2400);
    expect(r.totalCostOfGoodsSoldPesewas).toBe(1800); // 3 * 600
    expect(r.grossMarginPesewas).toBe(600);
    expect(r.numSales).toBe(1);
  });

  it('voided sales excluded', async () => {
    const p = star();
    const sale = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'T',
    });
    db.prepare(`UPDATE sales SET voided = 1, voided_at = ?, voided_by = ?, void_reason = 'test' WHERE id = ?`).run(new Date().toISOString(), W, sale.saleId);
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.totalRevenuePesewas).toBe(0);
    expect(r.numSales).toBe(0);
  });
});

describe('breakage + consumption values', () => {
  it('breakage value sums BREAKAGE movements (positive number)', async () => {
    const p = star();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: p.id,
      quantity: 2, cause: 'DROPPED', photoBytes: png, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.totalBreakageValuePesewas).toBe(1200);
  });

  it('consumption value sums WORKER_CONSUMED_* movements', () => {
    const p = star();
    recordConsumption(db, { shiftId, workerId: W, locationId: L, productId: p.id, quantity: 2, deviceId: D });
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.totalConsumptionValuePesewas).toBe(1200); // 2 * 600 cost
  });
});

describe('stocktake-derived shrinkage', () => {
  it('NULL when no stocktake completed today', () => {
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.stocktakeShrinkageRate).toBeNull();
    expect(r.stocktakeShrinkageValuePesewas).toBeNull();
  });

  it('populated when a stocktake completed on the same day', () => {
    const p = star();
    const ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    recordStocktakeCount(db, ev.eventId, p.id, 22, W, D); // -2 * 600 = -1200 loss
    completeStocktake(db, { eventId: ev.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.stocktakeShrinkageValuePesewas).toBe(1200);
    expect(r.stocktakeShrinkageRate).toBeGreaterThan(0);
  });

  it('uses the LATEST completed stocktake on that day', () => {
    const p = star();
    // First stocktake: small loss
    let ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    recordStocktakeCount(db, ev.eventId, p.id, 23, W, D);
    completeStocktake(db, { eventId: ev.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    // Second stocktake later same day: bigger loss
    ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    recordStocktakeCount(db, ev.eventId, p.id, 18, W, D); // varies by 5 from current 23 → -5*600 = 3000 loss
    completeStocktake(db, { eventId: ev.eventId, workerId: W, supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D });
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.stocktakeShrinkageValuePesewas).toBe(3000);
  });
});

describe('top SKUs + reorder alerts', () => {
  it('top 5 by revenue', async () => {
    const products = db.prepare("SELECT id, sku FROM products ORDER BY sku LIMIT 3").all() as Array<{ id: string; sku: string }>;
    for (const p of products) {
      await completeSale(db, {
        shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
        lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
        paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'T',
      });
    }
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.topSkus.length).toBeGreaterThanOrEqual(3);
    expect(r.topSkus[0]?.revenuePesewas).toBeGreaterThanOrEqual(r.topSkus[r.topSkus.length - 1]?.revenuePesewas ?? 0);
  });

  it('reorder alerts include products at or below threshold', () => {
    // Set STAR-330 reorder_threshold = 30 (we have 24 on hand)
    db.prepare(`UPDATE products SET reorder_threshold = 30 WHERE sku = 'STAR-330'`).run();
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    const star = r.reorderAlerts.find((a) => a.sku === 'STAR-330');
    expect(star).toBeDefined();
    expect(star?.unitsOnHand).toBe(24);
    expect(star?.reorderThreshold).toBe(30);
  });

  it('products ABOVE threshold are NOT in alerts', () => {
    db.prepare(`UPDATE products SET reorder_threshold = 10 WHERE sku = 'STAR-330'`).run();
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.reorderAlerts.find((a) => a.sku === 'STAR-330')).toBeUndefined();
  });
});

describe('credit + cash variance', () => {
  it('credit extended counts only credit sales', async () => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id)
         VALUES ('c1','Yaw','+233244999000','WALK_IN_REGULAR',100000,?,?,?)`,
    ).run(W, W, D);
    const p = star();
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: 'c1', deviceId: D, shopName: 'T',
    });
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'T',
    });
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.creditExtendedPesewas).toBe(800);
    expect(r.totalRevenuePesewas).toBe(1600);
  });

  it('credit collected = customer_payments that day', () => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id)
         VALUES ('c1','Yaw','+233244999000','WALK_IN_REGULAR',100000,?,?,?)`,
    ).run(W, W, D);
    db.prepare(
      `INSERT INTO customer_payments (id, customer_id, amount_pesewas, payment_method,
         received_at, received_by, created_by, updated_by, device_id)
         VALUES (?, 'c1', 500, 'CASH', ?, ?, ?, ?, ?)`,
    ).run(`cp-${uuidv4()}`, new Date().toISOString(), W, W, W, D);
    const r = generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    expect(r.creditCollectedPesewas).toBe(500);
  });
});

describe('idempotency', () => {
  it('regenerate updates the same row, does not duplicate', () => {
    const date = todayIso();
    generateDailySummary(db, { date, locationId: L, workerId: W, deviceId: D });
    generateDailySummary(db, { date, locationId: L, workerId: W, deviceId: D });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM daily_summaries WHERE summary_date = ? AND location_id = ?').get(date, L) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('getDailySummary returns the most recent values', async () => {
    const date = todayIso();
    generateDailySummary(db, { date, locationId: L, workerId: W, deviceId: D });
    // Add a sale, regenerate.
    const p = star();
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'T',
    });
    generateDailySummary(db, { date, locationId: L, workerId: W, deviceId: D });
    const got = getDailySummary(db, date, L);
    expect(got?.totalRevenuePesewas).toBe(800);
    expect(got?.numSales).toBe(1);
  });
});

describe('listRecentDailySummaries', () => {
  it('returns generated summaries', () => {
    generateDailySummary(db, { date: todayIso(), locationId: L, workerId: W, deviceId: D });
    const list = listRecentDailySummaries(db);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]?.date).toBe(todayIso());
  });
});
