// Cash paid back to customers (migration 0056): every refund comes out of the
// drawer that paid it, a sale's cash stays counted in the drawer that took it,
// and the day's figures and reports are net of customer returns.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';
import { computeAndCloseShift, openShift, submitClosingCount } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { createSaleVoidRequest, reviewSaleVoidRequest } from '../src/main/services/voids';
import { recordCustomerReturn } from '../src/main/services/customerReturns';
import { recordCashDrop, getCurrentExpectedCash } from '../src/main/services/cashDrops';
import { generateDailySummary } from '../src/main/services/dailySummaries';
import { getMarginReport, getReportsOverview, getSalesReport } from '../src/main/services/reports';
import { _resetPrinter, _setPrinter } from '../src/main/printer/printer';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const AMA = 'dev-counter-1';
const KOFI = 'kofi-counter';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';
const CUST = 'cu-refunds';

let db: ReturnType<typeof Database>;
let star = '';

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
        VALUES (?, ?, ?, 240, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 240 * p.cost_price_pesewas, SUP, AMA, AMA, D);
  }
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash, active, hired_at, created_by, updated_by, device_id)
     VALUES (?, 'Kofi', '+233244000777', 'COUNTER', ?, 1, '2026-01-01', 'sys-system', 'sys-system', ?)`,
  ).run(KOFI, bcrypt.hashSync('4321', PIN_BCRYPT_ROUNDS), D);
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type, current_balance_pesewas,
       credit_limit_pesewas, blocked, empties_owed_count, created_by, updated_by, device_id)
     VALUES (?, 'Auntie Refund', '+233500000055', 'WALK_IN_REGULAR', 0, 0, 0, 0, ?, ?, ?)`,
  ).run(CUST, AMA, AMA, D);
  star = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

const open = (workerId: string, cash = 0) =>
  openShift(db, { workerId, locationId: L, shiftType: 'COUNTER', openingCashPesewas: cash, deviceId: D }).shiftId;
const close = (shiftId: string, workerId: string, counted: number) => {
  submitClosingCount(db, shiftId, counted, workerId, D);
  return computeAndCloseShift(db, shiftId, workerId, D);
};
async function cashSale(shiftId: string, workerId: string, bottles = 10, customerId?: string) {
  return (await completeSale(db, {
    shiftId, workerId, workerName: workerId, locationId: L, channel: 'WALK_IN',
    lines: [{ productId: star, quantity: bottles, unitPricePesewas: 800 }],
    paymentMethod: 'CASH', cashGivenPesewas: bottles * 800, customerId, deviceId: D, shopName: 'T',
  })).saleId;
}
function voidIt(saleId: string, requester: string, refundCash?: boolean) {
  const req = createSaleVoidRequest(db, {
    saleId, reason: 'customer brought it all back', requesterWorkerId: requester, deviceId: D, refundCash,
  });
  return { req, approve: () => reviewSaleVoidRequest(db, { requestId: req.id, decision: 'APPROVE', reviewerWorkerId: SUP, deviceId: D }) };
}
const refunds = () =>
  db.prepare('SELECT shift_id AS shiftId, amount_pesewas AS amount, source_type AS source FROM cash_refunds').all();
const pad = (n: number) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

describe('void refunds come out of the drawer that pays them', () => {
  it('a refund for a sale from a shift that already closed comes out of the current drawer', async () => {
    const morning = open(AMA);
    const saleId = await cashSale(morning, AMA);
    const closedMorning = close(morning, AMA, 8000);
    expect(closedMorning.variancePesewas).toBe(0);

    const evening = open(AMA, 10000);
    const { req, approve } = voidIt(saleId, AMA);
    expect(req.cashRefundPesewas).toBe(8000);
    expect(req.refundShiftId).toBe(evening);
    approve();

    expect(refunds()).toEqual([{ shiftId: evening, amount: 8000, source: 'SALE_VOID' }]);
    // GH¢100 float − GH¢80 handed back = GH¢20 in the drawer: no shortage.
    expect(close(evening, AMA, 2000).variancePesewas).toBe(0);
    // The morning drawer took that GH¢80 in; it still counts there.
    expect(getCurrentExpectedCash(db, morning)).toBe(8000);
  });

  it("another till's cashier can refund a sale; each drawer stays right", async () => {
    const amaTill = open(AMA);
    const kofiTill = open(KOFI, 10000);
    const saleId = await cashSale(amaTill, AMA);
    voidIt(saleId, KOFI).approve();

    expect(getCurrentExpectedCash(db, amaTill)).toBe(8000);
    expect(getCurrentExpectedCash(db, kofiTill)).toBe(2000);
  });

  it('a refund in the same shift nets to the same drawer as before', async () => {
    const till = open(AMA, 1000);
    const saleId = await cashSale(till, AMA);
    voidIt(saleId, AMA).approve();
    expect(getCurrentExpectedCash(db, till)).toBe(1000);
    expect(refunds()).toHaveLength(1);
  });

  it('"no cash changes hands" takes the sale out and records no refund', async () => {
    const till = open(AMA, 1000);
    const saleId = await cashSale(till, AMA);
    const { req, approve } = voidIt(saleId, AMA, false);
    expect(req.cashRefundPesewas).toBeNull();
    approve();
    expect(getCurrentExpectedCash(db, till)).toBe(1000);
    expect(refunds()).toHaveLength(0);
  });

  it('the paying drawer cannot close while the request waits', async () => {
    const morning = open(AMA);
    const saleId = await cashSale(morning, AMA);
    close(morning, AMA, 8000);
    const evening = open(AMA, 10000);
    voidIt(saleId, AMA);
    expect(() => close(evening, AMA, 10000)).toThrow(/pending void request/);
  });

  it('refuses a refund bigger than the paying drawer holds', async () => {
    const morning = open(AMA);
    const saleId = await cashSale(morning, AMA);
    close(morning, AMA, 8000);
    open(AMA, 5000);
    const { approve } = voidIt(saleId, AMA);
    expect(approve).toThrow(/more than the drawer holds/);
    expect(refunds()).toHaveLength(0);
  });

  it('refuses a refund when no drawer is open to pay it', async () => {
    const morning = open(AMA);
    const saleId = await cashSale(morning, AMA);
    close(morning, AMA, 8000);
    expect(() => voidIt(saleId, SUP)).toThrow(/no open drawer/);
    expect(voidIt(saleId, SUP, false).req.cashRefundPesewas).toBeNull();
  });
});

describe('customer returns', () => {
  it('a cash refund is taken out of the drawer and out of the day’s figures', async () => {
    const till = open(AMA, 1000);
    const saleId = await cashSale(till, AMA, 10, CUST);
    const drop = (db.prepare("SELECT COUNT(*) AS n FROM cash_counts WHERE count_type = 'CASH_DROP'").get() as { n: number }).n;
    recordCustomerReturn(db, {
      customerId: CUST, originalSaleId: saleId, locationId: L, workerId: AMA, shiftId: till,
      supervisorWorkerId: SUP, supervisorPin: '9999', refundMethod: 'CASH', reason: 'five bottles were warm',
      lines: [{ productId: star, quantity: 5, unitPricePesewas: 800 }], deviceId: D,
    });

    expect(getCurrentExpectedCash(db, till)).toBe(1000 + 8000 - 4000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM cash_counts WHERE count_type = 'CASH_DROP'").get() as { n: number }).n).toBe(drop);
    // Cash drops are still capped by what's really in the drawer.
    expect(() => recordCashDrop(db, {
      shiftId: till, workerId: AMA, amountPesewas: 6000, recipient: 'Safe',
      supervisorWorkerId: SUP, supervisorPin: '9999', deviceId: D,
    })).toThrow(/exceeds current expected cash/);

    const cost = (db.prepare("SELECT cost_price_pesewas AS c FROM products WHERE id = ?").get(star) as { c: number }).c;
    const summary = generateDailySummary(db, { date: new Date().toISOString().slice(0, 10), locationId: L, workerId: SUP, deviceId: D });
    expect(summary.totalRevenuePesewas).toBe(4000);
    expect(summary.totalCostOfGoodsSoldPesewas).toBe(5 * cost);
    expect(summary.grossMarginPesewas).toBe(4000 - 5 * cost);
    expect(summary.totalReturnsPesewas).toBe(4000);
    expect(summary.numReturns).toBe(1);
    expect(summary.cashRefundedPesewas).toBe(4000);
  });

  it('Overview, Sales and Margin reports are net of returns', async () => {
    const till = open(AMA, 1000);
    const saleId = await cashSale(till, AMA, 10, CUST);
    recordCustomerReturn(db, {
      customerId: CUST, originalSaleId: saleId, locationId: L, workerId: AMA, shiftId: till,
      supervisorWorkerId: SUP, supervisorPin: '9999', refundMethod: 'CASH', reason: 'five bottles were warm',
      lines: [{ productId: star, quantity: 5, unitPricePesewas: 800 }], deviceId: D,
    });
    const cost = (db.prepare("SELECT cost_price_pesewas AS c FROM products WHERE id = ?").get(star) as { c: number }).c;
    const today = localToday();

    const overview = getReportsOverview(db, { actorWorkerId: SUP });
    expect(overview.revenue.todayPesewas).toBe(4000);

    const sales = getSalesReport(db, { actorWorkerId: SUP, fromDate: today, toDate: today, groupBy: 'day' });
    expect(sales.totalRevenuePesewas).toBe(4000);
    expect(sales.totalGrossSalesPesewas).toBe(8000);
    expect(sales.totalReturnsPesewas).toBe(4000);
    expect(sales.totalNumReturns).toBe(1);
    expect(sales.buckets[0]).toMatchObject({ revenuePesewas: 4000, returnsPesewas: 4000, avgBasketPesewas: 8000 });

    const margin = getMarginReport(db, { actorWorkerId: SUP, fromDate: today, toDate: today });
    const row = margin.byProduct.find((p) => p.productId === star)!;
    expect(row).toMatchObject({ unitsSold: 5, revenuePesewas: 4000, cogsPesewas: 5 * cost });
    expect(margin.totalRevenuePesewas).toBe(4000);
    expect(margin.byCategory.find((c) => c.category === row.category)!.revenuePesewas).toBe(4000);
  });
});
