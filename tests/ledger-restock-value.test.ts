// Voids and customer returns must put back exactly the cost a sale removed.
//
// With ledger posting on, a sale takes the exact moving-average slice out of
// the valuation pool (10000 for a crate of a 416.67-per-bottle average), but
// its stock movement kept quantity x rounded unit cost (24 x 417 = 10008).
// Voids and returns restored from the movement, so every crate that came back
// inflated stock value by 8 pesewas and pulled the valuation pool away from the
// ledger's INVENTORY account.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { addUnit } from '../src/main/services/productUnits';
import { receiveStock } from '../src/main/services/stockReceipts';
import { recordCustomerReturn } from '../src/main/services/customerReturns';
import { voidSale } from '../src/main/services/voids';
import { setLedgerShadowMode } from '../src/main/services/ledger';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const W = 'dev-counter-1';
const OWNER = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';
const PIN = '9999';
const CUSTOMER = 'cu-restock-value';
const CRATE_COST = 10_000;
const CRATE_PRICE = 18_000;
const POOL_BEFORE_SALE = { quantity: 240, value: 100_000 };

let db: ReturnType<typeof Database>;
let shiftId: string;
let starId: string;
let crateId: string;

function pool(): { quantity: number; value: number } {
  return db.prepare(
    `SELECT balance_quantity AS quantity, balance_value_pesewas AS value
       FROM inventory_valuation_movements
      WHERE product_id = ? AND location_id = ?
      ORDER BY occurred_at DESC, created_at DESC, rowid DESC LIMIT 1`,
  ).get(starId, L) as { quantity: number; value: number };
}

/** The ledger's INVENTORY balance. Only STAR-330 carries stock here. */
function inventoryAccount(): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(jl.debit_pesewas - jl.credit_pesewas), 0) AS balance
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
      WHERE je.location_id = ? AND je.status = 'POSTED' AND la.code = 'INVENTORY'`,
  ).get(L) as { balance: number }).balance;
}

function saleOutflowValue(saleId: string): number {
  return (db.prepare(
    'SELECT total_value_pesewas AS value FROM stock_movements WHERE sale_id = ? AND quantity < 0',
  ).get(saleId) as { value: number }).value;
}

/** What versions before this fix left on the movement: quantity x rounded unit cost. */
function rewindToRoundedOutflow(saleId: string): void {
  db.prepare(
    'UPDATE stock_movements SET total_value_pesewas = quantity * unit_cost_pesewas WHERE sale_id = ? AND quantity < 0',
  ).run(saleId);
  expect(saleOutflowValue(saleId)).toBe(-24 * 417);
}

function sellCrate() {
  return completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: CRATE_PRICE }],
    paymentMethod: 'CASH', cashGivenPesewas: CRATE_PRICE, customerId: CUSTOMER,
    deviceId: D, shopName: 'T',
  });
}

function returnCrate(saleId: string) {
  return recordCustomerReturn(db, {
    customerId: CUSTOMER, originalSaleId: saleId, locationId: L, workerId: W, shiftId,
    supervisorWorkerId: OWNER, supervisorPin: PIN, refundMethod: 'CASH', reason: 'damaged',
    lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: CRATE_PRICE }],
    deviceId: D,
  });
}

function voidCrate(saleId: string) {
  return voidSale(db, {
    saleId, reason: 'rung twice', supervisorWorkerId: OWNER, supervisorPin: PIN,
    workerId: W, deviceId: D,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(OWNER);
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type,
       current_balance_pesewas, credit_limit_pesewas, blocked,
       empties_owed_count, created_by, updated_by, device_id)
     VALUES (?, 'Restock Customer', '+233500001177', 'WALK_IN_REGULAR', 0, 100000, 0, 0, ?, ?, ?)`,
  ).run(CUSTOMER, W, W, D);
  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  shiftId = openShift(db, {
    workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 50_000, deviceId: D,
  }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });

  setLedgerShadowMode(db, { locationId: L, enabled: true, actorWorkerId: OWNER, pin: PIN, deviceId: D });
  crateId = addUnit(db, {
    productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: CRATE_PRICE,
    isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: OWNER, deviceId: D,
  }).unitId;
  const supplierId = (db.prepare('SELECT id FROM suppliers LIMIT 1').get() as { id: string }).id;
  // 10 crates at GHS 100: a 416.67-pesewa average, stored as 417 per bottle.
  receiveStock(db, {
    supplierId, locationId: L, workerId: W, supervisorApprovalId: OWNER,
    lines: [{ productId: starId, unitId: crateId, quantity: 10, unitCostPesewas: CRATE_COST }],
    allowLargeCostSwing: true, deviceId: D,
  });
  expect(pool()).toEqual(POOL_BEFORE_SALE);
  expect(inventoryAccount()).toBe(POOL_BEFORE_SALE.value);
});

afterEach(() => { _resetPrinter(); db.close(); });

describe('restocking a ledger-mode sale', () => {
  it("records the exact cost a sale removed on the sale's stock movement", async () => {
    const sale = await sellCrate();
    expect(saleOutflowValue(sale.saleId)).toBe(-CRATE_COST);
    expect(pool()).toEqual({ quantity: 216, value: 90_000 });
    expect(inventoryAccount()).toBe(90_000);
  });

  it('a full customer return puts back exactly what the sale took out', async () => {
    const sale = await sellCrate();
    const ret = returnCrate(sale.saleId);

    const restocked = db.prepare(
      `SELECT sm.total_value_pesewas AS value
         FROM customer_return_lines crl JOIN stock_movements sm ON sm.id = crl.stock_movement_id
        WHERE crl.return_id = ?`,
    ).get(ret.returnId) as { value: number };
    expect(restocked.value).toBe(CRATE_COST);
    expect(pool()).toEqual(POOL_BEFORE_SALE);
    expect(inventoryAccount()).toBe(POOL_BEFORE_SALE.value);
  });

  it('voiding a sale puts back exactly what the sale took out', async () => {
    const sale = await sellCrate();
    voidCrate(sale.saleId);

    expect(pool()).toEqual(POOL_BEFORE_SALE);
    expect(inventoryAccount()).toBe(POOL_BEFORE_SALE.value);
  });

  it('sales rung before this fix still restore their exact cost', async () => {
    const returned = await sellCrate();
    const voided = await sellCrate();
    rewindToRoundedOutflow(returned.saleId);
    rewindToRoundedOutflow(voided.saleId);

    returnCrate(returned.saleId);
    voidCrate(voided.saleId);

    expect(pool()).toEqual(POOL_BEFORE_SALE);
    expect(inventoryAccount()).toBe(POOL_BEFORE_SALE.value);
  });
});

describe('valuation balance with movements in the same millisecond', () => {
  it('builds on the most recently written balance, not whichever id sorts last', async () => {
    const sale = await sellCrate();
    // Force the tie seen in the wild: the receipt and the sale share both
    // timestamps, and the older receipt row's id sorts after the sale row's.
    const rows = db.prepare(
      `SELECT ivm.id, sm.reason_code AS reason FROM inventory_valuation_movements ivm
         JOIN stock_movements sm ON sm.id = ivm.stock_movement_id
        WHERE ivm.product_id = ? ORDER BY ivm.rowid`,
    ).all(starId) as Array<{ id: string; reason: string }>;
    expect(rows.map((row) => row.reason)).toEqual(['RECEIVED_FROM_SUPPLIER', 'SALE_WALK_IN']);
    const tied = '2026-01-01T00:00:00.000Z';
    const rename = db.prepare(
      'UPDATE inventory_valuation_movements SET id = ?, occurred_at = ?, created_at = ? WHERE id = ?',
    );
    rename.run('ivm-zzzz-receipt', tied, tied, rows[0]!.id);
    rename.run('ivm-0000-sale', tied, tied, rows[1]!.id);

    voidCrate(sale.saleId);

    expect(pool()).toEqual(POOL_BEFORE_SALE);
  });
});

it('documents the remaining rounding drift when a crate is returned in three parts', async () => {
  const sale = await sellCrate();
  for (let i = 0; i < 3; i++) {
    recordCustomerReturn(db, { customerId: CUSTOMER, originalSaleId: sale.saleId, locationId: L,
      workerId: W, shiftId, supervisorWorkerId: OWNER, supervisorPin: PIN, refundMethod: 'CASH',
      reason: 'partial return audit', lines: [{ productId: starId, quantity: 8, unitPricePesewas: 750 }], deviceId: D });
  }
  // Known limitation: 3 × round(10000 × 8 / 24) = 9999, not 10000.
  // Counts are exact, but value is one pesewa short. Keep visible in the audit.
  expect(pool()).toEqual({ quantity: 240, value: 99999 });
});
