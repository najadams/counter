import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { getBalanceSheetReport, getCashflowReport } from '../src/main/services/reports';
import { recordCashDrop } from '../src/main/services/cashDrops';
import { recordExpense } from '../src/main/services/expenses';
import { _resetPrinter, _setPrinter } from '../src/main/printer/printer';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'financial-statements-test-device';

let db!: ReturnType<typeof Database>;
let shiftId: string;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SUP);
  shiftId = openShift(db, {
    workerId: W,
    locationId: L,
    shiftType: 'COUNTER',
    openingCashPesewas: 10000,
    deviceId: D,
  }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => {
  _resetPrinter();
  db?.close();
});

function star() {
  return db.prepare("SELECT id, cost_price_pesewas AS cost, walk_in_price_pesewas AS price FROM products WHERE sku = 'STAR-330'")
    .get() as { id: string; cost: number; price: number };
}

function supplierId() {
  return (db.prepare('SELECT id FROM suppliers ORDER BY created_at LIMIT 1').get() as { id: string }).id;
}

async function seedStatementActivity() {
  const product = star();
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
      shift_id, worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
      created_by, updated_by, device_id)
     VALUES (?, ?, ?, 24, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`sm-${uuidv4()}`, product.id, L, shiftId, SUP, product.cost, 24 * product.cost, SUP, W, W, D);

  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
       created_by, updated_by, device_id)
     VALUES ('cust-fin-1', 'Ama Credit', '+233244000001', 'WALK_IN_REGULAR', 100000, ?, ?, ?)`,
  ).run(W, W, D);

  const sale = await completeSale(db, {
    shiftId,
    workerId: W,
    workerName: 'Dev Counter',
    locationId: L,
    channel: 'WALK_IN',
    customerId: 'cust-fin-1',
    lines: [{ productId: product.id, quantity: 4, unitPricePesewas: product.price }],
    payments: [
      { method: 'CASH', amountPesewas: 1000, cashGivenPesewas: 1000 },
      { method: 'MOMO_MTN', amountPesewas: 1200, reference: 'MTN-123' },
      { method: 'CREDIT', amountPesewas: 1000 },
    ],
    deviceId: D,
    shopName: 'Counter Test',
  });

  const paymentId = `cp-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customer_payments (id, customer_id, amount_pesewas, payment_method,
       received_at, received_by, shift_id, created_by, updated_by, device_id)
     VALUES (?, 'cust-fin-1', 400, 'CASH', ?, ?, ?, ?, ?, ?)`,
  ).run(paymentId, new Date().toISOString(), W, shiftId, W, W, D);
  db.prepare(
    `INSERT INTO customer_payment_allocations (id, customer_payment_id, sale_id,
       amount_pesewas, created_by, updated_by, device_id)
     VALUES (?, ?, ?, 400, ?, ?, ?)`,
  ).run(`cpa-${uuidv4()}`, paymentId, sale.saleId, W, W, D);
  db.prepare('UPDATE customers SET current_balance_pesewas = 600 WHERE id = ?').run('cust-fin-1');

  recordCashDrop(db, {
    shiftId,
    workerId: W,
    amountPesewas: 500,
    recipient: 'Safe',
    supervisorWorkerId: SUP,
    supervisorPin: '9999',
    deviceId: D,
  });
  recordCashDrop(db, {
    shiftId,
    workerId: W,
    amountPesewas: 1000,
    recipient: 'Dad',
    category: 'OWNER_DRAWING',
    supervisorWorkerId: SUP,
    supervisorPin: '9999',
    deviceId: D,
  });
  recordExpense(db, {
    shiftId,
    locationId: L,
    workerId: W,
    amountPesewas: 700,
    category: 'TRANSPORT',
    payee: 'Runner',
    deviceId: D,
  });

  const sup = supplierId();
  db.prepare(
    `INSERT INTO supplier_invoices (id, supplier_id, invoice_number, invoice_date,
       total_pesewas, total_paid_pesewas, status, created_by, updated_by, device_id)
     VALUES ('sinv-fin-1', ?, 'FIN-1', ?, 5000, 0, 'OPEN', ?, ?, ?)`,
  ).run(sup, todayISO(), W, W, D);
  db.prepare(
    `INSERT INTO supplier_payments (id, supplier_id, amount_pesewas, payment_method,
       paid_at, approved_by, created_by, updated_by, device_id)
     VALUES ('spay-fin-1', ?, 2000, 'BANK_TRANSFER', ?, ?, ?, ?, ?)`,
  ).run(sup, new Date().toISOString(), SUP, W, W, D);
  db.prepare('UPDATE suppliers SET current_balance_pesewas = 3000 WHERE id = ?').run(sup);

  db.prepare(
    `INSERT INTO tax_payments (id, location_id, shift_id, tax_period_from, tax_period_to,
       amount_pesewas, payment_method, paid_at, created_by, updated_by, device_id)
     VALUES ('taxpay-fin-1', ?, ?, ?, ?, 300, 'CASH', ?, ?, ?, ?)`,
  ).run(L, shiftId, todayISO(), todayISO(), new Date().toISOString(), SUP, SUP, D);
}

describe('financial statement service authorization', () => {
  it('requires an owner reporting role and records the sensitive view', () => {
    expect(() => getBalanceSheetReport(db, {
      actorWorkerId: W,
      asOfDate: todayISO(),
      deviceId: D,
    })).toThrow(/role COUNTER/);

    const report = getBalanceSheetReport(db, {
      actorWorkerId: SUP,
      asOfDate: todayISO(),
      deviceId: D,
    });
    expect(report.assets.totalPesewas).toBeGreaterThanOrEqual(0);

    const audit = db.prepare(
      `SELECT action FROM audit_log
        WHERE worker_id = ? AND action = 'FINANCIAL_STATEMENT_VIEWED'
        ORDER BY created_at DESC LIMIT 1`,
    ).get(SUP) as { action: string };
    expect(audit.action).toBe('FINANCIAL_STATEMENT_VIEWED');
  });
});

describe('financial statement math', () => {
  it('builds a management balance sheet from recorded Counter balances', async () => {
    await seedStatementActivity();

    const report = getBalanceSheetReport(db, {
      actorWorkerId: SUP,
      asOfDate: todayISO(),
      pin: '9999',
      deviceId: D,
    });

    expect(report.assets.inventoryAtCostPesewas).toBe(12000);
    expect(report.assets.customerReceivablesPesewas).toBe(600);
    expect(report.assets.openTillCashPesewas).toBe(8900);
    expect(report.assets.taxCreditPesewas).toBe(700);
    expect(report.liabilities.supplierPayablesPesewas).toBe(3000);
    expect(report.liabilities.taxPayablePesewas).toBe(0);
    expect(report.equity.totalPesewas).toBe(report.assets.totalPesewas - report.liabilities.totalPesewas);
  });

  it('builds direct-method cashflow and separates transfers/non-cash movements', async () => {
    await seedStatementActivity();

    const report = getCashflowReport(db, {
      actorWorkerId: SUP,
      fromDate: todayISO(),
      toDate: todayISO(),
      pin: '9999',
      deviceId: D,
    });

    expect(report.inflows.totalPesewas).toBe(2600);
    expect(report.outflows.totalPesewas).toBe(4000);
    expect(report.netCashflowPesewas).toBe(-1400);
    expect(report.transfers.totalPesewas).toBe(500);
    expect(report.nonCash.totalPesewas).toBe(6000);
    expect(report.nonCash.lines.map((l) => l.label)).toContain('Credit sales added to receivables');
    expect(report.nonCash.lines.map((l) => l.label)).toContain('Supplier invoices added to payables/inventory');
  });
});
