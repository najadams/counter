// Quick picks: the sale screen's top sellers (docs/design-system.md, "Quick
// picks"). Ranked by canonical units over the last 30 days at this shop,
// returned exactly as search returns rows so a tap adds the same cart line.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale, searchProducts, topSellingProducts } from '../src/main/services/sales';
import { addUnit } from '../src/main/services/productUnits';
import { _resetPrinter, _setPrinter } from '../src/main/printer/printer';

const W = 'dev-counter-1', OWNER = 'dev-supervisor-1', L = 'loc-main-counter', D = 'test-device';
let db: ReturnType<typeof Database>;
let shiftId: string;

function product(sku: string) {
  return db.prepare('SELECT id, walk_in_price_pesewas AS price FROM products WHERE sku = ?').get(sku) as { id: string; price: number };
}

async function sell(sku: string, quantity: number, unitId?: string, unitPricePesewas?: number) {
  const p = product(sku);
  const price = unitPricePesewas ?? p.price;
  return completeSale(db, {
    shiftId, workerId: W, workerName: 'Test', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: p.id, quantity, unitId, unitPricePesewas: price }],
    paymentMethod: 'CASH', cashGivenPesewas: price * quantity,
    deviceId: D, shopName: 'TEST',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, path.resolve('migrations'));
  runSeed(db, { includeDevFixtures: true });
  db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(OWNER);
  for (const p of db.prepare('SELECT id, cost_price_pesewas AS cost FROM products').all() as Array<{ id: string; cost: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code, worker_id,
         unit_cost_pesewas, total_value_pesewas, supervisor_approval_id, created_by, updated_by, device_id)
       VALUES (?, ?, ?, 48, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, OWNER, p.cost, 48 * p.cost, OWNER, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 0, deviceId: D }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => {
  _resetPrinter();
  db.close();
});

describe('topSellingProducts', () => {
  it('is empty for a shop with no sales yet, so the strip stays hidden', () => {
    expect(topSellingProducts(db, 'WALK_IN', L)).toEqual([]);
  });

  it('ranks by canonical units: one crate of 24 outsells five bottles', async () => {
    const star = product('STAR-330');
    const crate = addUnit(db, { productId: star.id, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isSaleUnit: true, isPurchaseUnit: true, actorWorkerId: OWNER, deviceId: D }).unitId;
    await sell('VOLTIC-1L', 5);
    await sell('STAR-330', 1, crate, 18000);
    expect(topSellingProducts(db, 'WALK_IN', L).map((p) => p.sku)).toEqual(['STAR-330', 'VOLTIC-1L']);
  });

  it('returns the same row search does, priced for the channel', async () => {
    await sell('STAR-330', 2);
    const [top] = topSellingProducts(db, 'WHOLESALE', L);
    const [searched] = searchProducts(db, 'STAR-330', 'WHOLESALE', L);
    expect(top).toEqual(searched);
    expect(top!.unitPricePesewas).toBe(750);
  });

  it('leaves out voided sales, sales older than 30 days, and inactive products', async () => {
    const voided = await sell('STAR-330', 6);
    await sell('VOLTIC-1L', 1);
    const old = await sell('CLUB-330', 9);
    db.prepare(`UPDATE sales SET voided = 1, voided_at = ?, voided_by = ?, void_reason = 'test'
                WHERE id = ?`).run(new Date().toISOString(), OWNER, voided.saleId);
    db.prepare("UPDATE sales SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(old.saleId);
    expect(topSellingProducts(db, 'WALK_IN', L, { now: new Date('2026-09-23T12:00:00Z') }).map((p) => p.sku))
      .toEqual(['VOLTIC-1L']);
    db.prepare("UPDATE products SET active = 0 WHERE sku = 'VOLTIC-1L'").run();
    expect(topSellingProducts(db, 'WALK_IN', L, { now: new Date('2026-09-23T12:00:00Z') })).toEqual([]);
  });

  it('stops at the limit, breaking ties by name', async () => {
    const skus = (db.prepare('SELECT sku FROM products WHERE active = 1 ORDER BY sku').all() as Array<{ sku: string }>).map((r) => r.sku);
    for (const sku of skus) await sell(sku, 1);
    const picks = topSellingProducts(db, 'WALK_IN', L, { limit: 3 });
    expect(picks).toHaveLength(Math.min(3, skus.length));
    const names = picks.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
