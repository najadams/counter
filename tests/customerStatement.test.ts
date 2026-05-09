// customerStatement.test.ts — Wave C.1 verification.
//
// Builds a printable statement and confirms every section matches the
// underlying sales/payments. Mirrors the setup in customerCredit.test.ts
// so we get a realistic mix of aging buckets.

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { recordCustomerPayment, reconcileCustomerBalance } from '../src/main/services/customerCredit';
import { buildCustomerStatement } from '../src/main/services/customerStatement';

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

function star() {
  return db.prepare('SELECT id, cost_price_pesewas FROM products LIMIT 1')
    .get() as { id: string; cost_price_pesewas: number };
}

async function makeCreditSale(amountPesewas: number) {
  const p = star();
  const qty = Math.max(1, Math.floor(amountPesewas / 800));
  const r = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: p.id, quantity: qty, unitPricePesewas: 800 }],
    paymentMethod: 'CREDIT', customerId: custId, deviceId: D, shopName: 'T',
  });
  db.prepare('UPDATE sales SET total_pesewas = ?, subtotal_pesewas = ? WHERE id = ?')
    .run(amountPesewas, amountPesewas, r.saleId);
  reconcileCustomerBalance(db, custId);
  return r.saleId;
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
                            current_balance_pesewas, created_by, updated_by, device_id)
     VALUES (?, 'Mama Akua', '+233244111222', 'WHOLESALE', 50000, 0, ?, ?, ?)`,
  ).run(custId, W, W, D);
});

describe('buildCustomerStatement', () => {
  it('aggregates open invoices into the right aging buckets', async () => {
    const a = await makeCreditSale(1000); // current
    const b = await makeCreditSale(2000); setBackdated(b, 45);  // 31-60
    const c = await makeCreditSale(3000); setBackdated(c, 75);  // 61-90
    const d = await makeCreditSale(4000); setBackdated(d, 120); // 90+

    const stmt = buildCustomerStatement(db, { customerId: custId });

    expect(stmt.customer.displayName).toBe('Mama Akua');
    expect(stmt.customer.creditLimitPesewas).toBe(50000);
    expect(stmt.totals.outstandingPesewas).toBe(1000 + 2000 + 3000 + 4000);
    expect(stmt.totals.bucket0_30).toBe(1000);
    expect(stmt.totals.bucket31_60).toBe(2000);
    expect(stmt.totals.bucket61_90).toBe(3000);
    expect(stmt.totals.bucket90_plus).toBe(4000);
    expect(stmt.openInvoices.length).toBe(4);
    // Oldest first.
    expect(stmt.openInvoices[0]?.saleId).toBe(d);
    // shortRef is the last 6 chars uppercased.
    expect(stmt.openInvoices[0]?.shortRef).toBe(d.slice(-6).toUpperCase());
  });

  it('lists payments newest-first within the history window', async () => {
    const a = await makeCreditSale(5000);
    setBackdated(a, 5);

    recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 1500, paymentMethod: 'CASH',
      workerId: W, deviceId: D, shiftId,
    });
    recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 2500, paymentMethod: 'MOMO_MTN',
      paymentReference: 'TX99', workerId: W, deviceId: D, shiftId,
    });

    const stmt = buildCustomerStatement(db, { customerId: custId });
    expect(stmt.recentPayments.length).toBe(2);
    expect(stmt.totals.paidThisPeriodPesewas).toBe(4000);
    // Newest first.
    expect(stmt.recentPayments[0]?.amountPesewas).toBe(2500);
    expect(stmt.recentPayments[0]?.paymentMethod).toBe('MOMO_MTN');
    expect(stmt.recentPayments[0]?.paymentReference).toBe('TX99');
  });

  it('honours the monthsOfHistory cutoff', async () => {
    await makeCreditSale(1000);
    recordCustomerPayment(db, {
      customerId: custId, amountPesewas: 500, paymentMethod: 'CASH',
      workerId: W, deviceId: D, shiftId,
    });
    // Backdate the payment to 8 months ago.
    db.prepare('UPDATE customer_payments SET received_at = ?')
      .run(new Date(Date.now() - 8 * 30 * 86400_000).toISOString());

    const wide = buildCustomerStatement(db, { customerId: custId, monthsOfHistory: 12 });
    expect(wide.recentPayments.length).toBe(1);

    const narrow = buildCustomerStatement(db, { customerId: custId, monthsOfHistory: 3 });
    expect(narrow.recentPayments.length).toBe(0);
    expect(narrow.totals.paidThisPeriodPesewas).toBe(0);
  });

  it('excludes voided sales from open invoices', async () => {
    const a = await makeCreditSale(1000);
    const b = await makeCreditSale(2000);
    db.prepare(`UPDATE sales SET voided = 1, voided_at = ?, voided_by = ?, void_reason = 'test' WHERE id = ?`)
      .run(new Date().toISOString(), W, a);

    const stmt = buildCustomerStatement(db, { customerId: custId });
    expect(stmt.openInvoices.length).toBe(1);
    expect(stmt.openInvoices[0]?.saleId).toBe(b);
    expect(stmt.totals.outstandingPesewas).toBe(2000);
  });

  it('includes shop header from device_config', () => {
    const stmt = buildCustomerStatement(db, { customerId: custId });
    expect(stmt.shop.name).toBeTruthy();
    expect(typeof stmt.asOfDate).toBe('string');
    expect(stmt.pleaseSettleByDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('throws if the customer does not exist', () => {
    expect(() => buildCustomerStatement(db, { customerId: 'cust-nonexistent' }))
      .toThrow(/not found/);
  });
});
