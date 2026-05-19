// Period-close enforcement: every state-changing service must refuse
// writes after the day is sealed. This locks in behavior across 10
// guarded paths (5 added in audit Phase 1 + 5 existing) so a future
// refactor can't silently remove the guard.
//
// Setup creates a DB, seeds fixtures, opens a shift, and seals TODAY
// at the default location. Each test calls one guarded service with
// otherwise-valid input and asserts the call throws.

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
import { recordConsumption } from '../src/main/services/consumption';
import {
  startStocktake, completeStocktake, recordStocktakeCount,
} from '../src/main/services/stocktake';
import { recordCustomerReturn } from '../src/main/services/customerReturns';
import {
  recordCustomerTakesFull, recordCustomerReturnsEmpty,
  recordDepotReceivesFull, recordDepotReturnsEmpty,
} from '../src/main/services/empties';
import { reportBreakage } from '../src/main/services/breakage';
import { voidSale } from '../src/main/services/voids';
import { recordExpense } from '../src/main/services/expenses';
import { recordCustomerPayment } from '../src/main/services/customerCredit';
import { receiveStock } from '../src/main/services/stockReceipts';
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
let returnableId: string;
let customerId: string;
let saleIdToVoid: string;
let supplierId: string;
let draftStocktakeId: string;
let today: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });

  // Seed stock so completeSale / receiveStock paths can pass their other
  // validations and we get to the sealed-day check.
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 48, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 48 * p.cost_price_pesewas, SUP, W, W, D);
  }

  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  returnableId = starId; // STAR-330 is returnable per seed
  supplierId = (db.prepare("SELECT id FROM suppliers LIMIT 1").get() as { id: string }).id;

  // A customer who already owes empties (for customer-returns-empty path).
  customerId = `cu-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type,
      current_balance_pesewas, credit_limit_pesewas, blocked,
      empties_owed_count, created_by, updated_by, device_id)
     VALUES (?, ?, ?, 'WALK_IN_REGULAR', 0, 0, 0, 5, ?, ?, ?)`,
  ).run(customerId, 'Periodic Customer', '+233500001111', W, W, D);

  shiftId = openShift(db, {
    workerId: W, locationId: L, shiftType: 'COUNTER',
    openingCashPesewas: 5000, deviceId: D,
  }).shiftId;

  // Mock the printer so completeSale doesn't try to talk to a thermal device.
  _setPrinter({ async print() { return { ok: true } as const; } });

  // Make a sale BEFORE sealing so voidSale has something to operate on.
  const sale = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: starId, quantity: 2, unitPricePesewas: 800 }],
    paymentMethod: 'CASH', cashGivenPesewas: 1600, deviceId: D, shopName: 'TEST',
  });
  saleIdToVoid = sale.saleId;

  // Open a DRAFT stocktake and record one line so completeStocktake has
  // something to commit on (will hit the period guard before committing).
  draftStocktakeId = startStocktake(db, {
    locationId: L, workerId: W, deviceId: D,
  }).eventId;
  recordStocktakeCount(db, draftStocktakeId, starId, 46, W, D, null);

  today = new Date().toISOString().slice(0, 10);

  // Seal today AFTER all the pre-state is set up. From this point every
  // mutation on today should be refused.
  db.prepare(
    `INSERT INTO period_closes (id, location_id, business_date, sealed_by, device_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`pc-${uuidv4()}`, L, today, SUP, D);
});

afterEach(() => {
  _resetPrinter();
  db.close();
});

describe('period-close guard: services added in Phase 1', () => {
  it('completeSale refuses after seal', async () => {
    await expect(
      completeSale(db, {
        shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
        lines: [{ productId: starId, quantity: 1, unitPricePesewas: 800 }],
        paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
      }),
    ).rejects.toThrow(/sealed|completing a sale/i);
  });

  it('recordConsumption refuses after seal', () => {
    expect(() =>
      recordConsumption(db, {
        shiftId, workerId: W, locationId: L, productId: starId,
        quantity: 1, deviceId: D,
      }),
    ).toThrow(/sealed|worker consumption/i);
  });

  it('startStocktake refuses after seal', () => {
    // Cancel the existing draft first so this test isn't blocked by the
    // "DRAFT already exists" guard before reaching the seal check.
    db.prepare(
      `UPDATE stocktake_events SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), draftStocktakeId);
    expect(() =>
      startStocktake(db, { locationId: L, workerId: W, deviceId: D }),
    ).toThrow(/sealed|starting a stocktake/i);
  });

  it('completeStocktake refuses after seal', () => {
    expect(() =>
      completeStocktake(db, {
        eventId: draftStocktakeId, workerId: W,
        supervisorWorkerId: SUP, supervisorPin: '9999',
        deviceId: D,
      }),
    ).toThrow(/sealed|completing a stocktake/i);
  });

  it('recordCustomerReturn refuses after seal', () => {
    expect(() =>
      recordCustomerReturn(db, {
        customerId, locationId: L, workerId: W, shiftId,
        supervisorWorkerId: SUP, supervisorPin: '9999',
        refundMethod: 'CREDIT', reason: 'damaged on arrival',
        lines: [{ productId: starId, quantity: 1, unitPricePesewas: 800 }],
        deviceId: D,
      }),
    ).toThrow(/sealed|customer return/i);
  });

  it('recordCustomerTakesFull refuses after seal', () => {
    expect(() =>
      recordCustomerTakesFull(db, {
        customerId, productId: returnableId, quantity: 1,
        workerId: W, shiftId, deviceId: D,
      }),
    ).toThrow(/sealed|takes-full/i);
  });

  it('recordCustomerReturnsEmpty refuses after seal', () => {
    expect(() =>
      recordCustomerReturnsEmpty(db, {
        customerId, productId: returnableId, quantity: 1,
        workerId: W, locationId: L, shiftId, deviceId: D,
      }),
    ).toThrow(/sealed|returns-empty/i);
  });

  it('recordDepotReceivesFull refuses after seal', () => {
    expect(() =>
      recordDepotReceivesFull(db, {
        supplierId, productId: returnableId, quantity: 12,
        workerId: W, deviceId: D,
      }),
    ).toThrow(/sealed|receives-full/i);
  });

  it('recordDepotReturnsEmpty refuses after seal', () => {
    expect(() =>
      recordDepotReturnsEmpty(db, {
        supplierId, productId: returnableId, quantity: 12,
        workerId: W, deviceId: D,
      }),
    ).toThrow(/sealed|returns-empty/i);
  });
});

describe('period-close guard: pre-existing services (regression coverage)', () => {
  it('reportBreakage refuses after seal', () => {
    expect(() =>
      reportBreakage(db, {
        shiftId, workerId: W, locationId: L,
        productId: starId, quantity: 1, cause: 'DROPPED',
        photoBytes: Buffer.from('x'), photoExtension: 'jpg',
        userDataDir: '/tmp', deviceId: D,
      }),
    ).toThrow(/sealed|breakage/i);
  });

  it('voidSale refuses after seal', () => {
    // voidSale guards by the SALE's business date, not today. Update the
    // existing sale's created_at to today so the guard applies.
    db.prepare(`UPDATE sales SET created_at = ? WHERE id = ?`).run(`${today}T10:00:00.000Z`, saleIdToVoid);
    expect(() =>
      voidSale(db, {
        saleId: saleIdToVoid, reason: 'mistake',
        supervisorWorkerId: SUP, supervisorPin: '9999',
        workerId: W, deviceId: D,
      }),
    ).toThrow(/sealed|voiding/i);
  });

  it('recordExpense refuses after seal', () => {
    expect(() =>
      recordExpense(db, {
        shiftId, locationId: L, workerId: W,
        amountPesewas: 1000, category: 'TRANSPORT',
        deviceId: D,
      }),
    ).toThrow(/sealed|expense/i);
  });

  it('recordCustomerPayment refuses after seal', () => {
    expect(() =>
      recordCustomerPayment(db, {
        customerId, amountPesewas: 1000, method: 'CASH',
        workerId: W, shiftId, deviceId: D,
      }),
    ).toThrow(/sealed|customer payment/i);
  });

  it('receiveStock refuses after seal', () => {
    expect(() =>
      receiveStock(db, {
        supplierId, locationId: L, workerId: W,
        supervisorApprovalId: SUP,
        lines: [{ productId: starId, quantity: 12, unitCostPesewas: 600 }],
        deviceId: D,
      }),
    ).toThrow(/sealed|stock receipt|receiving stock/i);
  });
});
