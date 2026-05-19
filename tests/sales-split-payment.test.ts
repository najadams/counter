// Split-payment integration tests for completeSale + voidSale.
//
// Locks in the behavior of the multi-tender payments[] path. The recent
// fix in f123494 hoisted submitWithSplit out of the payment modal — these
// tests guard the atomicity + cart-state correctness underneath that
// renderer change.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { voidSale } from '../src/main/services/voids';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { DEFAULT_LOCATION_ID } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = DEFAULT_LOCATION_ID;
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let starId: string;
let customerId: string;

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

  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;

  customerId = `cu-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type,
      current_balance_pesewas, credit_limit_pesewas, blocked,
      empties_owed_count, created_by, updated_by, device_id)
     VALUES (?, ?, ?, 'WALK_IN_REGULAR', 0, 100000, 0, 0, ?, ?, ?)`,
  ).run(customerId, 'Split Test Customer', '+233500001112', W, W, D);

  shiftId = openShift(db, {
    workerId: W, locationId: L, shiftType: 'COUNTER',
    openingCashPesewas: 5000, deviceId: D,
  }).shiftId;

  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => {
  _resetPrinter();
  db.close();
});

describe('completeSale — split payments', () => {
  it('CASH + MOMO blended tender writes one sale row + two sale_payments rows', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }], // total 1600
      payments: [
        { method: 'CASH', amountPesewas: 1000, cashGivenPesewas: 1000 },
        { method: 'MOMO_MTN', amountPesewas: 600, reference: 'TXN-123' },
      ],
      deviceId: D, shopName: 'TEST',
    });
    expect(r.totalPesewas).toBe(1600);
    const sales = db.prepare('SELECT id, total_pesewas, is_credit FROM sales').all();
    expect(sales).toHaveLength(1);
    const payments = db.prepare(
      'SELECT payment_method, amount_pesewas FROM sale_payments WHERE sale_id = ? ORDER BY payment_method',
    ).all(r.saleId);
    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual({ payment_method: 'CASH', amount_pesewas: 1000 });
    expect(payments).toContainEqual({ payment_method: 'MOMO_MTN', amount_pesewas: 600 });
  });

  it('rejects when tender sum != sale total', async () => {
    await expect(
      completeSale(db, {
        shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
        lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }], // 1600
        payments: [
          { method: 'CASH', amountPesewas: 1000, cashGivenPesewas: 1000 },
          { method: 'MOMO_MTN', amountPesewas: 500, reference: 'TXN' }, // sums to 1500
        ],
        deviceId: D, shopName: 'TEST',
      }),
    ).rejects.toThrow(/tenders total .* ≠ sale total/);
  });

  it('rejects MOMO without reference even in a split', async () => {
    await expect(
      completeSale(db, {
        shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
        lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }],
        payments: [
          { method: 'CASH', amountPesewas: 1000, cashGivenPesewas: 1000 },
          { method: 'MOMO_MTN', amountPesewas: 600, reference: null },
        ],
        deviceId: D, shopName: 'TEST',
      }),
    ).rejects.toThrow(/MoMo.*reference/i);
  });

  it('printer offline + split → sale still succeeds, reprint queued', async () => {
    _setPrinter({ async print() { return { ok: false, reason: 'OFFLINE', message: 'no device' } as const; } });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }],
      payments: [
        { method: 'CASH', amountPesewas: 1000, cashGivenPesewas: 1000 },
        { method: 'MOMO_MTN', amountPesewas: 600, reference: 'TXN-OFFLINE' },
      ],
      deviceId: D, shopName: 'TEST',
    });
    expect(r.printerFailed).toBe(true);
    const reprintRows = db.prepare('SELECT sale_id, reason FROM pending_receipt_reprints').all() as Array<{ sale_id: string; reason: string }>;
    expect(reprintRows.length).toBeGreaterThanOrEqual(1);
    expect(reprintRows[0]!.sale_id).toBe(r.saleId);
    // Both payments still wrote despite printer fail.
    const payCount = db.prepare('SELECT COUNT(*) AS n FROM sale_payments WHERE sale_id = ?').get(r.saleId) as { n: number };
    expect(payCount.n).toBe(2);
  });

  it('void of a split sale reverses ALL payment lines (sale row marked voided)', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }],
      payments: [
        { method: 'CASH', amountPesewas: 1000, cashGivenPesewas: 1000 },
        { method: 'MOMO_MTN', amountPesewas: 600, reference: 'TXN-V' },
      ],
      deviceId: D, shopName: 'TEST',
    });
    voidSale(db, {
      saleId: r.saleId, reason: 'wrong product',
      supervisorWorkerId: SUP, supervisorPin: '9999',
      workerId: W, deviceId: D,
    });
    const sale = db.prepare('SELECT voided FROM sales WHERE id = ?').get(r.saleId) as { voided: number };
    expect(sale.voided).toBe(1);
    // sale_payments rows survive intact — the sale just gets the voided flag.
    // (The system uses the voided flag to filter, rather than deleting payment history.)
    const payCount = db.prepare('SELECT COUNT(*) AS n FROM sale_payments WHERE sale_id = ?').get(r.saleId) as { n: number };
    expect(payCount.n).toBe(2);
    // Stock reversal — a SALE_VOID_REVERSAL movement of +2 was emitted.
    const reversal = db.prepare(
      `SELECT quantity FROM stock_movements WHERE sale_id = ? AND reason_code = 'SALE_VOID_REVERSAL'`,
    ).get(r.saleId) as { quantity: number };
    expect(reversal.quantity).toBe(2);
  });

  it.todo(
    'CASH + CREDIT split should move only the credit portion to customer balance — see task #33 (current behavior moves the FULL sale total, which is symmetric on void but wrong between sale and void)',
  );
});
