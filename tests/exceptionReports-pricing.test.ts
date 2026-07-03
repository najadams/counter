// Exception reports added with the price-floor work: underpriced lines
// (below the list-price snapshot) and negative on-hand stock.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { negativeStock, underpricedLines } from '../src/main/services/exceptionReports';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let owner: string;
let starId: string;

function today() { return new Date().toISOString().slice(0, 10); }

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
        VALUES (?, ?, ?, 48, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 48 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  owner = 'dev-owner-1';
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, ?, ?, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(owner, 'Dev Owner', '+233555000003', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS), 500000, 8);
  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

describe('underpricedLines', () => {
  it('empty when every line was rung at or above list', async () => {
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 1600, deviceId: D, shopName: 'T',
    });
    expect(underpricedLines(db, owner, today(), today())).toEqual([]);
  });

  it('surfaces a line below its list-price snapshot with the shortfall', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'T',
    });
    // The floor makes ringing below list impossible through completeSale, so
    // simulate a bypass (old build / direct write) by raising the snapshot —
    // equivalent to the line having been rung 100 under list.
    db.prepare('UPDATE sale_lines SET list_price_pesewas = 900 WHERE sale_id = ?').run(r.saleId);
    const rows = underpricedLines(db, owner, today(), today());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.saleId).toBe(r.saleId);
    expect(rows[0]!.unitPricePesewas).toBe(800);
    expect(rows[0]!.listPricePesewas).toBe(900);
    expect(rows[0]!.shortfallPesewas).toBe(3 * 100);
  });

  it('excludes corrected sales (they legitimately re-ring old prices)', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'T',
    });
    db.prepare('UPDATE sale_lines SET list_price_pesewas = 900 WHERE sale_id = ?').run(r.saleId);
    db.prepare("UPDATE sales SET supersedes_sale_id = 'sa-some-original' WHERE id = ?").run(r.saleId);
    expect(underpricedLines(db, owner, today(), today())).toEqual([]);
  });

  it('requires OWNER/FOUNDER', () => {
    expect(() => underpricedLines(db, W, today(), today())).toThrow(/OWNER or FOUNDER/);
  });
});

describe('negativeStock', () => {
  it('empty when nothing is negative', () => {
    expect(negativeStock(db, owner)).toEqual([]);
  });

  it('surfaces products whose on-hand went negative, valued at cost', () => {
    // Outflow larger than the 48 on hand: 60 out → -12 on hand.
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, -60, 'SALE_WALK_IN', ?, 600, -36000, ?, ?, ?)`,
    ).run('sm-overdraw', starId, L, W, W, W, D);
    const rows = negativeStock(db, owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.productId).toBe(starId);
    expect(rows[0]!.unitsOnHand).toBe(-12);
    expect(rows[0]!.valueAtCostPesewas).toBe(12 * 600);
  });

  it('requires OWNER/FOUNDER', () => {
    expect(() => negativeStock(db, W)).toThrow(/OWNER or FOUNDER/);
  });
});
