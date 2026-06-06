// product_units: how a product can be sold / purchased in different sizes.
// Each unit has an integer conversion_factor relating it to the product's
// canonical unit. Stock movements live in canonical units; this layer
// converts the worker's input at the boundary.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';

const ADMIN_ROLES = new Set(['OWNER', 'FOUNDER']);

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

export interface ProductUnit {
  id: string;
  productId: string;
  unitName: string;
  conversionFactor: number;
  pricePesewas: number;
  isPurchaseUnit: boolean;
  isSaleUnit: boolean;
  displayOrder: number;
  active: boolean;
  notes: string | null;
}

export interface AddUnitInput {
  productId: string;
  unitName: string;
  conversionFactor: number;
  pricePesewas: number;
  isPurchaseUnit?: boolean;
  isSaleUnit?: boolean;
  displayOrder?: number;
  notes?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export function addUnit(db: DB, input: AddUnitInput): { unitId: string } {
  requireAdmin(db, input.actorWorkerId);
  if (!input.unitName.trim()) throw new Error('unitName required');
  if (!Number.isInteger(input.conversionFactor) || input.conversionFactor <= 0) {
    throw new Error('conversionFactor must be a positive integer');
  }
  if (!Number.isInteger(input.pricePesewas) || input.pricePesewas < 0) {
    throw new Error('pricePesewas must be a non-negative integer');
  }
  if (input.isSaleUnit === false && input.isPurchaseUnit === false) {
    throw new Error('a unit must be sellable, purchasable, or both');
  }

  const product = db
    .prepare('SELECT id FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL')
    .get(input.productId);
  if (!product) throw new Error(`product ${input.productId} not found or inactive`);

  const dup = db
    .prepare('SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?')
    .get(input.productId, input.unitName.trim());
  if (dup) throw new Error(`unit '${input.unitName.trim()}' already exists for this product`);

  const id = `pu-${uuidv4()}`;
  db.prepare(
    `INSERT INTO product_units (
      id, product_id, unit_name, conversion_factor, price_pesewas,
      is_purchase_unit, is_sale_unit, display_order, notes,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.productId,
    input.unitName.trim(),
    input.conversionFactor,
    input.pricePesewas,
    input.isPurchaseUnit === false ? 0 : 1,
    input.isSaleUnit === false ? 0 : 1,
    input.displayOrder ?? 0,
    input.notes ?? null,
    input.actorWorkerId,
    input.actorWorkerId,
    input.deviceId,
  );

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PRODUCT_UNIT_ADDED',
    entityType: 'product_units',
    entityId: id,
    afterValue: {
      productId: input.productId,
      unitName: input.unitName,
      conversionFactor: input.conversionFactor,
      pricePesewas: input.pricePesewas,
    },
    deviceId: input.deviceId,
  });
  return { unitId: id };
}

export interface UpdateUnitInput {
  unitId: string;
  fields: Partial<{
    pricePesewas: number;
    isPurchaseUnit: boolean;
    isSaleUnit: boolean;
    displayOrder: number;
    notes: string | null;
  }>;
  actorWorkerId: string;
  deviceId: string;
}

export function updateUnit(db: DB, input: UpdateUnitInput): void {
  requireAdmin(db, input.actorWorkerId);
  const existing = db
    .prepare(
      `SELECT price_pesewas, is_purchase_unit, is_sale_unit, display_order, notes
         FROM product_units WHERE id = ?`,
    )
    .get(input.unitId) as
    | { price_pesewas: number; is_purchase_unit: number; is_sale_unit: number; display_order: number; notes: string | null }
    | undefined;
  if (!existing) throw new Error(`unit ${input.unitId} not found`);

  const colMap: Record<string, string> = {
    pricePesewas: 'price_pesewas',
    isPurchaseUnit: 'is_purchase_unit',
    isSaleUnit: 'is_sale_unit',
    displayOrder: 'display_order',
    notes: 'notes',
  };
  const setParts: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input.fields) as Array<[keyof typeof colMap, unknown]>) {
    const col = colMap[key];
    if (!col) continue;
    let value: unknown = raw;
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (key === 'pricePesewas') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('pricePesewas must be a non-negative integer');
      }
    }
    setParts.push(`${col} = ?`);
    params.push(value);
    before[key] = existing[col as keyof typeof existing];
    after[key] = value;
  }
  if (setParts.length === 0) return;
  setParts.push('updated_at = ?', 'updated_by = ?');
  params.push(new Date().toISOString(), input.actorWorkerId, input.unitId);
  db.prepare(`UPDATE product_units SET ${setParts.join(', ')} WHERE id = ?`).run(...params);
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PRODUCT_UNIT_UPDATED',
    entityType: 'product_units',
    entityId: input.unitId,
    beforeValue: before, afterValue: after,
    deviceId: input.deviceId,
  });
}

export function deactivateUnit(db: DB, unitId: string, actorId: string, deviceId: string): void {
  requireAdmin(db, actorId);
  const u = db.prepare('SELECT active FROM product_units WHERE id = ?').get(unitId) as { active: number } | undefined;
  if (!u) throw new Error(`unit ${unitId} not found`);
  if (u.active === 0) throw new Error('unit already inactive');
  db.prepare('UPDATE product_units SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(new Date().toISOString(), actorId, unitId);
  logAudit(db, {
    workerId: actorId, action: 'PRODUCT_UNIT_DEACTIVATED',
    entityType: 'product_units', entityId: unitId, deviceId,
  });
}

export function reactivateUnit(db: DB, unitId: string, actorId: string, deviceId: string): void {
  requireAdmin(db, actorId);
  const u = db.prepare('SELECT active FROM product_units WHERE id = ?').get(unitId) as { active: number } | undefined;
  if (!u) throw new Error(`unit ${unitId} not found`);
  if (u.active === 1) throw new Error('unit already active');
  db.prepare('UPDATE product_units SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(new Date().toISOString(), actorId, unitId);
  logAudit(db, {
    workerId: actorId, action: 'PRODUCT_UNIT_REACTIVATED',
    entityType: 'product_units', entityId: unitId, deviceId,
  });
}

export function listUnitsForProduct(db: DB, productId: string, opts: { activeOnly?: boolean } = {}): ProductUnit[] {
  const where = opts.activeOnly ? 'WHERE product_id = ? AND active = 1' : 'WHERE product_id = ?';
  const rows = db
    .prepare(
      `SELECT id, product_id AS productId, unit_name AS unitName,
              conversion_factor AS conversionFactor, price_pesewas AS pricePesewas,
              is_purchase_unit AS isPurchaseUnit, is_sale_unit AS isSaleUnit,
              display_order AS displayOrder, active, notes
         FROM product_units ${where}
         ORDER BY display_order ASC, conversion_factor ASC`,
    )
    .all(productId) as Array<Omit<ProductUnit, 'isPurchaseUnit' | 'isSaleUnit' | 'active'> & {
      isPurchaseUnit: number; isSaleUnit: number; active: number;
    }>;
  return rows.map((r) => ({
    ...r,
    isPurchaseUnit: r.isPurchaseUnit === 1,
    isSaleUnit: r.isSaleUnit === 1,
    active: r.active === 1,
  }));
}

export function getUnit(db: DB, unitId: string): ProductUnit | null {
  const r = db
    .prepare(
      `SELECT id, product_id AS productId, unit_name AS unitName,
              conversion_factor AS conversionFactor, price_pesewas AS pricePesewas,
              is_purchase_unit AS isPurchaseUnit, is_sale_unit AS isSaleUnit,
              display_order AS displayOrder, active, notes
         FROM product_units WHERE id = ?`,
    )
    .get(unitId) as
    | (Omit<ProductUnit, 'isPurchaseUnit' | 'isSaleUnit' | 'active'> & {
        isPurchaseUnit: number; isSaleUnit: number; active: number;
      })
    | undefined;
  if (!r) return null;
  return { ...r, isPurchaseUnit: r.isPurchaseUnit === 1, isSaleUnit: r.isSaleUnit === 1, active: r.active === 1 };
}

/**
 * Default sale unit for a product: the smallest active sellable unit.
 * Used by completeSale when the caller doesn't specify a unit (legacy
 * compat with one-unit products like the dev fixtures).
 */
export function defaultSaleUnit(db: DB, productId: string): ProductUnit | null {
  type RawUnit = Omit<ProductUnit, 'isPurchaseUnit' | 'isSaleUnit' | 'active'> & {
    isPurchaseUnit: number; isSaleUnit: number; active: number;
  };
  const cols = `id, product_id AS productId, unit_name AS unitName,
              conversion_factor AS conversionFactor, price_pesewas AS pricePesewas,
              is_purchase_unit AS isPurchaseUnit, is_sale_unit AS isSaleUnit,
              display_order AS displayOrder, active, notes`;

  // Honor the operator's "Default at the till" choice
  // (products.primary_sale_unit_id) when it still points at an active, sellable
  // unit. Otherwise fall back to the smallest active sellable unit (legacy
  // compat for one-unit products like the dev fixtures).
  const primary = db
    .prepare(
      `SELECT ${cols} FROM product_units
         WHERE product_id = ? AND active = 1 AND is_sale_unit = 1
           AND id = (SELECT primary_sale_unit_id FROM products WHERE id = ?)`,
    )
    .get(productId, productId) as RawUnit | undefined;

  const r = primary ?? (db
    .prepare(
      `SELECT ${cols} FROM product_units
         WHERE product_id = ? AND active = 1 AND is_sale_unit = 1
         ORDER BY conversion_factor ASC, display_order ASC
         LIMIT 1`,
    )
    .get(productId) as RawUnit | undefined);

  if (!r) return null;
  return { ...r, isPurchaseUnit: r.isPurchaseUnit === 1, isSaleUnit: r.isSaleUnit === 1, active: r.active === 1 };
}

/**
 * Compute the per-unit sale price for a (product, unit, channel) triple.
 *
 * The price stored on a product_units row is the WALK-IN baseline. For
 * wholesale / route, we scale that baseline by the product's channel-vs-
 * walk-in canonical-price ratio so that:
 *   - a unit at factor=1 ends up at exactly the channel's canonical price
 *   - a non-canonical unit with an explicit bulk-discount price (e.g. PACK
 *     at ₵55 when 12×walk-in would be ₵60) keeps that discount
 *     proportionally when switching to a cheaper channel
 *
 * Returns an integer pesewas value rounded HALF-AWAY-FROM-ZERO. Never negative.
 */
export function priceForUnit(
  db: DB,
  productId: string,
  unitId: string | null,
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE',
): number {
  const p = db
    .prepare(
      `SELECT walk_in_price_pesewas    AS walkIn,
              wholesale_price_pesewas  AS wholesale,
              route_price_pesewas      AS route
         FROM products
         WHERE id = ?`,
    )
    .get(productId) as { walkIn: number; wholesale: number; route: number } | undefined;
  if (!p) throw new Error(`priceForUnit: product ${productId} not found`);

  const channelCanonical =
    channel === 'WHOLESALE' ? p.wholesale
    : channel === 'ROUTE'   ? p.route
    : p.walkIn;

  if (!unitId) {
    // Canonical (no explicit unit). Channel price IS the unit price.
    return channelCanonical;
  }

  const u = getUnit(db, unitId);
  if (!u) throw new Error(`priceForUnit: unit ${unitId} not found`);

  if (channel === 'WALK_IN') return u.pricePesewas;
  // Avoid div-by-zero on a free walk-in product.
  if (p.walkIn <= 0) return u.pricePesewas;
  const scaled = (u.pricePesewas * channelCanonical) / p.walkIn;
  return Math.max(0, Math.round(scaled));
}

/** Convert a quantity in `unitId`'s units into canonical units. */
export function convertToCanonical(db: DB, unitId: string, qtyInUnit: number): number {
  if (!Number.isInteger(qtyInUnit) || qtyInUnit <= 0) {
    throw new Error('qtyInUnit must be a positive integer');
  }
  const u = getUnit(db, unitId);
  if (!u) throw new Error(`unit ${unitId} not found`);
  if (!u.active) throw new Error(`unit ${unitId} is inactive`);
  return qtyInUnit * u.conversionFactor;
}
