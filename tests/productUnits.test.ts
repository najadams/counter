// productUnits service: role gating, conversion factor validation,
// defaultSaleUnit picks smallest, dedup, deactivate/reactivate.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  addUnit, convertToCanonical, deactivateUnit, defaultSaleUnit, getUnit,
  listUnitsForProduct, reactivateUnit, updateUnit,
} from '../src/main/services/productUnits';
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

describe('migration backfill', () => {
  it('every existing product has a default UNIT row', () => {
    const products = db.prepare("SELECT id FROM products WHERE deleted_at IS NULL").all() as Array<{ id: string }>;
    for (const p of products) {
      const def = defaultSaleUnit(db, p.id);
      expect(def).not.toBeNull();
      expect(def?.unitName).toBe('UNIT');
      expect(def?.conversionFactor).toBe(1);
    }
  });
});

describe('addUnit — role gating', () => {
  it('OWNER can add', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isPurchaseUnit: true, isSaleUnit: true,
      actorWorkerId: owner, deviceId: D,
    });
    expect(r.unitId).toMatch(/^pu-/);
  });
  it('SUPERVISOR cannot add', () => {
    expect(() => addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: SUP, deviceId: D,
    })).toThrow(/not permitted/);
  });
  it('COUNTER cannot add', () => {
    expect(() => addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/not permitted/);
  });
});

describe('addUnit — validation', () => {
  it('rejects empty unit name', () => {
    expect(() => addUnit(db, {
      productId: starId, unitName: '   ', conversionFactor: 1, pricePesewas: 800,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/unitName required/);
  });
  it('rejects non-positive conversion factor', () => {
    expect(() => addUnit(db, {
      productId: starId, unitName: 'X', conversionFactor: 0, pricePesewas: 800,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/positive integer/);
    expect(() => addUnit(db, {
      productId: starId, unitName: 'Y', conversionFactor: -2, pricePesewas: 800,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/positive integer/);
  });
  it('rejects negative price', () => {
    expect(() => addUnit(db, {
      productId: starId, unitName: 'X', conversionFactor: 1, pricePesewas: -1,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/non-negative integer/);
  });
  it('rejects unit that is neither sale nor purchase', () => {
    expect(() => addUnit(db, {
      productId: starId, unitName: 'X', conversionFactor: 1, pricePesewas: 800,
      isSaleUnit: false, isPurchaseUnit: false,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/sellable, purchasable, or both/);
  });
  it('rejects duplicate unit_name per product', () => {
    addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    expect(() => addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 12, pricePesewas: 9500,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/already exists/);
  });
  it('rejects unit on unknown product', () => {
    expect(() => addUnit(db, {
      productId: 'nope', unitName: 'X', conversionFactor: 1, pricePesewas: 800,
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/not found/);
  });
});

describe('defaultSaleUnit', () => {
  it('returns smallest active sellable unit', () => {
    addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    const def = defaultSaleUnit(db, starId);
    // Migration backfilled UNIT factor=1, so it should win over CRATE factor=24.
    expect(def?.unitName).toBe('UNIT');
    expect(def?.conversionFactor).toBe(1);
  });

  it('falls through inactive units', () => {
    // Deactivate the default UNIT, see CRATE become default.
    addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    const def0 = defaultSaleUnit(db, starId)!;
    deactivateUnit(db, def0.id, owner, D);
    const def = defaultSaleUnit(db, starId);
    expect(def?.unitName).toBe('CRATE');
  });

  it('returns null when no active sellable units', () => {
    const def0 = defaultSaleUnit(db, starId)!;
    deactivateUnit(db, def0.id, owner, D);
    expect(defaultSaleUnit(db, starId)).toBeNull();
  });

  it('skips purchase-only units', () => {
    addUnit(db, {
      productId: starId, unitName: 'PALLET', conversionFactor: 240, pricePesewas: 0,
      isSaleUnit: false, isPurchaseUnit: true,
      actorWorkerId: owner, deviceId: D,
    });
    const def = defaultSaleUnit(db, starId);
    expect(def?.unitName).toBe('UNIT'); // PALLET ignored
  });

  it('honors the primary sale unit ("Default at the till") when set', () => {
    const crate = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    db.prepare('UPDATE products SET primary_sale_unit_id = ? WHERE id = ?').run(crate.unitId, starId);
    expect(defaultSaleUnit(db, starId)?.unitName).toBe('CRATE'); // not the smaller UNIT
  });

  it('falls back to smallest when the primary unit is deactivated', () => {
    const crate = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    db.prepare('UPDATE products SET primary_sale_unit_id = ? WHERE id = ?').run(crate.unitId, starId);
    deactivateUnit(db, crate.unitId, owner, D);
    expect(defaultSaleUnit(db, starId)?.unitName).toBe('UNIT');
  });
});

describe('convertToCanonical', () => {
  it('multiplies by factor', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    expect(convertToCanonical(db, r.unitId, 1)).toBe(24);
    expect(convertToCanonical(db, r.unitId, 5)).toBe(120);
  });
  it('rejects fractional input', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    expect(() => convertToCanonical(db, r.unitId, 1.5)).toThrow(/positive integer/);
  });
  it('rejects inactive unit', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    deactivateUnit(db, r.unitId, owner, D);
    expect(() => convertToCanonical(db, r.unitId, 1)).toThrow(/inactive/);
  });
});

describe('updateUnit / deactivate / reactivate', () => {
  it('updates price + audit diff', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    updateUnit(db, { unitId: r.unitId, fields: { pricePesewas: 17500 }, actorWorkerId: owner, deviceId: D });
    const u = getUnit(db, r.unitId);
    expect(u?.pricePesewas).toBe(17500);
  });

  it('renames and re-factors an existing unit in place', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'PAKC', conversionFactor: 20, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    updateUnit(db, {
      unitId: r.unitId,
      fields: { unitName: 'PACK', conversionFactor: 24 },
      actorWorkerId: owner, deviceId: D,
    });
    const u = getUnit(db, r.unitId);
    expect(u?.unitName).toBe('PACK');
    expect(u?.conversionFactor).toBe(24);
  });

  it('rejects a rename that collides with another unit', () => {
    addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    const r = addUnit(db, {
      productId: starId, unitName: 'PACK', conversionFactor: 6, pricePesewas: 4500,
      actorWorkerId: owner, deviceId: D,
    });
    expect(() => updateUnit(db, {
      unitId: r.unitId, fields: { unitName: 'CRATE' }, actorWorkerId: owner, deviceId: D,
    })).toThrow(/already exists/);
  });

  it('rejects a factor edit that is not a positive integer', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    expect(() => updateUnit(db, {
      unitId: r.unitId, fields: { conversionFactor: 0 }, actorWorkerId: owner, deviceId: D,
    })).toThrow(/positive integer/);
  });

  it('rejects an edit that clears both sale and purchase', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      isSaleUnit: true, isPurchaseUnit: false, actorWorkerId: owner, deviceId: D,
    });
    expect(() => updateUnit(db, {
      unitId: r.unitId, fields: { isSaleUnit: false }, actorWorkerId: owner, deviceId: D,
    })).toThrow(/sellable, purchasable, or both/);
  });

  it('deactivate + reactivate flips active', () => {
    const r = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000,
      actorWorkerId: owner, deviceId: D,
    });
    deactivateUnit(db, r.unitId, owner, D);
    expect(getUnit(db, r.unitId)?.active).toBe(false);
    reactivateUnit(db, r.unitId, owner, D);
    expect(getUnit(db, r.unitId)?.active).toBe(true);
  });
});

describe('listUnitsForProduct', () => {
  it('returns sorted by display_order then factor', () => {
    addUnit(db, { productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000, actorWorkerId: owner, deviceId: D, displayOrder: 1 });
    addUnit(db, { productId: starId, unitName: 'SIX_PACK', conversionFactor: 6, pricePesewas: 4500, actorWorkerId: owner, deviceId: D, displayOrder: 2 });
    const list = listUnitsForProduct(db, starId, { activeOnly: true });
    // UNIT (display_order 0, factor 1) → SIX_PACK (no, display_order 2 > 1 = CRATE)
    // Actually our default UNIT has display_order=0; CRATE=1; SIX_PACK=2.
    expect(list.map((u) => u.unitName)).toEqual(['UNIT', 'CRATE', 'SIX_PACK']);
  });
});
