import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import {
  getCustomerDebtCollection,
  listDebtCollectionQueue,
  recordDebtFollowUp,
  setSaleDebtStatus,
  updatePaymentPromiseStatus,
} from '../src/main/services/debtCollection';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';
const CUST = 'cust-debt';

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
    ).run(`sm-debt-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 24 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
       credit_terms_days, created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(CUST, 'Debt Customer', '+233244100000', 'WALK_IN_REGULAR', 100000, 7, W, W, D);
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => { _resetPrinter(); db.close(); });

function star() {
  return db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string };
}

async function makeCreditSale(): Promise<string> {
  const p = star();
  const r = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
    paymentMethod: 'CREDIT', customerId: CUST, deviceId: D, shopName: 'TEST',
  });
  return r.saleId;
}

describe('debt collection', () => {
  it('surfaces open debt with due date, status, and queue ordering', async () => {
    const saleId = await makeCreditSale();
    db.prepare(`UPDATE sales SET credit_due_date = '2026-01-01' WHERE id = ?`).run(saleId);
    const detail = getCustomerDebtCollection(db, CUST, new Date('2026-01-10T12:00:00Z'));
    expect(detail.totalOutstandingPesewas).toBe(800);
    expect(detail.oldestOverdueDays).toBe(9);
    expect(detail.openSales[0]?.saleId).toBe(saleId);
    expect(detail.openSales[0]?.debtStatus).toBe('OVERDUE');
    expect(detail.openSales[0]?.dueDate).toBe('2026-01-01');

    const queue = listDebtCollectionQueue(db, {}, new Date('2026-01-10T12:00:00Z'));
    expect(queue[0]?.saleId).toBe(saleId);
  });

  it('records a promised-to-pay follow-up and links an open promise', async () => {
    const saleId = await makeCreditSale();
    const r = recordDebtFollowUp(db, {
      customerId: CUST,
      saleId,
      contactMethod: 'WHATSAPP',
      outcome: 'PROMISED_TO_PAY',
      notes: 'Will pay after delivery round',
      nextFollowUpAt: '2026-01-12',
      promisedAmountPesewas: 500,
      promiseDueDate: '2026-01-11',
      workerId: W,
      deviceId: D,
    });
    expect(r.followupId).toMatch(/^dfu-/);
    expect(r.promiseId).toMatch(/^prom-/);
    const detail = getCustomerDebtCollection(db, CUST, new Date('2026-01-10T12:00:00Z'));
    expect(detail.openSales[0]?.debtStatus).toBe('PROMISED');
    expect(detail.openSales[0]?.openPromise?.promisedAmountPesewas).toBe(500);
    expect(detail.recentFollowUps[0]?.outcome).toBe('PROMISED_TO_PAY');

    updatePaymentPromiseStatus(db, { promiseId: r.promiseId!, status: 'BROKEN', workerId: W, deviceId: D });
    expect(getCustomerDebtCollection(db, CUST).promises[0]?.status).toBe('BROKEN');
  });

  it('requires a senior worker for doubtful/dead debt statuses', async () => {
    const saleId = await makeCreditSale();
    expect(() => setSaleDebtStatus(db, { saleId, status: 'DOUBTFUL', workerId: W, deviceId: D }))
      .toThrow(/requires SUPERVISOR/);
    setSaleDebtStatus(db, { saleId, status: 'DOUBTFUL', workerId: SUP, deviceId: D });
    const detail = getCustomerDebtCollection(db, CUST);
    expect(detail.openSales[0]?.debtStatus).toBe('DOUBTFUL');
  });
});
