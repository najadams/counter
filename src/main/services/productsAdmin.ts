// Products administration. OWNER/FOUNDER only — pricing decisions live here
// and they're high-leverage. The schema's CHECK constraints already enforce
// non-negative prices and a closed category vocabulary; this layer adds the
// before/after diff for the audit log.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';

const ADMIN_ROLES = new Set(['OWNER', 'FOUNDER']);

const VALID_CATEGORIES = new Set([
  'BEER', 'WINE', 'SPIRITS', 'SOFT_DRINK', 'WATER', 'JUICE',
  'ENERGY_DRINK', 'MIXER', 'NON_BEVERAGE', 'OTHER',
]);

function requireAdmin(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor not active');
  }
  if (!ADMIN_ROLES.has(w.role)) {
    throw new Error(`role ${w.role} not permitted (OWNER/FOUNDER required)`);
  }
}

export interface AddProductInput {
  sku: string;
  barcode?: string | null;
  name: string;
  category: string;
  brand?: string | null;
  packSizeUnits?: number;
  unitVolumeMl?: number | null;
  isReturnable?: boolean;
  bottleDepositPesewas?: number;
  costPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold?: number;
  reorderQuantity?: number;
  primarySupplierId?: string | null;
  defaultLeadTimeDays?: number;
  shelfLifeDays?: number | null;
  actorWorkerId: string;
  deviceId: string;
}

export interface AddProductResult {
  productId: string;
  warnings: string[];
}

export function addProduct(db: DB, input: AddProductInput): AddProductResult {
  requireAdmin(db, input.actorWorkerId);
  if (!input.sku.trim()) throw new Error('sku required');
  if (!input.name.trim()) throw new Error('name required');
  if (!VALID_CATEGORIES.has(input.category)) {
    throw new Error(`invalid category '${input.category}'`);
  }
  for (const [key, value] of Object.entries({
    costPricePesewas: input.costPricePesewas,
    walkInPricePesewas: input.walkInPricePesewas,
    wholesalePricePesewas: input.wholesalePricePesewas,
    routePricePesewas: input.routePricePesewas,
    bottleDepositPesewas: input.bottleDepositPesewas ?? 0,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }

  const dup = db
    .prepare('SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL')
    .get(input.sku.trim()) as { id: string } | undefined;
  if (dup) throw new Error(`a product with SKU '${input.sku.trim()}' already exists`);

  const warnings: string[] = [];
  if (input.walkInPricePesewas < input.costPricePesewas) {
    warnings.push('walk-in price is below cost — selling at a loss');
  }
  if (input.wholesalePricePesewas < input.costPricePesewas) {
    warnings.push('wholesale price is below cost');
  }
  if (input.routePricePesewas < input.costPricePesewas) {
    warnings.push('route price is below cost');
  }

  const productId = `prod-${uuidv4()}`;
  db.prepare(
    `INSERT INTO products (
      id, sku, barcode, name, category, brand, pack_size_units, unit_volume_ml,
      is_returnable, bottle_deposit_pesewas,
      cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
      reorder_threshold, reorder_quantity, primary_supplier_id,
      default_lead_time_days, shelf_life_days,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    productId,
    input.sku.trim(),
    input.barcode ?? null,
    input.name.trim(),
    input.category,
    input.brand ?? null,
    input.packSizeUnits ?? 1,
    input.unitVolumeMl ?? null,
    input.isReturnable ? 1 : 0,
    input.bottleDepositPesewas ?? 0,
    input.costPricePesewas,
    input.walkInPricePesewas,
    input.wholesalePricePesewas,
    input.routePricePesewas,
    input.reorderThreshold ?? 0,
    input.reorderQuantity ?? 0,
    input.primarySupplierId ?? null,
    input.defaultLeadTimeDays ?? 7,
    input.shelfLifeDays ?? null,
    input.actorWorkerId,
    input.actorWorkerId,
    input.deviceId,
  );

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PRODUCT_ADDED',
    entityType: 'products',
    entityId: productId,
    afterValue: {
      sku: input.sku, name: input.name, category: input.category,
      costPricePesewas: input.costPricePesewas,
      walkInPricePesewas: input.walkInPricePesewas,
      wholesalePricePesewas: input.wholesalePricePesewas,
      routePricePesewas: input.routePricePesewas,
      warnings,
    },
    deviceId: input.deviceId,
  });

  return { productId, warnings };
}

export interface UpdateProductInput {
  productId: string;
  fields: Partial<{
    name: string;
    category: string;
    brand: string | null;
    packSizeUnits: number;
    unitVolumeMl: number | null;
    isReturnable: boolean;
    bottleDepositPesewas: number;
    costPricePesewas: number;
    walkInPricePesewas: number;
    wholesalePricePesewas: number;
    routePricePesewas: number;
    reorderThreshold: number;
    reorderQuantity: number;
    primarySupplierId: string | null;
    defaultLeadTimeDays: number;
    shelfLifeDays: number | null;
    barcode: string | null;
    countClass: 'A' | 'B' | 'C' | null;
  }>;
  actorWorkerId: string;
  deviceId: string;
}

export function updateProduct(db: DB, input: UpdateProductInput): { warnings: string[] } {
  requireAdmin(db, input.actorWorkerId);

  const existing = db
    .prepare(
      `SELECT id, sku, barcode, name, category, brand, pack_size_units, unit_volume_ml,
              is_returnable, bottle_deposit_pesewas, cost_price_pesewas,
              walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
              reorder_threshold, reorder_quantity, primary_supplier_id,
              default_lead_time_days, shelf_life_days, active
         FROM products WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(input.productId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error(`product ${input.productId} not found`);
  if (existing['active'] === 0) throw new Error('product is inactive — reactivate first');

  if (input.fields.category && !VALID_CATEGORIES.has(input.fields.category)) {
    throw new Error(`invalid category '${input.fields.category}'`);
  }

  // Build SET clause dynamically — only update specified fields.
  const colMap: Record<string, string> = {
    name: 'name', category: 'category', brand: 'brand',
    packSizeUnits: 'pack_size_units', unitVolumeMl: 'unit_volume_ml',
    isReturnable: 'is_returnable', bottleDepositPesewas: 'bottle_deposit_pesewas',
    costPricePesewas: 'cost_price_pesewas',
    walkInPricePesewas: 'walk_in_price_pesewas',
    wholesalePricePesewas: 'wholesale_price_pesewas',
    routePricePesewas: 'route_price_pesewas',
    reorderThreshold: 'reorder_threshold', reorderQuantity: 'reorder_quantity',
    countClass: 'count_class',
    primarySupplierId: 'primary_supplier_id',
    defaultLeadTimeDays: 'default_lead_time_days',
    shelfLifeDays: 'shelf_life_days', barcode: 'barcode',
  };
  const setParts: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(input.fields) as Array<[keyof typeof colMap, unknown]>) {
    const col = colMap[key];
    if (!col) continue;
    let value = val;
    // Booleans -> 0/1 for SQLite
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (typeof value === 'number' && (key.endsWith('Pesewas') || key === 'reorderThreshold' || key === 'reorderQuantity' || key === 'packSizeUnits')) {
      if (!Number.isInteger(value) || (value < 0 && key !== 'unitVolumeMl')) {
        throw new Error(`${key} must be a non-negative integer`);
      }
    }
    setParts.push(`${col} = ?`);
    params.push(value);
    before[key] = existing[col];
    after[key] = value;
  }
  if (setParts.length === 0) return { warnings: [] };

  setParts.push(`updated_at = ?`);
  setParts.push(`updated_by = ?`);
  params.push(new Date().toISOString());
  params.push(input.actorWorkerId);
  params.push(input.productId);

  db.prepare(`UPDATE products SET ${setParts.join(', ')} WHERE id = ?`).run(...params);

  // Recompute warnings for the post-update state.
  const post = db
    .prepare('SELECT cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas FROM products WHERE id = ?')
    .get(input.productId) as { cost_price_pesewas: number; walk_in_price_pesewas: number; wholesale_price_pesewas: number; route_price_pesewas: number };
  const warnings: string[] = [];
  if (post.walk_in_price_pesewas < post.cost_price_pesewas) warnings.push('walk-in price below cost');
  if (post.wholesale_price_pesewas < post.cost_price_pesewas) warnings.push('wholesale price below cost');
  if (post.route_price_pesewas < post.cost_price_pesewas) warnings.push('route price below cost');

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PRODUCT_UPDATED',
    entityType: 'products',
    entityId: input.productId,
    beforeValue: before,
    afterValue: after,
    deviceId: input.deviceId,
  });

  return { warnings };
}

export function deactivateProduct(
  db: DB, productId: string, actorId: string, deviceId: string,
): void {
  requireAdmin(db, actorId);
  const w = db.prepare('SELECT active FROM products WHERE id = ? AND deleted_at IS NULL').get(productId) as { active: number } | undefined;
  if (!w) throw new Error(`product ${productId} not found`);
  if (w.active === 0) throw new Error('product already inactive');
  db.prepare('UPDATE products SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?').run(new Date().toISOString(), actorId, productId);
  logAudit(db, {
    workerId: actorId, action: 'PRODUCT_DEACTIVATED',
    entityType: 'products', entityId: productId, deviceId,
  });
}

export function reactivateProduct(
  db: DB, productId: string, actorId: string, deviceId: string,
): void {
  requireAdmin(db, actorId);
  const w = db.prepare('SELECT active FROM products WHERE id = ? AND deleted_at IS NULL').get(productId) as { active: number } | undefined;
  if (!w) throw new Error(`product ${productId} not found`);
  if (w.active === 1) throw new Error('product already active');
  db.prepare('UPDATE products SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?').run(new Date().toISOString(), actorId, productId);
  logAudit(db, {
    workerId: actorId, action: 'PRODUCT_REACTIVATED',
    entityType: 'products', entityId: productId, deviceId,
  });
}

export interface AdminProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category: string;
  brand: string | null;
  packSizeUnits: number;
  unitVolumeMl: number | null;
  isReturnable: boolean;
  bottleDepositPesewas: number;
  costPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold: number;
  reorderQuantity: number;
  primarySupplierId: string | null;
  defaultLeadTimeDays: number;
  shelfLifeDays: number | null;
  countClass: 'A' | 'B' | 'C' | null;
  active: boolean;
  unitsOnHand: number;
}

export function listProductsForAdmin(db: DB, locationId: string): AdminProduct[] {
  const rows = db
    .prepare(
      `SELECT id, sku, barcode, name, category, brand, pack_size_units AS packSizeUnits,
              unit_volume_ml AS unitVolumeMl, is_returnable AS isReturnable,
              bottle_deposit_pesewas AS bottleDepositPesewas,
              cost_price_pesewas AS costPricePesewas,
              walk_in_price_pesewas AS walkInPricePesewas,
              wholesale_price_pesewas AS wholesalePricePesewas,
              route_price_pesewas AS routePricePesewas,
              reorder_threshold AS reorderThreshold,
              reorder_quantity AS reorderQuantity,
              primary_supplier_id AS primarySupplierId,
              default_lead_time_days AS defaultLeadTimeDays,
              shelf_life_days AS shelfLifeDays,
              count_class AS countClass,
              active
         FROM products
         WHERE deleted_at IS NULL
         ORDER BY active DESC, name ASC`,
    )
    .all() as Array<Omit<AdminProduct, 'active' | 'isReturnable' | 'unitsOnHand'> & { active: number; isReturnable: number }>;
  return rows.map((r) => {
    const stockRow = db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS u FROM stock_movements WHERE product_id = ? AND location_id = ?')
      .get(r.id, locationId) as { u: number };
    return {
      ...r,
      active: r.active === 1,
      isReturnable: r.isReturnable === 1,
      unitsOnHand: stockRow.u,
    };
  });
}
