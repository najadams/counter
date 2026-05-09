// Customer credit: payment FIFO allocation, balance reconciliation,
// aging buckets, blocked + needs-review filters.

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
  getAgingSummary, getCustomerOverview, listCustomersByOutstanding,
  listOpenSalesForCustomer, recordCustomerPayment, reconcileCustomerBalance,
} from '../src/main/services/customerCredit';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let custId: string;

function setBackdated(saleId: string, daysAgo: number) {
  const iso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(iso, saleId);
}

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
  custId = `cust-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
       created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(custId, 'Yaw Boateng', '+233244999000', 'WALK_IN_REGULAR', 10000, W, W, D);
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

function star() { return db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }; }

async function makeCreditSale(amountPesewas: number) {
  const p = star();
  const qty = Math.max(1, Math.floor(amountPesewas / 800));
  const r = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: p.id, quantity: qty, unitPricePesewas: 800 }],
    paymentMethod: 'CREDIT', customerId: custId, deviceId: D, shopName: 'T',
  });
  // If we want a specific total, normalize via discount with reason — but for
  // these tests we just want predictable balances. Override total directly:
  db.prepare('UPDATE sales SET total_pesewas = ?, subtotal_pesewas = ? WHERE id = ?')
    .run(amountPesewas, amountPesewas, r.saleId);
  // Reconcile cached balance after the manual override above.
  reconcileCustomerBalance(db, custId);
  return r.saleId;
}

describe('listOpenSalesForCustomer', () => {
  it('returns oldest first with age + outstanding', async () => {
    const a = await makeCreditSale(1000);
    setBackdated(a, 45);
    const b = await makeCreditSale(2000);
    setBackdated(b, 10);
    const open = listOpenSalesForCustomer(db, custId);
    expect(open.length).toBe(2);
    expect(open[0]?.saleId).toBe(a);
    expect(open[0]?.ageDays).toBeGreaterThanOrEqual(44);
    expect(open[0]?.outstandingPesewas).toBe(1000);
    expect(open[1]?.saleId).toBe(b);
  });

  it('excludes voided sales', async () => {
    const a = await makeCreditSale(1000);
    db.prepare(`UPDATE sales SET voided = 1, voided_at = ?, voided_by = ?, void_reason = 'test' WHERE id = ?`)
      .run(new Date().toISOString(), W, a);
    expect(listOpenSalesForCustomer(db, custId).length).toBe(0);
  });

  it('excludes fully paid sales', async () => {
    const a = await makeCreditSale(1000);
    recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 1000, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    expect(listOpenSalesForCustomer(db, custId).length).toBe(0);
  });

  it('partial payments leave outstanding > 0', async () => {
    const a = await makeCreditSale(1000);
    recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 400, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    const open = listOpenSalesForCustomer(db, custId);
    expect(open[0]?.outstandingPesewas).toBe(600);
  });
});

describe('recordCustomerPayment — FIFO allocation', () => {
  it('allocates oldest sale first (full)', async () => {
    const a = await makeCreditSale(500);
    setBackdated(a, 30);
    const b = await makeCreditSale(800);
    const r = recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 500, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    expect(r.totalAllocatedPesewas).toBe(500);
    expect(r.allocations.length).toBe(1);
    expect(r.allocations[0]?.saleId).toBe(a);
    expect(r.unallocatedPesewas).toBe(0);
  });

  it('allocates across multiple sales (oldest fully, next partially)', async () => {
    const a = await makeCreditSale(300);
    setBackdated(a, 20);
    const b = await makeCreditSale(400);
    setBackdated(b, 10);
    const c = await makeCreditSale(500);
    const r = recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 600, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    expect(r.allocations).toEqual([
      { saleId: a, amountPesewas: 300 },
      { saleId: b, amountPesewas: 300 },
    ]);
    const open = listOpenSalesForCustomer(db, custId);
    expect(open.length).toBe(2);
    expect(open[0]?.saleId).toBe(b);
    expect(open[0]?.outstandingPesewas).toBe(100);
    expect(open[1]?.saleId).toBe(c);
    expect(open[1]?.outstandingPesewas).toBe(500);
  });

  it('overpayment: unallocated remainder reported, no allocations beyond outstanding', async () => {
    const a = await makeCreditSale(400);
    const r = recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 1000, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    expect(r.totalAllocatedPesewas).toBe(400);
    expect(r.unallocatedPesewas).toBe(600);
    expect(r.allocations.length).toBe(1);
    // Customer balance does NOT go negative.
    const cust = db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(custId) as { current_balance_pesewas: number };
    expect(cust.current_balance_pesewas).toBe(0);
  });

  it('updates cached balance atomically', async () => {
    const a = await makeCreditSale(1000);
    const before = (db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(custId) as { current_balance_pesewas: number }).current_balance_pesewas;
    expect(before).toBe(1000);
    recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 600, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    const after = (db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(custId) as { current_balance_pesewas: number }).current_balance_pesewas;
    expect(after).toBe(400);
  });

  it('audits CUSTOMER_PAYMENT_RECORDED with allocation snapshot', async () => {
    const a = await makeCreditSale(1000);
    const r = recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 600, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    });
    const audit = db.prepare(`SELECT after_value FROM audit_log WHERE entity_id = ? AND action = 'CUSTOMER_PAYMENT_RECORDED'`).get(r.paymentId) as { after_value: string };
    const after = JSON.parse(audit.after_value);
    expect(after.amountPesewas).toBe(600);
    expect(after.totalAllocatedPesewas).toBe(600);
    expect(after.allocations[0].saleId).toBe(a);
  });
});

describe('recordCustomerPayment — manual allocations', () => {
  it('honors explicit allocations[]', async () => {
    const a = await makeCreditSale(500);
    setBackdated(a, 30);
    const b = await makeCreditSale(800);
    const r = recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 800, paymentMethod: 'CASH',
      allocations: [{ saleId: b, amountPesewas: 800 }], // pay newer one specifically
      workerId: W, deviceId: D,
    });
    expect(r.allocations).toEqual([{ saleId: b, amountPesewas: 800 }]);
    const open = listOpenSalesForCustomer(db, custId);
    expect(open.length).toBe(1);
    expect(open[0]?.saleId).toBe(a); // older one still open
  });

  it('rejects allocation sum > payment amount', async () => {
    const a = await makeCreditSale(500);
    expect(() => recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 400, paymentMethod: 'CASH',
      allocations: [{ saleId: a, amountPesewas: 500 }],
      workerId: W, deviceId: D,
    })).toThrow(/allocations total/);
  });

  it('rejects allocation to sale not belonging to this customer', async () => {
    const cust2 = `cust-${uuidv4()}`;
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(cust2, 'Other', '+233244888777', 'WALK_IN_REGULAR', 5000, W, W, D);
    // Create a sale for cust2.
    const p = star();
    const r2 = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: cust2, deviceId: D, shopName: 'T',
    });
    expect(() => recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 800, paymentMethod: 'CASH',
      allocations: [{ saleId: r2.saleId, amountPesewas: 800 }],
      workerId: W, deviceId: D,
    })).toThrow(/not open for this customer/);
  });

  it('rejects allocation amount > sale outstanding', async () => {
    const a = await makeCreditSale(500);
    expect(() => recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 800, paymentMethod: 'CASH',
      allocations: [{ saleId: a, amountPesewas: 800 }],
      workerId: W, deviceId: D,
    })).toThrow(/exceeds outstanding/);
  });
});

describe('recordCustomerPayment — validation', () => {
  it('rejects MoMo without reference', () => {
    expect(() => recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 500, paymentMethod: 'MOMO_MTN',
      workerId: W, deviceId: D,
    })).toThrow(/transaction reference/);
  });

  it('rejects zero / negative amount', () => {
    expect(() => recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 0, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    })).toThrow(/positive integer/);
  });

  it('rejects unknown customer', () => {
    expect(() => recordCustomerPayment(db, {
      customerId: 'nope', amountPesewas: 500, paymentMethod: 'CASH',
      workerId: W, deviceId: D,
    })).toThrow(/not found/);
  });
});

describe('reconcileCustomerBalance', () => {
  it('detects + corrects drift between cache and truth', async () => {
    await makeCreditSale(1000);
    // Manually corrupt the cache.
    db.prepare('UPDATE customers SET current_balance_pesewas = 9999 WHERE id = ?').run(custId);
    const r = reconcileCustomerBalance(db, custId);
    expect(r.previousCached).toBe(9999);
    expect(r.newCached).toBe(1000);
    expect(r.driftPesewas).toBe(8999);
  });

  it('no-op when in sync', async () => {
    await makeCreditSale(1000);
    const first = reconcileCustomerBalance(db, custId);
    expect(first.driftPesewas).toBe(0);
  });
});

describe('aging buckets', () => {
  it('classifies sales into 0-30 / 31-60 / 61-90 / 90+', async () => {
    const a = await makeCreditSale(100); setBackdated(a, 5);    // 0-30
    const b = await makeCreditSale(200); setBackdated(b, 45);   // 31-60
    const c = await makeCreditSale(400); setBackdated(c, 75);   // 61-90
    const d = await makeCreditSale(800); setBackdated(d, 120);  // 90+
    const o = getCustomerOverview(db, custId);
    expect(o.agingBuckets).toEqual({
      bucket0_30: 100, bucket31_60: 200, bucket61_90: 400, bucket90_plus: 800,
    });
    expect(o.ageOfOldestUnpaidDays).toBeGreaterThanOrEqual(120);
  });

  it('boundary at exactly 30 days → 0-30', async () => {
    const a = await makeCreditSale(100); setBackdated(a, 30);
    const o = getCustomerOverview(db, custId);
    expect(o.agingBuckets.bucket0_30).toBe(100);
    expect(o.agingBuckets.bucket31_60).toBe(0);
  });

  it('boundary at exactly 31 days → 31-60', async () => {
    const a = await makeCreditSale(100); setBackdated(a, 31);
    const o = getCustomerOverview(db, custId);
    expect(o.agingBuckets.bucket0_30).toBe(0);
    expect(o.agingBuckets.bucket31_60).toBe(100);
  });
});

describe('listCustomersByOutstanding + getAgingSummary', () => {
  it('listCustomersByOutstanding sorts by balance desc', async () => {
    const cust2 = `cust-${uuidv4()}`;
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(cust2, 'Ama', '+233244111111', 'WALK_IN_REGULAR', 10000, W, W, D);
    await makeCreditSale(500);
    // Sale for cust2 = 1500
    const p = star();
    const r2 = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 2, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: cust2, deviceId: D, shopName: 'T',
    });
    db.prepare('UPDATE sales SET total_pesewas = 1500, subtotal_pesewas = 1500 WHERE id = ?').run(r2.saleId);
    reconcileCustomerBalance(db, cust2);
    const list = listCustomersByOutstanding(db);
    expect(list.length).toBe(2);
    expect(list[0]?.id).toBe(cust2);
    expect(list[0]?.trueBalancePesewas).toBe(1500);
    expect(list[1]?.id).toBe(custId);
  });

  it('agingBucket filter returns only customers with their oldest unpaid in that bucket', async () => {
    const a = await makeCreditSale(500);
    setBackdated(a, 90 + 5);
    const list = listCustomersByOutstanding(db, { agingBucket: 'bucket90_plus' });
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(custId);
    expect(listCustomersByOutstanding(db, { agingBucket: 'bucket0_30' }).length).toBe(0);
  });

  it('excludes blocked unless includeBlocked', async () => {
    await makeCreditSale(500);
    db.prepare(`UPDATE customers SET blocked = 1, blocked_reason = 'over' WHERE id = ?`).run(custId);
    expect(listCustomersByOutstanding(db).length).toBe(0);
    expect(listCustomersByOutstanding(db, { includeBlocked: true }).length).toBe(1);
  });

  it('getAgingSummary aggregates totals across all customers', async () => {
    const a = await makeCreditSale(100); setBackdated(a, 5);
    const b = await makeCreditSale(200); setBackdated(b, 45);
    const c = await makeCreditSale(400); setBackdated(c, 100);
    const s = getAgingSummary(db);
    expect(s.bucket0_30).toBe(100);
    expect(s.bucket31_60).toBe(200);
    expect(s.bucket90_plus).toBe(400);
    expect(s.total).toBe(700);
  });

  it('needsReviewCount counts active customers at/over their limit', async () => {
    db.prepare('UPDATE customers SET credit_limit_pesewas = 1000 WHERE id = ?').run(custId);
    await makeCreditSale(1000);
    const s = getAgingSummary(db);
    expect(s.needsReviewCount).toBe(1);
  });

  it('blockedCount counts blocked customers regardless of balance', async () => {
    db.prepare(`UPDATE customers SET blocked = 1, blocked_reason = 'r' WHERE id = ?`).run(custId);
    const s = getAgingSummary(db);
    expect(s.blockedCount).toBe(1);
  });
});

describe('getCustomerOverview', () => {
  it('returns true balance from truth, exposes drift', async () => {
    await makeCreditSale(1000);
    db.prepare('UPDATE customers SET current_balance_pesewas = 9999 WHERE id = ?').run(custId);
    const o = getCustomerOverview(db, custId);
    expect(o.trueBalancePesewas).toBe(1000);
    expect(o.cachedBalancePesewas).toBe(9999);
    expect(o.driftPesewas).toBe(8999);
  });

  it('utilizationBps reflects balance vs limit', async () => {
    await makeCreditSale(5000);
    const o = getCustomerOverview(db, custId);
    expect(o.utilizationBps).toBe(5000); // 50% of 10000-pesewa limit
  });

  it('utilizationBps caps reasonably when limit is 0 and balance > 0', async () => {
    db.prepare('UPDATE customers SET credit_limit_pesewas = 0 WHERE id = ?').run(custId);
    await makeCreditSale(500);
    const o = getCustomerOverview(db, custId);
    expect(o.utilizationBps).toBe(99999);
  });
});
