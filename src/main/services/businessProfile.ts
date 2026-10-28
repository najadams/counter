// Business profile and product categories (see src/shared/lib/businessProfile.ts).
//
// device_config keys:
//   business_profile  DRINKS | PROVISIONS | HARDWARE | COSMETICS | GENERAL
//                     (absent = an install from before profiles = DRINKS)
//   empties_in_use    '1' | '0' (absent = the profile's default)
//
// Both are preferences about what the screens show. Neither changes how a sale,
// a payment or a stock move is recorded, and main never refuses a returnable
// product because empties are switched off.

import type { Database as DB } from 'better-sqlite3';
import {
  BUSINESS_PROFILE_DEFS, LEGACY_BUSINESS_PROFILE, OTHER_CATEGORY,
  categoryCodeFromLabel, fallbackCategoryLabel, isBusinessProfile,
  type BusinessProfile,
} from '../../shared/lib/businessProfile.js';

export interface ProductCategoryRow {
  code: string;
  label: string;
  sortOrder: number;
  active: boolean;
  /** Live (not deleted) products filed under this code. */
  productCount: number;
}

export interface BusinessSettings {
  profile: BusinessProfile;
  emptiesInUse: boolean;
}

function readConfig(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM device_config WHERE key = ?`).get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

function writeConfig(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO device_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, value);
}

export function getBusinessSettings(db: DB): BusinessSettings {
  const stored = readConfig(db, 'business_profile');
  const profile = isBusinessProfile(stored) ? stored : LEGACY_BUSINESS_PROFILE;
  const empties = readConfig(db, 'empties_in_use');
  return {
    profile,
    emptiesInUse: empties == null ? BUSINESS_PROFILE_DEFS[profile].emptiesByDefault : empties === '1',
  };
}

export function setBusinessSettings(
  db: DB,
  input: { profile?: string; emptiesInUse?: boolean },
): BusinessSettings {
  if (input.profile !== undefined) {
    if (!isBusinessProfile(input.profile)) throw new Error(`unknown business profile '${input.profile}'`);
    writeConfig(db, 'business_profile', input.profile);
  }
  if (input.emptiesInUse !== undefined) writeConfig(db, 'empties_in_use', input.emptiesInUse ? '1' : '0');
  return getBusinessSettings(db);
}

/**
 * First-run setup: record the profile and swap migration 0057's beverage
 * starter list for this profile's. The beverage rows are removed rather than
 * hidden — a new hardware shop has no use for a hidden "Beer" — except any
 * category a product already uses (nothing references a category row, so
 * removing an unused one loses nothing).
 */
export function applyBusinessProfileAtSetup(db: DB, profile: BusinessProfile, actorId: string): void {
  writeConfig(db, 'business_profile', profile);
  const starter = [...BUSINESS_PROFILE_DEFS[profile].categories, OTHER_CATEGORY];
  db.prepare(
    `DELETE FROM product_categories
      WHERE code NOT IN (SELECT value FROM json_each(?))
        AND code NOT IN (SELECT category FROM products)`,
  ).run(JSON.stringify(starter.map((c) => c.code)));
  const upsert = db.prepare(
    `INSERT INTO product_categories (code, label, sort_order, active, created_by, updated_by)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(code) DO UPDATE SET active = 1, label = excluded.label,
       sort_order = excluded.sort_order, updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  starter.forEach((c, i) => {
    const order = c.code === OTHER_CATEGORY.code ? 1000 : (i + 1) * 10;
    upsert.run(c.code, c.label, order, actorId, actorId);
  });
}

/**
 * Every category the shop has, plus any code a product carries that has no
 * row (pulled from HQ before the shop added it) under a readable label.
 * Shown ones first, each group in the owner's order.
 */
export function listProductCategories(db: DB): ProductCategoryRow[] {
  const rows = db.prepare(
    `SELECT c.code, c.label, c.sort_order AS sortOrder, c.active,
            (SELECT COUNT(*) FROM products p WHERE p.category = c.code AND p.deleted_at IS NULL) AS productCount
       FROM product_categories c
     UNION ALL
     SELECT p.category, NULL, 2000, 1, COUNT(*)
       FROM products p
      WHERE p.deleted_at IS NULL
        AND p.category NOT IN (SELECT code FROM product_categories)
      GROUP BY p.category
     ORDER BY 4 DESC, 3, 2`,
  ).all() as Array<{ code: string; label: string | null; sortOrder: number; active: number; productCount: number }>;
  return rows.map((r) => ({
    code: r.code,
    label: r.label ?? fallbackCategoryLabel(r.code),
    sortOrder: r.sortOrder,
    active: r.active === 1,
    productCount: r.productCount,
  }));
}

/** True when a product may be filed under this code. */
export function isKnownProductCategory(db: DB, code: string): boolean {
  return db.prepare(`SELECT 1 FROM product_categories WHERE code = ? AND active = 1`).get(code) != null;
}

export function addProductCategory(db: DB, input: { label: string; actorId: string }): ProductCategoryRow {
  const label = input.label.trim();
  if (!label) throw new Error('category name required');
  if (label.length > 60) throw new Error('category name is too long (60 characters at most)');
  const code = categoryCodeFromLabel(label);
  if (!code) throw new Error('category name needs at least one letter or digit');

  const existing = db.prepare(`SELECT active FROM product_categories WHERE code = ?`).get(code) as
    { active: number } | undefined;
  if (existing?.active === 1) throw new Error(`a category called '${label}' already exists`);

  const next = db.prepare(
    `SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM product_categories WHERE code <> 'OTHER'`,
  ).get() as { n: number };
  db.prepare(
    `INSERT INTO product_categories (code, label, sort_order, active, created_by, updated_by)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(code) DO UPDATE SET active = 1, label = excluded.label,
       updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(code, label, Math.min(next.n, 999), input.actorId, input.actorId);
  return listProductCategories(db).find((c) => c.code === code)!;
}

export function updateProductCategory(
  db: DB,
  input: { code: string; label?: string; active?: boolean; actorId: string },
): ProductCategoryRow {
  const row = db.prepare(`SELECT code FROM product_categories WHERE code = ?`).get(input.code);
  if (!row) {
    // A code only products carry (pulled from HQ) gets its row on first edit.
    const used = db.prepare(`SELECT 1 FROM products WHERE category = ? AND deleted_at IS NULL`).get(input.code);
    if (!used) throw new Error(`no category '${input.code}'`);
    db.prepare(
      `INSERT INTO product_categories (code, label, sort_order, created_by, updated_by) VALUES (?, ?, 900, ?, ?)`,
    ).run(input.code, fallbackCategoryLabel(input.code), input.actorId, input.actorId);
  }
  if (input.code === OTHER_CATEGORY.code && input.active === false) {
    throw new Error('Other cannot be hidden — products need somewhere to go');
  }
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) throw new Error('category name required');
    if (label.length > 60) throw new Error('category name is too long (60 characters at most)');
    db.prepare(
      `UPDATE product_categories SET label = ?, updated_by = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`,
    ).run(label, input.actorId, input.code);
  }
  if (input.active !== undefined) {
    db.prepare(
      `UPDATE product_categories SET active = ?, updated_by = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`,
    ).run(input.active ? 1 : 0, input.actorId, input.code);
  }
  return listProductCategories(db).find((c) => c.code === input.code)!;
}
