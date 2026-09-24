// Correct a sale (Approach A, additive-only): voids the original + re-rings it
// pre-filled at snapshot prices + the added items, one superseding sale.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { computeAndCloseShift, openShift, submitClosingCount } from '../src/main/services/shifts';
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
      extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
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
      extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
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
      extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
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
    const pay = { extraPayment: { method: 'CASH' as const }, correctorShiftId: shiftId };

    await expect(correctSale(db, { originalSaleId: origId, addedLines: [], ...pay, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' }))
      .rejects.toThrow(/add at least one item/);

    // first correction succeeds
    await correctSale(db, { originalSaleId: origId, addedLines: added, ...pay, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' });
    // the original is now voided + superseded → a second correction is refused
    await expect(correctSale(db, { originalSaleId: origId, addedLines: added, ...pay, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' }))
      .rejects.toThrow(/already (voided|corrected)/);
  });
});

describe('correctSale keeps what the customer already paid', () => {
  const CUST = 'cu-correct';
  beforeEach(() => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, current_balance_pesewas,
        credit_limit_pesewas, credit_terms_days, blocked, empties_owed_count, created_by, updated_by, device_id)
       VALUES (?, 'Auntie Akos', '+233500000009', 'WALK_IN_REGULAR', 0, 0, 14, 0, 0, ?, ?, ?)`,
    ).run(CUST, W, W, D);
  });

  const balance = () =>
    (db.prepare('SELECT current_balance_pesewas AS b FROM customers WHERE id = ?').get(CUST) as { b: number }).b;
  const tenders = (saleId: string) =>
    db.prepare('SELECT payment_method AS m, amount_pesewas AS a, reference AS r, change_pesewas AS c FROM sale_payments WHERE sale_id = ? ORDER BY display_order')
      .all(saleId) as Array<{ m: string; a: number; r: string | null; c: number | null }>;
  const expectedCashAtClose = () => {
    submitClosingCount(db, shiftId, 0, W, D);
    return computeAndCloseShift(db, shiftId, W, D).expectedPesewas;
  };
  async function ring(paymentMethod: string, extra: Record<string, unknown> = {}) {
    const star = product('STAR-330');
    return (await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 10, unitPricePesewas: 800 }],
      paymentMethod, deviceId: D, shopName: 'TEST', ...extra,
    })).saleId;
  }
  const addOne = () => [{ productId: product('STAR-330').id, quantity: 1, unitPricePesewas: 800 }];
  const base = { workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST' };

  it('a pay-later sale stays on the account; only the extra is collected', async () => {
    const origId = await ring('CREDIT', { customerId: CUST });
    const due = (db.prepare('SELECT credit_due_date AS d FROM sales WHERE id = ?').get(origId) as { d: string }).d;
    expect(balance()).toBe(8000);

    const res = await correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH', cashGivenPesewas: 1000 }, correctorShiftId: shiftId,
    });

    expect(balance()).toBe(8000);
    expect(tenders(res.newSaleId)).toEqual([
      { m: 'CREDIT', a: 8000, r: null, c: null },
      { m: 'CASH', a: 800, r: null, c: 200 },
    ]);
    expect(res.changePesewas).toBe(200);
    const kept = db.prepare('SELECT credit_due_date AS d FROM sales WHERE id = ?').get(res.newSaleId) as { d: string };
    expect(kept.d).toBe(due);
    // The drawer gained the GH¢8 extra and nothing else.
    expect(expectedCashAtClose()).toBe(5000 + 800);
  });

  it('an extra put on the account joins the same pay-later tender', async () => {
    const origId = await ring('CREDIT', { customerId: CUST });
    const res = await correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CREDIT' }, correctorShiftId: shiftId,
    });
    expect(balance()).toBe(8800);
    expect(tenders(res.newSaleId)).toEqual([{ m: 'CREDIT', a: 8800, r: null, c: null }]);
    expect(expectedCashAtClose()).toBe(5000);
  });

  it('a MoMo sale stays MoMo with its reference; the extra gets its own line', async () => {
    const origId = await ring('MOMO_MTN', { paymentReference: 'MP240924.1011.A1' });
    const res = await correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'MOMO_VODAFONE', reference: ' TC-778 ' }, correctorShiftId: shiftId,
    });
    expect(tenders(res.newSaleId)).toEqual([
      { m: 'MOMO_MTN', a: 8000, r: 'MP240924.1011.A1', c: null },
      { m: 'MOMO_VODAFONE', a: 800, r: 'TC-778', c: null },
    ]);
    expect(expectedCashAtClose()).toBe(5000);
  });

  it('a cash sale corrected in cash is one cash line for the new total', async () => {
    const origId = await ring('CASH', { cashGivenPesewas: 8000 });
    const res = await correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH', cashGivenPesewas: 1000 }, correctorShiftId: shiftId,
    });
    expect(tenders(res.newSaleId)).toEqual([{ m: 'CASH', a: 8800, r: null, c: 200 }]);
    expect(expectedCashAtClose()).toBe(5000 + 8800);
  });

  it('refuses pay later with no customer, and cash short of the extra', async () => {
    const origId = await ring('CASH', { cashGivenPesewas: 8000 });
    await expect(correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CREDIT' }, correctorShiftId: shiftId,
    })).rejects.toThrow(/needs a customer/);
    await expect(correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH', cashGivenPesewas: 500 }, correctorShiftId: shiftId,
    })).rejects.toThrow(/less than the amount/);
  });

  it("refuses a sale from a closed shift, another cashier's shift, or an earlier day", async () => {
    const origId = await ring('CASH', { cashGivenPesewas: 8000 });
    const other = openShift(db, { workerId: SUP, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 0, deviceId: D }).shiftId;
    await expect(correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH' }, correctorShiftId: other,
    })).rejects.toThrow(/another cashier's shift/);

    db.prepare("UPDATE sales SET created_at = '2020-01-01T10:00:00.000Z' WHERE id = ?").run(origId);
    await expect(correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
    })).rejects.toThrow(/only sales from today/);
    db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(new Date().toISOString(), origId);

    submitClosingCount(db, shiftId, 13000, W, D);
    computeAndCloseShift(db, shiftId, W, D);
    await expect(correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH' }, correctorShiftId: null,
    })).rejects.toThrow(/shift is closed/);
  });

  it('refuses a pay-later sale the customer has already paid towards', async () => {
    const origId = await ring('CREDIT', { customerId: CUST });
    db.prepare(
      `INSERT INTO customer_payments (id, customer_id, amount_pesewas, payment_method, received_at, received_by,
         created_by, updated_by, device_id)
       VALUES ('cp-1', ?, 1000, 'CASH', ?, ?, ?, ?, ?)`,
    ).run(CUST, new Date().toISOString(), W, W, W, D);
    db.prepare(
      `INSERT INTO customer_payment_allocations (id, customer_payment_id, sale_id, amount_pesewas, created_by, updated_by, device_id)
       VALUES ('cpa-1', 'cp-1', ?, 1000, ?, ?, ?)`,
    ).run(origId, W, W, D);
    await expect(correctSale(db, {
      ...base, originalSaleId: origId, addedLines: addOne(),
      extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
    })).rejects.toThrow(/already paid towards/);
  });
});

describe('correctSale and stock not yet recorded', () => {
  it('asks for the same acknowledgement as the sale screen when the goods outrun recorded stock', async () => {
    const star = product('STAR-330');
    // 24 recorded; 30 sold because the delivery wasn't entered yet.
    const orig = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 30, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 24000, allowUnrecordedStock: true, deviceId: D, shopName: 'TEST',
    });
    const add = [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }];
    await expect(correctSale(db, {
      originalSaleId: orig.saleId, addedLines: add, extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
      workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/Restock not recorded yet/);

    const res = await correctSale(db, {
      originalSaleId: orig.saleId, addedLines: add, extraPayment: { method: 'CASH' }, correctorShiftId: shiftId,
      allowUnrecordedStock: true, workerId: W, workerName: 'Naj', deviceId: D, shopName: 'TEST',
    });
    expect(res.totalPesewas).toBe(24800);
    expect(unitsOnHand(db, star.id, L)).toBe(24 - 31);
  });
});
