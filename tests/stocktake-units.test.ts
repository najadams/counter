import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { addUnit } from '../src/main/services/productUnits';
import { recordStocktakeCount, startStocktake } from '../src/main/services/stocktake';
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
  // Stock 24 of each (canonical) for stocktake to work
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 24, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 24 * p.cost_price_pesewas, SUP, W, W, D);
  }
});
afterEach(() => { db.close(); });

describe('recordStocktakeCount — unit-aware', () => {
  it('count in BOTTLE (canonical) — direct match', () => {
    const ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const r = recordStocktakeCount(db, ev.eventId, starId, 23, W, D);
    expect(r.canonicalCount).toBe(23);
    expect(r.variance).toBe(-1); // 24 expected, 23 counted
  });

  it('count in CRATE (factor 24) — 1 crate = 24 canonical', () => {
    const crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    }).unitId;
    const ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const r = recordStocktakeCount(db, ev.eventId, starId, 1, W, D, crateId);
    expect(r.canonicalCount).toBe(24);
    expect(r.variance).toBe(0); // exact match
  });

  it('count in CRATE qty=2 → 48 canonical, +24 variance from 24 expected', () => {
    const crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    }).unitId;
    const ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    const r = recordStocktakeCount(db, ev.eventId, starId, 2, W, D, crateId);
    expect(r.canonicalCount).toBe(48);
    expect(r.variance).toBe(24);
  });

  it('rejects unit that does not belong to product', () => {
    const club = (db.prepare("SELECT id FROM products WHERE sku = 'CLUB-330'").get() as { id: string }).id;
    const crateId = addUnit(db, {
      productId: club, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    }).unitId;
    const ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    expect(() => recordStocktakeCount(db, ev.eventId, starId, 1, W, D, crateId)).toThrow(/does not belong/);
  });

  it('counted_qty stored is canonical, not unit qty', () => {
    const crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    }).unitId;
    const ev = startStocktake(db, { locationId: L, workerId: W, deviceId: D });
    recordStocktakeCount(db, ev.eventId, starId, 1, W, D, crateId);
    const line = db.prepare('SELECT counted_qty FROM stocktake_lines WHERE stocktake_event_id = ? AND product_id = ?').get(ev.eventId, starId) as { counted_qty: number };
    expect(line.counted_qty).toBe(24); // stored as canonical
  });
});
