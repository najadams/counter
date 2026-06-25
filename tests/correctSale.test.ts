// Correct a sale (Approach A, additive-only): voids the original + re-rings it
// pre-filled at snapshot prices + the added items, one superseding sale.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { correctSale } from '../src/main/services/correctSale';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { unitsOnHand } from '../src/main/services/stockMovements';

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
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

function product(sku: string) {
  return db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: string };
}

async function baseSale() {
  const star = product('STAR-330');
  const r = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: star.id, quantity: 3, unitPricePesewas: 800 }],
    paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'TEST',
  });
  return r.saleId;
}

describe('correctSale (additive)', () => {
  it('voids the original, rings a superseding sale, and links both ways', async () => {
    const origId = await baseSale();
    const star = product('STAR-330');

    const res = await correctSale(db, {
      originalSaleId: origId,
      addedLines: [{ productId: star.id, quantity: 2, unitPricePesewas: 800 }],
      payments: [{ method: 'CASH', amountPesewas: 4000, cashGivenPesewas: 4000 }],
      workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST',
    });

    // total = original 2400 + added 2×800; delta = 1600
    expect(res.totalPesewas).toBe(4000);
    expect(res.deltaPesewas).toBe(1600);
    expect(res.newSaleId).not.toBe(origId);

    const orig = db.prepare('SELECT voided, superseded_by_sale_id AS sup FROM sales WHERE id = ?').get(origId) as { voided: number; sup: string | null };
    expect(orig.voided).toBe(1);
    expect(orig.sup).toBe(res.newSaleId);

    const repl = db.prepare('SELECT supersedes_sale_id AS sub, voided, total_pesewas AS total FROM sales WHERE id = ?').get(res.newSaleId) as { sub: string | null; voided: number; total: number };
    expect(repl.sub).toBe(origId);
    expect(repl.voided).toBe(0);
    expect(repl.total).toBe(4000);

    // receipt carries the CORRECTED banner pointing at the original
    expect(res.receipt.correctedFromReceiptId).toBe(origId);

    // audit: SALE_CORRECTED on the new sale + SALE_VOIDED on the original
    const corrected = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SALE_CORRECTED' AND entity_id = ?").get(res.newSaleId) as { n: number };
    expect(corrected.n).toBe(1);
    const voided = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SALE_VOIDED' AND entity_id = ?").get(origId) as { n: number };
    expect(voided.n).toBe(1);
  });

  it('nets stock correctly: void restores originals, re-ring deducts originals + additions', async () => {
    const star = product('STAR-330');
    const before = unitsOnHand(db, star.id, L);   // 24
    const origId = await baseSale();               // -3 → 21
    expect(unitsOnHand(db, star.id, L)).toBe(before - 3);

    await correctSale(db, {
      originalSaleId: origId,
      addedLines: [{ productId: star.id, quantity: 2, unitPricePesewas: 800 }],
      payments: [{ method: 'CASH', amountPesewas: 4000, cashGivenPesewas: 4000 }],
      workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST',
    });
    // net: 24 restored to original then 5 sold (3 + 2) → 19
    expect(unitsOnHand(db, star.id, L)).toBe(before - 5);
  });

  it('snapshots the original line price — a later price change does not drift the total', async () => {
    const star = product('STAR-330');
    const origId = await baseSale(); // STAR @ 800 each, total 2400

    // The corrected original lines must keep 800 even if the cashier passes a
    // different added-line price; lockPrices means originals are not re-priced.
    const res = await correctSale(db, {
      originalSaleId: origId,
      addedLines: [{ productId: star.id, quantity: 1, unitPricePesewas: 950 }],
      payments: [{ method: 'CASH', amountPesewas: 3350, cashGivenPesewas: 3350 }],
      workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST',
    });
    // 2400 (3×800 snapshot) + 950 (added) = 3350 exactly
    expect(res.totalPesewas).toBe(3350);
    const origLine = db.prepare("SELECT unit_price_pesewas AS p, quantity AS q FROM sale_lines WHERE sale_id = ? ORDER BY quantity DESC").get(res.newSaleId) as { p: number; q: number };
    expect(origLine.p).toBe(800); // original line preserved its snapshot price
    expect(origLine.q).toBe(3);
  });

  it('refuses empty additions, a voided original, and a re-correction', async () => {
    const origId = await baseSale();
    const star = product('STAR-330');
    const added = [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }];
    const pay = [{ method: 'CASH', amountPesewas: 3200, cashGivenPesewas: 3200 }];

    await expect(correctSale(db, { originalSaleId: origId, addedLines: [], payments: pay, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' }))
      .rejects.toThrow(/add at least one item/);

    // first correction succeeds
    await correctSale(db, { originalSaleId: origId, addedLines: added, payments: pay, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' });
    // the original is now voided + superseded → a second correction is refused
    await expect(correctSale(db, { originalSaleId: origId, addedLines: added, payments: pay, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' }))
      .rejects.toThrow(/already (voided|corrected)/);
  });
});
