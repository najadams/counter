// Products admin: role gating, validation, audit diffs.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  addProduct, deactivateProduct, listProductsForAdmin,
  reactivateProduct, updateProduct,
} from '../src/main/services/productsAdmin';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const COUNTER = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const D = 'test-device';
const L = 'loc-main-counter';

let db: ReturnType<typeof Database>;
let owner: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // Bootstrap an OWNER for admin operations.
  owner = 'dev-owner-1';
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, ?, ?, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(owner, 'Dev Owner', '+233555000003', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS), 500000, 8);
});
afterEach(() => { db.close(); });

const VALID = {
  sku: 'TEST-001', name: 'Test Beer', category: 'BEER',
  costPricePesewas: 600, walkInPricePesewas: 800,
  wholesalePricePesewas: 750, routePricePesewas: 720,
};

describe('addProduct — role gating', () => {
  it('OWNER can add', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    expect(r.productId).toMatch(/^prod-/);
    expect(r.warnings).toHaveLength(0);
  });
  it('SUPERVISOR cannot add', () => {
    expect(() => addProduct(db, { ...VALID, actorWorkerId: SUP, deviceId: D })).toThrow(/not permitted/);
  });
  it('COUNTER cannot add', () => {
    expect(() => addProduct(db, { ...VALID, actorWorkerId: COUNTER, deviceId: D })).toThrow(/not permitted/);
  });
});

describe('addProduct — validation', () => {
  it('rejects duplicate SKU', () => {
    addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    expect(() => addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D })).toThrow(/already exists/);
  });
  it('rejects invalid category', () => {
    expect(() => addProduct(db, { ...VALID, category: 'NOPE', actorWorkerId: owner, deviceId: D })).toThrow(/invalid category/);
  });
  it('rejects negative price', () => {
    expect(() => addProduct(db, { ...VALID, costPricePesewas: -1, actorWorkerId: owner, deviceId: D })).toThrow(/non-negative integer/);
    expect(() => addProduct(db, { ...VALID, walkInPricePesewas: -1, actorWorkerId: owner, deviceId: D })).toThrow(/non-negative integer/);
  });
  it('rejects empty SKU', () => {
    expect(() => addProduct(db, { ...VALID, sku: '   ', actorWorkerId: owner, deviceId: D })).toThrow(/sku required/);
  });
  it('warns when walk-in < cost', () => {
    const r = addProduct(db, { ...VALID, walkInPricePesewas: 500, actorWorkerId: owner, deviceId: D });
    expect(r.warnings.some((w) => w.includes('walk-in price is below cost'))).toBe(true);
  });
});

describe('addProduct — audit', () => {
  it('writes PRODUCT_ADDED with key fields', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    const a = db.prepare(`SELECT action, after_value FROM audit_log WHERE entity_id = ?`).get(r.productId) as { action: string; after_value: string };
    expect(a.action).toBe('PRODUCT_ADDED');
    const after = JSON.parse(a.after_value);
    expect(after.sku).toBe(VALID.sku);
    expect(after.walkInPricePesewas).toBe(VALID.walkInPricePesewas);
  });
});

describe('updateProduct — role gating + diffs', () => {
  it('OWNER can update; before/after diff recorded', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    const upd = updateProduct(db, {
      productId: r.productId,
      fields: { walkInPricePesewas: 900, name: 'Test Beer Premium' },
      actorWorkerId: owner, deviceId: D,
    });
    expect(upd.warnings).toHaveLength(0);
    const row = db.prepare('SELECT walk_in_price_pesewas, name FROM products WHERE id = ?').get(r.productId) as { walk_in_price_pesewas: number; name: string };
    expect(row.walk_in_price_pesewas).toBe(900);
    expect(row.name).toBe('Test Beer Premium');
    const audit = db.prepare(`SELECT before_value, after_value FROM audit_log WHERE entity_id = ? AND action = 'PRODUCT_UPDATED'`).get(r.productId) as { before_value: string; after_value: string };
    expect(audit).toBeDefined();
    const before = JSON.parse(audit.before_value);
    const after = JSON.parse(audit.after_value);
    expect(before.walkInPricePesewas).toBe(800);
    expect(after.walkInPricePesewas).toBe(900);
    expect(before.name).toBe('Test Beer');
    expect(after.name).toBe('Test Beer Premium');
  });

  it('SUPERVISOR cannot update', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    expect(() => updateProduct(db, {
      productId: r.productId, fields: { walkInPricePesewas: 900 },
      actorWorkerId: SUP, deviceId: D,
    })).toThrow(/not permitted/);
  });

  it('rejects invalid category on update', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    expect(() => updateProduct(db, {
      productId: r.productId, fields: { category: 'NOPE' },
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/invalid category/);
  });

  it('warns when update creates below-cost pricing', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    const upd = updateProduct(db, {
      productId: r.productId, fields: { walkInPricePesewas: 500 },
      actorWorkerId: owner, deviceId: D,
    });
    expect(upd.warnings.some((w) => w.includes('walk-in price below cost'))).toBe(true);
  });

  it('refuses to update inactive product', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    deactivateProduct(db, r.productId, owner, D);
    expect(() => updateProduct(db, {
      productId: r.productId, fields: { walkInPricePesewas: 900 },
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/inactive/);
  });

  it('no-op when fields object is empty', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    const upd = updateProduct(db, { productId: r.productId, fields: {}, actorWorkerId: owner, deviceId: D });
    expect(upd.warnings).toHaveLength(0);
  });
});

describe('deactivate / reactivate', () => {
  it('deactivate sets active=0, audit', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    deactivateProduct(db, r.productId, owner, D);
    const row = db.prepare('SELECT active FROM products WHERE id = ?').get(r.productId) as { active: number };
    expect(row.active).toBe(0);
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'PRODUCT_DEACTIVATED'`).get(r.productId);
    expect(a).toBeDefined();
  });

  it('refuses double-deactivate', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    deactivateProduct(db, r.productId, owner, D);
    expect(() => deactivateProduct(db, r.productId, owner, D)).toThrow(/already inactive/);
  });

  it('reactivate restores active=1', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    deactivateProduct(db, r.productId, owner, D);
    reactivateProduct(db, r.productId, owner, D);
    const row = db.prepare('SELECT active FROM products WHERE id = ?').get(r.productId) as { active: number };
    expect(row.active).toBe(1);
  });

  it('SUPERVISOR cannot deactivate', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    expect(() => deactivateProduct(db, r.productId, SUP, D)).toThrow(/not permitted/);
  });
});

describe('listProductsForAdmin', () => {
  it('returns active + inactive, sorted', () => {
    const r1 = addProduct(db, { ...VALID, sku: 'AAA', name: 'AAA', actorWorkerId: owner, deviceId: D });
    addProduct(db, { ...VALID, sku: 'ZZZ', name: 'ZZZ', actorWorkerId: owner, deviceId: D });
    deactivateProduct(db, r1.productId, owner, D);
    const list = listProductsForAdmin(db, L);
    // Inactive sorts after active in our query.
    expect(list.some((p) => p.sku === 'ZZZ' && p.active)).toBe(true);
    expect(list.some((p) => p.sku === 'AAA' && !p.active)).toBe(true);
  });

  it('reports unitsOnHand', () => {
    const r = addProduct(db, { ...VALID, actorWorkerId: owner, deviceId: D });
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES ('sm-x', ?, ?, 12, 'RECEIVED_FROM_SUPPLIER', ?, 600, 7200, ?, ?, ?, ?)`,
    ).run(r.productId, L, SUP, SUP, owner, owner, D);
    const list = listProductsForAdmin(db, L);
    const got = list.find((p) => p.id === r.productId);
    expect(got?.unitsOnHand).toBe(12);
  });
});
