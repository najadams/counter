import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { addUnit } from '../src/main/services/productUnits';
import { receiveStock } from '../src/main/services/stockReceipts';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');
const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let owner: string;
let starId: string;
let supplierId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  owner = 'dev-owner-1';
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, ?, ?, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(owner, 'Dev Owner', '+233555000003', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS), 500000, 8);
  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  supplierId = (db.prepare("SELECT id FROM suppliers LIMIT 1").get() as { id: string }).id;
});
afterEach(() => { db.close(); });

describe('receiveStock — unit-aware', () => {
  it('receive 1 crate → +24 canonical units', () => {
    const crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: owner, deviceId: D,
    }).unitId;
    expect(unitsOnHand(db, starId, L)).toBe(0);
    const r = receiveStock(db, {
      supplierId, locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitCostPesewas: 14400 }],
      deviceId: D,
    });
    void r;
    expect(unitsOnHand(db, starId, L)).toBe(24);
  });

  it('updates products.cost_price_pesewas to per-canonical cost', () => {
    const crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: owner, deviceId: D,
    }).unitId;
    receiveStock(db, {
      supplierId, locationId: L, workerId: W, supervisorApprovalId: SUP,
      // 1 crate at GHS 144 → per-bottle cost = 600 pesewas
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitCostPesewas: 14400 }],
      deviceId: D,
    });
    const cost = (db.prepare('SELECT cost_price_pesewas FROM products WHERE id = ?').get(starId) as { cost_price_pesewas: number }).cost_price_pesewas;
    expect(cost).toBe(600);
  });

  it('rejects sale-only unit on receipt', () => {
    const shotId = addUnit(db, {
      productId: starId, unitName: 'SHOT', conversionFactor: 1, pricePesewas: 200,
      isSaleUnit: true, isPurchaseUnit: false, actorWorkerId: owner, deviceId: D,
    }).unitId;
    expect(() => receiveStock(db, {
      supplierId, locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: starId, unitId: shotId, quantity: 24, unitCostPesewas: 100 }],
      deviceId: D,
    })).toThrow(/not flagged as a purchase unit/);
  });

  it('legacy receive without unitId still works (treats as canonical)', () => {
    receiveStock(db, {
      supplierId, locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: starId, quantity: 100, unitCostPesewas: 600 }],
      deviceId: D,
    });
    expect(unitsOnHand(db, starId, L)).toBe(100);
  });

  it('source_unit_id snapshotted on stock_movements row', () => {
    const crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: owner, deviceId: D,
    }).unitId;
    receiveStock(db, {
      supplierId, locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitCostPesewas: 14400 }],
      deviceId: D,
    });
    const sm = db.prepare(`SELECT source_unit_id FROM stock_movements WHERE product_id = ? AND reason_code = 'RECEIVED_FROM_SUPPLIER' AND id NOT LIKE 'sm-seed-%'`).get(starId) as { source_unit_id: string };
    expect(sm.source_unit_id).toBe(crateId);
  });
});
