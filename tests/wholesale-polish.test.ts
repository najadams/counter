// Session 10: tier-per-unit filter + customer preferred_channel round-trip.

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
import { addTier, bestTierFor } from '../src/main/services/pricingTiers';
import { createCustomer, updateCustomer } from '../src/main/services/customersAdmin';
import { searchCustomers } from '../src/main/services/customers';
import { getCustomerOverview } from '../src/main/services/customerCredit';
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
let crateId: string;
let bottleId: string;

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
  bottleId = (db.prepare("SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'UNIT'").get(starId) as { id: string }).id;
  crateId = addUnit(db, {
    productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
    isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: owner, deviceId: D,
  }).unitId;
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 240, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 240 * p.cost_price_pesewas, SUP, W, W, D);
  }
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

describe('bestTierFor — applies_to_unit_id filter', () => {
  it('crate-specific tier matches when sold in CRATE unit', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 700, appliesToUnitId: crateId, actorWorkerId: owner, deviceId: D });
    const tier = bestTierFor(db, starId, 'WALK_IN', 24, crateId);
    expect(tier?.unitPricePesewas).toBe(700);
    expect(tier?.appliesToUnitId).toBe(crateId);
  });

  it('crate-specific tier does NOT match when sold in BOTTLE unit', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 700, appliesToUnitId: crateId, actorWorkerId: owner, deviceId: D });
    const tier = bestTierFor(db, starId, 'WALK_IN', 24, bottleId);
    expect(tier).toBeNull();
  });

  it('unit-agnostic tier (NULL applies_to_unit_id) matches any unit', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    expect(bestTierFor(db, starId, 'WALK_IN', 12, bottleId)?.unitPricePesewas).toBe(750);
    expect(bestTierFor(db, starId, 'WALK_IN', 24, crateId)?.unitPricePesewas).toBe(750);
  });

  it('unit-specific tier beats unit-agnostic at the same threshold', () => {
    // Universal tier
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    // Crate-specific tier
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 700, appliesToUnitId: crateId, actorWorkerId: owner, deviceId: D });
    const tier = bestTierFor(db, starId, 'WALK_IN', 24, crateId);
    expect(tier?.unitPricePesewas).toBe(700); // unit-specific wins
    expect(tier?.appliesToUnitId).toBe(crateId);
  });

  it('legacy lookup with no unitId only sees unit-agnostic tiers', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 700, appliesToUnitId: crateId, actorWorkerId: owner, deviceId: D });
    const tier = bestTierFor(db, starId, 'WALK_IN', 24);
    expect(tier).toBeNull();
  });
});

describe('completeSale — unit-specific tier auto-apply', () => {
  let shiftId: string;
  beforeEach(() => {
    shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  });

  it('crate-only tier applies on crate sale, not bottle sale', async () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 700, appliesToUnitId: crateId, actorWorkerId: owner, deviceId: D });
    // Sale by crate — tier wins (24 bottles * 700 = 16,800)
    const r1 = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 16800, deviceId: D, shopName: 'T',
    });
    expect(r1.totalPesewas).toBe(16800);
    // Sale by bottle qty 24 — same canonical qty, but crate-only tier should NOT apply
    const r2 = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: bottleId, quantity: 24, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 19200, deviceId: D, shopName: 'T',
    });
    expect(r2.totalPesewas).toBe(24 * 800);
  });

  it('unit-agnostic tier applies on both', async () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    // 1 crate (= 24 canonical, tier price 750/canonical → 18000/crate)
    const r1 = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: 18000 }],
      paymentMethod: 'CASH', cashGivenPesewas: 18000, deviceId: D, shopName: 'T',
    });
    expect(r1.totalPesewas).toBe(18000); // 24 * 750
    // 24 bottles
    const r2 = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: starId, unitId: bottleId, quantity: 24, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 18000, deviceId: D, shopName: 'T',
    });
    expect(r2.totalPesewas).toBe(18000); // also tier 750
  });
});

describe('customer.preferred_channel round-trip', () => {
  it('createCustomer persists preferredChannel', () => {
    const r = createCustomer(db, {
      displayName: 'Yaw Wholesale', phone: '0244111000',
      preferredChannel: 'WHOLESALE',
      actorWorkerId: W, deviceId: D,
    });
    const row = db.prepare('SELECT preferred_channel FROM customers WHERE id = ?').get(r.customerId) as { preferred_channel: string };
    expect(row.preferred_channel).toBe('WHOLESALE');
  });

  it('searchCustomers returns preferredChannel', () => {
    createCustomer(db, {
      displayName: 'Ama Bar', phone: '0244222000',
      preferredChannel: 'WHOLESALE',
      actorWorkerId: W, deviceId: D,
    });
    const hits = searchCustomers(db, '0244222000', 5);
    expect(hits[0]?.preferredChannel).toBe('WHOLESALE');
  });

  it('updateCustomer can change preferredChannel', () => {
    const r = createCustomer(db, {
      displayName: 'Walk-in Yaw', phone: '0244333000',
      actorWorkerId: W, deviceId: D,
    });
    expect((db.prepare('SELECT preferred_channel FROM customers WHERE id = ?').get(r.customerId) as { preferred_channel: string | null }).preferred_channel).toBeNull();
    updateCustomer(db, {
      customerId: r.customerId,
      fields: { preferredChannel: 'WHOLESALE' },
      actorWorkerId: W, deviceId: D,
    });
    expect((db.prepare('SELECT preferred_channel FROM customers WHERE id = ?').get(r.customerId) as { preferred_channel: string }).preferred_channel).toBe('WHOLESALE');
  });

  it('rejects invalid preferredChannel value on update', () => {
    const r = createCustomer(db, {
      displayName: 'X', phone: '0244444000',
      actorWorkerId: W, deviceId: D,
    });
    expect(() => updateCustomer(db, {
      customerId: r.customerId,
      fields: { preferredChannel: 'NOPE' as 'WHOLESALE' },
      actorWorkerId: W, deviceId: D,
    })).toThrow(/invalid preferredChannel/);
  });

  it('getCustomerOverview exposes preferredChannel', () => {
    const r = createCustomer(db, {
      displayName: 'X', phone: '0244555000',
      preferredChannel: 'ROUTE',
      actorWorkerId: W, deviceId: D,
    });
    const overview = getCustomerOverview(db, r.customerId);
    expect(overview.preferredChannel).toBe('ROUTE');
  });

  it('preferredChannel = NULL clears the preference', () => {
    const r = createCustomer(db, {
      displayName: 'X', phone: '0244666000',
      preferredChannel: 'WHOLESALE',
      actorWorkerId: W, deviceId: D,
    });
    updateCustomer(db, {
      customerId: r.customerId,
      fields: { preferredChannel: null },
      actorWorkerId: W, deviceId: D,
    });
    const cust = db.prepare('SELECT preferred_channel FROM customers WHERE id = ?').get(r.customerId) as { preferred_channel: string | null };
    expect(cust.preferred_channel).toBeNull();
  });
});
