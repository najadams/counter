// Customer-returns atomicity: the stock restore + customer balance side
// effects must commit or roll back as one unit. Returns also touch
// cash_counts (for CASH refunds) and customer_payments (for CREDIT) —
// these tests pin those paths down.
//
// Two gaps surfaced while writing this and tracked separately:
//   - Task #34: recordCustomerReturn does NOT call logAudit (every other
//     state-changing service does). Tests for the audit row are .todo here.
//   - Task #35: no quantity cap against the original sale. Tests for the
//     cap behavior are .todo here.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { recordCustomerReturn } from '../src/main/services/customerReturns';
import { unitsOnHand } from '../src/main/services/stockMovements';
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
let creditSaleId: string;

beforeEach(async () => {
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
  ).run(customerId, 'Return Test Customer', '+233500001113', W, W, D);

  shiftId = openShift(db, {
    workerId: W, locationId: L, shiftType: 'COUNTER',
    openingCashPesewas: 5000, deviceId: D,
  }).shiftId;

  _setPrinter({ async print() { return { ok: true } as const; } });

  // Seed an open credit sale so the CREDIT-refund FIFO has something to bite.
  const cs = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: starId, quantity: 3, unitPricePesewas: 800 }], // 2400 on credit
    paymentMethod: 'CREDIT', customerId, deviceId: D, shopName: 'TEST',
  });
  creditSaleId = cs.saleId;
});

afterEach(() => {
  _resetPrinter();
  db.close();
});

describe('recordCustomerReturn — atomicity', () => {
  it('CREDIT return: stock goes up + customer balance comes down, both in one tx', async () => {
    const stockBefore = unitsOnHand(db, starId, L);
    const balBefore = (db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(customerId) as { current_balance_pesewas: number }).current_balance_pesewas;
    expect(balBefore).toBe(2400); // the credit sale

    const r = recordCustomerReturn(db, {
      customerId, originalSaleId: creditSaleId,
      locationId: L, workerId: W, shiftId,
      supervisorWorkerId: SUP, supervisorPin: '9999',
      refundMethod: 'CREDIT', reason: 'damaged on arrival',
      lines: [{ productId: starId, quantity: 1, unitPricePesewas: 800 }], // refund 800
      deviceId: D,
    });
    expect(r.totalRefundPesewas).toBe(800);

    const stockAfter = unitsOnHand(db, starId, L);
    expect(stockAfter).toBe(stockBefore + 1); // +1 unit restored

    // Customer balance: original credit 2400 - 800 refund = 1600
    const balAfter = (db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(customerId) as { current_balance_pesewas: number }).current_balance_pesewas;
    expect(balAfter).toBe(1600);

    // FIFO allocation should point at the credit sale.
    expect(r.creditAllocations).toEqual([{ saleId: creditSaleId, amountPesewas: 800 }]);
  });

  it('CASH return: stock goes up + a negative cash-drop row is written', () => {
    const stockBefore = unitsOnHand(db, starId, L);

    const r = recordCustomerReturn(db, {
      customerId, locationId: L, workerId: W, shiftId,
      supervisorWorkerId: SUP, supervisorPin: '9999',
      refundMethod: 'CASH', reason: 'changed her mind',
      lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }],
      deviceId: D,
    });

    expect(unitsOnHand(db, starId, L)).toBe(stockBefore + 2);
    expect(r.negativeCashDropId).not.toBeNull();
    const drop = db.prepare(
      `SELECT count_type, counted_pesewas, notes FROM cash_counts WHERE id = ?`,
    ).get(r.negativeCashDropId!) as { count_type: string; counted_pesewas: number; notes: string };
    expect(drop.count_type).toBe('CASH_DROP');
    expect(drop.counted_pesewas).toBe(1600);
    expect(drop.notes).toContain('customer-refund');
  });

  it('rolls back ALL writes when a mid-transaction failure occurs', () => {
    const stockBefore = unitsOnHand(db, starId, L);
    const balBefore = (db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(customerId) as { current_balance_pesewas: number }).current_balance_pesewas;
    const returnsBefore = (db.prepare('SELECT COUNT(*) AS n FROM customer_returns').get() as { n: number }).n;
    const stockMovementsBefore = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;

    // CASH refund without shiftId trips the in-transaction throw at line 274.
    expect(() => recordCustomerReturn(db, {
      customerId, locationId: L, workerId: W,
      shiftId: null, // <- causes the throw
      supervisorWorkerId: SUP, supervisorPin: '9999',
      refundMethod: 'CASH', reason: 'cancelled order',
      lines: [{ productId: starId, quantity: 1, unitPricePesewas: 800 }],
      deviceId: D,
    })).toThrow(/CASH refund requires.*shift/i);

    // Nothing should have stuck.
    expect(unitsOnHand(db, starId, L)).toBe(stockBefore);
    const balAfter = (db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get(customerId) as { current_balance_pesewas: number }).current_balance_pesewas;
    expect(balAfter).toBe(balBefore);
    const returnsAfter = (db.prepare('SELECT COUNT(*) AS n FROM customer_returns').get() as { n: number }).n;
    expect(returnsAfter).toBe(returnsBefore);
    const stockMovementsAfter = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;
    expect(stockMovementsAfter).toBe(stockMovementsBefore);
  });

  it('stock movement quantity is in CANONICAL units when a non-canonical unit is supplied', () => {
    // Add a CRATE unit (x24) to STAR so we can return in crates.
    const crateUnitId = `pu-${uuidv4()}`;
    db.prepare(
      `INSERT INTO product_units
         (id, product_id, unit_name, conversion_factor, price_pesewas,
          is_sale_unit, is_purchase_unit, active, display_order,
          created_by, updated_by, device_id)
       VALUES (?, ?, 'CRATE', 24, 19000, 1, 1, 1, 0, ?, ?, ?)`,
    ).run(crateUnitId, starId, W, W, D);

    const stockBefore = unitsOnHand(db, starId, L);

    recordCustomerReturn(db, {
      customerId, locationId: L, workerId: W, shiftId,
      supervisorWorkerId: SUP, supervisorPin: '9999',
      refundMethod: 'CASH', reason: 'whole crate damaged',
      lines: [{ productId: starId, unitId: crateUnitId, quantity: 1, unitPricePesewas: 19000 }],
      deviceId: D,
    });

    // 1 crate = 24 canonical units.
    expect(unitsOnHand(db, starId, L)).toBe(stockBefore + 24);
    const sm = db.prepare(
      `SELECT quantity FROM stock_movements
         WHERE reason_code = 'RETURN_FROM_CUSTOMER' AND product_id = ?
         ORDER BY rowid DESC LIMIT 1`,
    ).get(starId) as { quantity: number };
    expect(sm.quantity).toBe(24);
  });

  it.todo(
    'writes an audit_log entry per return — see task #34 (currently no audit_log row is created)',
  );

  it.todo(
    'rejects quantity exceeding the original sale — see task #35 (no cap today)',
  );

  it.todo(
    'rejects a second return that pushes cumulative quantity beyond the original — see task #35',
  );
});
