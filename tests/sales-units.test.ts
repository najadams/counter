// Sale flow with multi-unit products. Verifies canonical-quantity stock
// movements, applied_unit_id snapshot, mixed-unit carts, default-unit
// fallback for legacy products.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { addUnit } from '../src/main/services/productUnits';
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
let owner: string;
let starId: string;

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
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 240 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  owner = 'dev-owner-1';
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, ?, ?, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(owner, 'Dev Owner', '+233555000003', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS), 500000, 8);
  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

describe('legacy / default-unit path', () => {
  it('sale without unitId uses default UNIT (factor 1) — same as before', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(2400);
    expect(unitsOnHand(db, starId, L)).toBe(240 - 3);
    const sl = db.prepare('SELECT applied_unit_id, quantity FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { applied_unit_id: string; quantity: number };
    expect(sl.applied_unit_id).toBeTruthy(); // points at the synthetic UNIT row
    expect(sl.quantity).toBe(3);
  });
});

describe('CRATE unit (24×)', () => {
  let crateId: string;
  beforeEach(() => {
    crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isPurchaseUnit: true, isSaleUnit: true,
      actorWorkerId: owner, deviceId: D,
    }).unitId;
  });

  it('sale of 1 crate emits -24 canonical stock movement', async () => {
    const before = unitsOnHand(db, starId, L);
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 18000, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(18000);
    expect(unitsOnHand(db, starId, L)).toBe(before - 24);
    const sm = db.prepare('SELECT quantity, source_unit_id FROM stock_movements WHERE sale_id = ?').get(r.saleId) as { quantity: number; source_unit_id: string };
    expect(sm.quantity).toBe(-24);
    expect(sm.source_unit_id).toBe(crateId);
  });

  it('sale_line records applied_unit_id + quantity in unit (1, not 24)', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 18000, deviceId: D, shopName: 'T',
    });
    const sl = db.prepare('SELECT applied_unit_id, quantity, unit_price_pesewas, line_total_pesewas FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { applied_unit_id: string; quantity: number; unit_price_pesewas: number; line_total_pesewas: number };
    expect(sl.applied_unit_id).toBe(crateId);
    expect(sl.quantity).toBe(1);
    expect(sl.unit_price_pesewas).toBe(18000);
    expect(sl.line_total_pesewas).toBe(18000);
  });

  it('sale of 5 crates → -120 canonical', async () => {
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: crateId, quantity: 5, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 90000, deviceId: D, shopName: 'T',
    });
    const sm = db.prepare('SELECT quantity FROM stock_movements WHERE sale_id = ?').get(r.saleId) as { quantity: number };
    expect(sm.quantity).toBe(-120);
    expect(r.totalPesewas).toBe(90000);
  });

  it('mixed cart: 1 crate + 6 bottles → two stock movements (-24 + -6)', async () => {
    const defUnit = (db.prepare(`SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'UNIT'`).get(starId) as { id: string }).id;
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [
        { productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 },
        { productId: starId, unitId: defUnit, quantity: 6, unitPricePesewas: 800 },
      ],
      paymentMethod: 'CASH', cashGivenPesewas: 22800, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(18000 + 6 * 800);
    const movements = db.prepare('SELECT quantity FROM stock_movements WHERE sale_id = ? ORDER BY quantity').all(r.saleId) as Array<{ quantity: number }>;
    expect(movements.map((m) => m.quantity)).toEqual([-24, -6]);
  });

  it('rejects unit that does not belong to product', async () => {
    const club = (db.prepare("SELECT id FROM products WHERE sku = 'CLUB-330'").get() as { id: string }).id;
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: club, unitId: crateId, quantity: 1, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 18000, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/does not belong/);
  });

  it('rejects purchase-only unit on sale', async () => {
    const palletId = addUnit(db, {
      productId: starId, unitName: 'PALLET', conversionFactor: 240, pricePesewas: 0,
      isSaleUnit: false, isPurchaseUnit: true,
      actorWorkerId: owner, deviceId: D,
    }).unitId;
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: palletId, quantity: 1, unitPricePesewas: 100000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 100000, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/not flagged as a sale unit/);
  });

  it('rejects inactive unit', async () => {
    db.prepare('UPDATE product_units SET active = 0 WHERE id = ?').run(crateId);
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 18000, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/inactive/);
  });

  it('SALE_COMPLETED audit unitsSummary is captured', async () => {
    const defUnit = (db.prepare(`SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'UNIT'`).get(starId) as { id: string }).id;
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [
        { productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 },
        { productId: starId, unitId: defUnit, quantity: 6, unitPricePesewas: 800 },
      ],
      paymentMethod: 'CASH', cashGivenPesewas: 22800, deviceId: D, shopName: 'T',
    });
    const audit = db.prepare(`SELECT after_value FROM audit_log WHERE entity_id = ? AND action = 'SALE_COMPLETED'`).get(r.saleId) as { after_value: string };
    const after = JSON.parse(audit.after_value);
    expect(after.unitsSummary).toEqual([
      { unitName: 'CRATE', quantityInUnit: 1, canonicalQuantity: 24 },
      { unitName: 'UNIT', quantityInUnit: 6, canonicalQuantity: 6 },
    ]);
  });
});
