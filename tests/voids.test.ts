// Void-sale: supervisor PIN verified, stock + customer balance reversed,
// audit trail correct, double-void rejected.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { listRecentSales, voidSale } from '../src/main/services/voids';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

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
  // Stock: 24 of each
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

function pickProduct(sku: string) {
  return db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: string };
}

async function makeSale() {
  const star = pickProduct('STAR-330');
  return completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: star.id, quantity: 3, unitPricePesewas: 800 }],
    paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'TEST',
  });
}

describe('voidSale', () => {
  it('reverses stock with SALE_VOID_REVERSAL movements', async () => {
    const star = pickProduct('STAR-330');
    expect(unitsOnHand(db, star.id, L)).toBe(24);
    const sale = await makeSale();
    expect(unitsOnHand(db, star.id, L)).toBe(21);

    const r = voidSale(db, {
      saleId: sale.saleId, reason: 'wrong product',
      supervisorWorkerId: SUP, supervisorPin: '9999',
      workerId: W, deviceId: D,
    });
    expect(r.reversalMovementCount).toBe(1);
    expect(unitsOnHand(db, star.id, L)).toBe(24);

    // Confirm the new movement is the reversal type
    const sm = db.prepare(
      `SELECT reason_code, quantity FROM stock_movements
         WHERE sale_id = ? AND reason_code = 'SALE_VOID_REVERSAL'`,
    ).get(sale.saleId) as { reason_code: string; quantity: number };
    expect(sm.reason_code).toBe('SALE_VOID_REVERSAL');
    expect(sm.quantity).toBe(3); // positive
  });

  it('marks the original sale voided with reason + actor', async () => {
    const sale = await makeSale();
    voidSale(db, {
      saleId: sale.saleId, reason: 'duplicate scan',
      supervisorWorkerId: SUP, supervisorPin: '9999',
      workerId: W, deviceId: D,
    });
    const row = db.prepare('SELECT voided, voided_by, void_reason FROM sales WHERE id = ?').get(sale.saleId) as
      { voided: number; voided_by: string; void_reason: string };
    expect(row.voided).toBe(1);
    expect(row.voided_by).toBe(W);
    expect(row.void_reason).toBe('duplicate scan');
  });

  it('reverses customer balance for credit voids', async () => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id)
         VALUES ('c1','Yaw','+233244999000','WALK_IN_REGULAR',100000,?,?,?)`,
    ).run(W, W, D);
    const star = pickProduct('STAR-330');
    const sale = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 2, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: 'c1', deviceId: D, shopName: 'T',
    });
    expect((db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get('c1') as { current_balance_pesewas: number }).current_balance_pesewas).toBe(1600);
    const r = voidSale(db, {
      saleId: sale.saleId, reason: 'returned',
      supervisorWorkerId: SUP, supervisorPin: '9999',
      workerId: W, deviceId: D,
    });
    expect(r.customerBalanceDelta).toBe(-1600);
    expect((db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get('c1') as { current_balance_pesewas: number }).current_balance_pesewas).toBe(0);
  });

  it('refuses double-void', async () => {
    const sale = await makeSale();
    voidSale(db, { saleId: sale.saleId, reason: 'first', supervisorWorkerId: SUP, supervisorPin: '9999', workerId: W, deviceId: D });
    expect(() => voidSale(db, { saleId: sale.saleId, reason: 'second', supervisorWorkerId: SUP, supervisorPin: '9999', workerId: W, deviceId: D })).toThrow(/already voided/);
  });

  it('rejects wrong supervisor PIN', async () => {
    const sale = await makeSale();
    expect(() => voidSale(db, { saleId: sale.saleId, reason: 'oops', supervisorWorkerId: SUP, supervisorPin: '0000', workerId: W, deviceId: D })).toThrow(/PIN check failed|locked/);
  });

  it('rejects non-supervisor approval', async () => {
    const sale = await makeSale();
    expect(() => voidSale(db, { saleId: sale.saleId, reason: 'oops', supervisorWorkerId: W, supervisorPin: '1234', workerId: W, deviceId: D })).toThrow(/COUNTER cannot approve|need SUPERVISOR/);
  });

  it('requires a non-empty reason', async () => {
    const sale = await makeSale();
    expect(() => voidSale(db, { saleId: sale.saleId, reason: '', supervisorWorkerId: SUP, supervisorPin: '9999', workerId: W, deviceId: D })).toThrow(/reason is required/);
    expect(() => voidSale(db, { saleId: sale.saleId, reason: '   ', supervisorWorkerId: SUP, supervisorPin: '9999', workerId: W, deviceId: D })).toThrow(/reason is required/);
  });

  it('writes SALE_VOIDED to audit_log', async () => {
    const sale = await makeSale();
    voidSale(db, { saleId: sale.saleId, reason: 'r', supervisorWorkerId: SUP, supervisorPin: '9999', workerId: W, deviceId: D });
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'SALE_VOIDED'`).get(sale.saleId);
    expect(a).toBeDefined();
  });

  it('listRecentSales surfaces voided=true after void', async () => {
    const sale = await makeSale();
    voidSale(db, { saleId: sale.saleId, reason: 'r', supervisorWorkerId: SUP, supervisorPin: '9999', workerId: W, deviceId: D });
    const recent = listRecentSales(db, 5);
    const found = recent.find((s) => s.id === sale.saleId);
    expect(found?.voided).toBe(true);
  });
});
