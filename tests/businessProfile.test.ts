// Business profiles and owner-defined product categories (migration 0057,
// src/main/services/businessProfile.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { addProduct, updateProduct } from '../src/main/services/productsAdmin';
import { createFirstOwner } from '../src/main/services/setup';
import {
  addProductCategory, getBusinessSettings, listProductCategories,
  setBusinessSettings, updateProductCategory,
} from '../src/main/services/businessProfile';
import { applyCatalogImport } from '../src/main/services/catalogImport';
import { categoryCodeFromLabel, fallbackCategoryLabel, withArticle } from '../src/shared/lib/businessProfile';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';
import type { CatalogProduct } from '../src/shared/types/ipc';

const D = 'test-device';
const PRODUCT = {
  sku: 'NAIL-3IN', name: 'Nails 3 inch',
  costPricePesewas: 600, walkInPricePesewas: 800,
  wholesalePricePesewas: 750, routePricePesewas: 720,
};

describe('migration 0057 — products lose the beverage-only CHECK', () => {
  it('keeps every product row, its children and the HQ outbox as they were', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-before-57-'));
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      for (const file of fs.readdirSync('migrations')) {
        if (file.endsWith('.sql') && file < '0057') fs.copyFileSync(path.join('migrations', file), path.join(dir, file));
      }
      runMigrations(db, dir);
      runSeed(db, { includeDevFixtures: true });
      const productId = (db.prepare(`SELECT id FROM products LIMIT 1`).get() as { id: string }).id;
      db.prepare(
        `INSERT INTO product_units (id, product_id, unit_name, conversion_factor, price_pesewas,
           created_by, updated_by, device_id) VALUES ('pu-57', ?, 'BOX57', 12, 1000, 'sys-system', 'sys-system', 'd')`,
      ).run(productId);
      db.prepare(`UPDATE products SET primary_sale_unit_id = 'pu-57' WHERE id = ?`).run(productId);
      db.prepare(`INSERT INTO device_config (key, value) VALUES ('sync_role', 'HQ')`).run();
      const products = db.prepare(`SELECT * FROM products ORDER BY id`).all();
      const units = db.prepare(`SELECT * FROM product_units ORDER BY id`).all();
      const outbox = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox`).get();
      expect(products.length).toBeGreaterThan(0);

      expect(runMigrations(db, path.resolve('migrations')).applied).toContain('0057_product_categories.sql');

      expect(db.prepare(`SELECT * FROM products ORDER BY id`).all()).toEqual(products);
      expect(db.prepare(`SELECT * FROM product_units ORDER BY id`).all()).toEqual(units);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox`).get()).toEqual(outbox);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // The sync capture triggers came back with the table.
      const triggers = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'products' ORDER BY name`,
      ).all();
      expect(triggers).toEqual([{ name: 'trg_outbox_products_mins' }, { name: 'trg_outbox_products_mupd' }]);
      db.prepare(`UPDATE products SET name = name WHERE id = ?`).run(productId);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox`).get() as { n: number }).n)
        .toBe((outbox as { n: number }).n + 1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('business profile and categories', () => {
  let db: ReturnType<typeof Database>;
  const owner = 'dev-owner-1';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, path.resolve('migrations'));
  });
  afterEach(() => { db.close(); });

  function seedOwner() {
    runSeed(db, { includeDevFixtures: true });
    db.prepare(
      `INSERT INTO workers (id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, created_by, updated_by, device_id)
        VALUES (?, 'Dev Owner', '+233555000003', 'OWNER', ?, 0, 8, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
    ).run(owner, bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS));
  }

  it('reads an install from before profiles as a drinks shop with empties on', () => {
    expect(getBusinessSettings(db)).toEqual({ profile: 'DRINKS', emptiesInUse: true });
    const active = listProductCategories(db).filter((c) => c.active).map((c) => c.code);
    expect(active).toContain('BEER');
    expect(active[active.length - 1]).toBe('OTHER');
  });

  it('first-run setup swaps the beverage list for the chosen profile', () => {
    createFirstOwner(db, {
      fullName: 'Ama Mensah', phone: '0244123456', pin: '1234', deviceId: D, businessProfile: 'HARDWARE',
    });
    expect(getBusinessSettings(db)).toEqual({ profile: 'HARDWARE', emptiesInUse: false });
    const categories = listProductCategories(db);
    const active = categories.filter((c) => c.active).map((c) => c.code);
    expect(active).toEqual(['CEMENT', 'IRON', 'PAINT', 'PLUMBING', 'ELECTRICAL', 'TOOLS', 'FASTENERS', 'OTHER']);
    // The beverage starter rows are gone, not merely hidden.
    expect(categories.map((c) => c.code)).toEqual(active);
  });

  it('setup without a profile stays a drinks shop', () => {
    createFirstOwner(db, { fullName: 'Kofi', phone: '0244123456', pin: '1234', deviceId: D });
    expect(getBusinessSettings(db).profile).toBe('DRINKS');
    expect(listProductCategories(db).find((c) => c.code === 'BEER')?.active).toBe(true);
  });

  it('refuses an unknown profile at setup without creating the owner', () => {
    expect(() => createFirstOwner(db, {
      fullName: 'Kofi', phone: '0244123456', pin: '1234', deviceId: D, businessProfile: 'PHARMACY',
    })).toThrow(/unknown business profile/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM workers WHERE role = 'OWNER'`).get() as { n: number }).n).toBe(0);
  });

  it('the empties switch overrides the profile default and survives a profile change', () => {
    setBusinessSettings(db, { profile: 'PROVISIONS' });
    expect(getBusinessSettings(db).emptiesInUse).toBe(false);
    setBusinessSettings(db, { emptiesInUse: true });
    setBusinessSettings(db, { profile: 'GENERAL' });
    expect(getBusinessSettings(db)).toEqual({ profile: 'GENERAL', emptiesInUse: true });
    expect(() => setBusinessSettings(db, { profile: 'NOPE' })).toThrow(/unknown business profile/);
  });

  it('files a product under a category the owner added', () => {
    seedOwner();
    const added = addProductCategory(db, { label: 'Nails & screws', actorId: owner });
    expect(added.code).toBe('NAILS_SCREWS');
    const r = addProduct(db, { ...PRODUCT, category: added.code, actorWorkerId: owner, deviceId: D });
    const row = db.prepare(`SELECT category FROM products WHERE id = ?`).get(r.productId);
    expect(row).toEqual({ category: 'NAILS_SCREWS' });
    expect(listProductCategories(db).find((c) => c.code === 'NAILS_SCREWS')?.productCount).toBe(1);
  });

  it('refuses a duplicate, an empty name, and hiding Other', () => {
    seedOwner();
    addProductCategory(db, { label: 'Tools', actorId: owner });
    expect(() => addProductCategory(db, { label: 'tools', actorId: owner })).toThrow(/already exists/);
    expect(() => addProductCategory(db, { label: '  ', actorId: owner })).toThrow(/name required/);
    expect(() => addProductCategory(db, { label: '!!!', actorId: owner })).toThrow(/letter or digit/);
    expect(() => updateProductCategory(db, { code: 'OTHER', active: false, actorId: owner })).toThrow(/cannot be hidden/);
  });

  it('a hidden category refuses new products but leaves existing ones editable', () => {
    seedOwner();
    const r = addProduct(db, { ...PRODUCT, category: 'WATER', actorWorkerId: owner, deviceId: D });
    updateProductCategory(db, { code: 'WATER', active: false, actorId: owner });
    expect(() => addProduct(db, { ...PRODUCT, sku: 'X-2', category: 'WATER', actorWorkerId: owner, deviceId: D }))
      .toThrow(/invalid category/);
    // The product form sends its whole state back, category included.
    expect(() => updateProduct(db, {
      productId: r.productId, fields: { category: 'WATER', name: 'Still water' }, actorWorkerId: owner, deviceId: D,
    })).not.toThrow();
    // Re-adding the hidden one brings it back rather than failing as a duplicate.
    expect(addProductCategory(db, { label: 'Water', actorId: owner }).active).toBe(true);
  });

  it('shows a code only products carry, and gives it a row on first edit', () => {
    seedOwner();
    const r = addProduct(db, { ...PRODUCT, category: 'OTHER', actorWorkerId: owner, deviceId: D });
    // A catalog row pulled from HQ under a category this shop never added.
    db.prepare(`UPDATE products SET category = 'ROOFING_SHEETS' WHERE id = ?`).run(r.productId);
    const pulled = listProductCategories(db).find((c) => c.code === 'ROOFING_SHEETS');
    expect(pulled).toMatchObject({ label: 'Roofing sheets', active: true, productCount: 1 });
    expect(updateProductCategory(db, { code: 'ROOFING_SHEETS', label: 'Roofing', actorId: owner }).label).toBe('Roofing');
  });

  it('catalog import accepts a category this shop has not seen and adds it', () => {
    seedOwner();
    const product: CatalogProduct = {
      sku: 'PAINT-5L', barcode: null, name: 'Emulsion 5L', category: 'PAINT', brand: null,
      packSizeUnits: 1, unitVolumeMl: null, isReturnable: false, bottleDepositPesewas: 0,
      costPricePesewas: 10000, walkInPricePesewas: 15000, wholesalePricePesewas: 14000, routePricePesewas: 14000,
      reorderThreshold: 0, reorderQuantity: 0, defaultLeadTimeDays: 7, shelfLifeDays: null,
      canonicalUnit: 'UNIT', countClass: null, active: true,
      primarySupplierName: null, primaryPurchaseUnitName: null, primarySaleUnitName: null,
    };
    applyCatalogImport(db, {
      schemaVersion: 1, exportedAt: '2026-10-28T00:00:00Z',
      source: { deviceId: 'other', shopName: null, appVersion: null },
      tables: { products: [product, { ...product, sku: 'BAD', category: 'not a code' }] },
    }, { dryRun: false, updateExisting: false, actorWorkerId: owner, deviceId: D });
    expect(db.prepare(`SELECT category FROM products WHERE sku = 'PAINT-5L'`).get()).toEqual({ category: 'PAINT' });
    expect(db.prepare(`SELECT 1 FROM products WHERE sku = 'BAD'`).get()).toBeUndefined();
    expect(listProductCategories(db).find((c) => c.code === 'PAINT')?.label).toBe('Paint');
  });
});

describe('category and wording helpers', () => {
  it('turns names into stable codes and back', () => {
    expect(categoryCodeFromLabel('  Rice & grains ')).toBe('RICE_GRAINS');
    expect(categoryCodeFromLabel('Crème')).toBe('CREME');
    expect(fallbackCategoryLabel('SOFT_DRINK')).toBe('Soft drink');
  });
  it('picks a or an', () => {
    expect(withArticle('drink')).toBe('a drink');
    expect(withArticle('item')).toBe('an item');
  });
});
