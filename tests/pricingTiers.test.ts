// pricingTiers: role gating, uniqueness, bestTierFor lookup precedence.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  addTier, bestTierFor, deactivateTier, listTiersForProduct, updateTier,
} from '../src/main/services/pricingTiers';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const COUNTER = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
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
});
afterEach(() => { db.close(); });

describe('addTier — role gating', () => {
  it('OWNER can add', () => {
    const r = addTier(db, {
      productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750,
      actorWorkerId: owner, deviceId: D,
    });
    expect(r.tierId).toMatch(/^pt-/);
  });

  it('SUPERVISOR cannot add', () => {
    expect(() => addTier(db, {
      productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750,
      actorWorkerId: SUP, deviceId: D,
    })).toThrow(/not permitted/);
  });

  it('COUNTER cannot add', () => {
    expect(() => addTier(db, {
      productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750,
      actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/not permitted/);
  });
});

describe('addTier — validation', () => {
  it('rejects unknown channel', () => {
    expect(() => addTier(db, {
      productId: starId, channel: 'NOPE' as 'WALK_IN', minQuantity: 12, unitPricePesewas: 750,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/invalid channel/);
  });

  it('rejects min_qty <= 0', () => {
    expect(() => addTier(db, {
      productId: starId, channel: 'WALK_IN', minQuantity: 0, unitPricePesewas: 750,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/positive integer/);
  });

  it('rejects negative price', () => {
    expect(() => addTier(db, {
      productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: -1,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/non-negative integer/);
  });

  it('rejects duplicate (product, channel, min_qty)', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    expect(() => addTier(db, {
      productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 700,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/already exists/);
  });

  it('rejects unknown product', () => {
    expect(() => addTier(db, {
      productId: 'nope', channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/not found/);
  });
});

describe('bestTierFor — lookup precedence', () => {
  it('returns null when no tier matches', () => {
    expect(bestTierFor(db, starId, 'WALK_IN', 12)).toBeNull();
  });

  it('returns null when quantity below threshold', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    expect(bestTierFor(db, starId, 'WALK_IN', 11)).toBeNull();
    expect(bestTierFor(db, starId, 'WALK_IN', 12)?.minQuantity).toBe(12);
  });

  it('returns the highest min_qty tier the cart line meets', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 6, unitPricePesewas: 780, actorWorkerId: owner, deviceId: D });
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 720, actorWorkerId: owner, deviceId: D });
    expect(bestTierFor(db, starId, 'WALK_IN', 6)?.minQuantity).toBe(6);
    expect(bestTierFor(db, starId, 'WALK_IN', 11)?.minQuantity).toBe(6);
    expect(bestTierFor(db, starId, 'WALK_IN', 12)?.minQuantity).toBe(12);
    expect(bestTierFor(db, starId, 'WALK_IN', 24)?.minQuantity).toBe(24);
    expect(bestTierFor(db, starId, 'WALK_IN', 50)?.minQuantity).toBe(24);
  });

  it('channel-specific tier beats ALL at same min_qty', () => {
    addTier(db, { productId: starId, channel: 'ALL', minQuantity: 12, unitPricePesewas: 770, actorWorkerId: owner, deviceId: D });
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    expect(bestTierFor(db, starId, 'WALK_IN', 12)?.unitPricePesewas).toBe(750);
    expect(bestTierFor(db, starId, 'WHOLESALE', 12)?.unitPricePesewas).toBe(770);
  });

  it('inactive tier is skipped', () => {
    const r = addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    deactivateTier(db, r.tierId, owner, D);
    expect(bestTierFor(db, starId, 'WALK_IN', 12)).toBeNull();
  });
});

describe('updateTier', () => {
  it('updates price + audits diff', () => {
    const r = addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    updateTier(db, { tierId: r.tierId, fields: { unitPricePesewas: 700 }, actorWorkerId: owner, deviceId: D });
    expect(bestTierFor(db, starId, 'WALK_IN', 12)?.unitPricePesewas).toBe(700);
    const audit = db.prepare(`SELECT before_value, after_value FROM audit_log WHERE entity_id = ? AND action = 'PRICING_TIER_UPDATED'`).get(r.tierId) as { before_value: string; after_value: string };
    const before = JSON.parse(audit.before_value);
    const after = JSON.parse(audit.after_value);
    expect(before.unitPricePesewas).toBe(750);
    expect(after.unitPricePesewas).toBe(700);
  });
});

describe('listTiersForProduct', () => {
  it('returns active + inactive sorted', () => {
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    addTier(db, { productId: starId, channel: 'WALK_IN', minQuantity: 24, unitPricePesewas: 720, actorWorkerId: owner, deviceId: D });
    const tiers = listTiersForProduct(db, starId);
    expect(tiers.length).toBe(2);
    expect(tiers[0]?.minQuantity).toBeLessThan(tiers[1]?.minQuantity ?? 0);
  });
});
