// Volume-based pricing tiers. OWNER/FOUNDER only for write operations.
// bestTierFor() is the hot path — it's called by the renderer every time a
// cart line's quantity changes, AND by completeSale on the server side.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';

const ADMIN_ROLES = new Set(['OWNER', 'FOUNDER']);
const VALID_CHANNELS = new Set(['WALK_IN', 'WHOLESALE', 'ROUTE', 'ALL']);

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

export type PricingChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | 'ALL';

export interface PricingTier {
  id: string;
  productId: string;
  channel: PricingChannel;
  minQuantity: number;
  unitPricePesewas: number;
  priority: number;
  active: boolean;
  notes: string | null;
  /** If non-null, this tier only applies when the line is sold in this unit. */
  appliesToUnitId: string | null;
}

export interface AddTierInput {
  productId: string;
  channel: PricingChannel;
  minQuantity: number;
  unitPricePesewas: number;
  priority?: number;
  notes?: string | null;
  /** Optional: scope this tier to one specific sellable unit. */
  appliesToUnitId?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export function addTier(db: DB, input: AddTierInput): { tierId: string } {
  requireAdmin(db, input.actorWorkerId);
  if (!VALID_CHANNELS.has(input.channel)) throw new Error(`invalid channel '${input.channel}'`);
  if (!Number.isInteger(input.minQuantity) || input.minQuantity <= 0) {
    throw new Error('minQuantity must be a positive integer');
  }
  if (!Number.isInteger(input.unitPricePesewas) || input.unitPricePesewas < 0) {
    throw new Error('unitPricePesewas must be a non-negative integer');
  }

  const product = db
    .prepare('SELECT id FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL')
    .get(input.productId);
  if (!product) throw new Error(`product ${input.productId} not found or inactive`);

  // UNIQUE constraint catches dupes, but give a clearer message.
  const dup = db
    .prepare(
      'SELECT id FROM pricing_tiers WHERE product_id = ? AND channel = ? AND min_quantity = ?',
    )
    .get(input.productId, input.channel, input.minQuantity);
  if (dup) {
    throw new Error(
      `tier already exists for ${input.channel} at min_qty ${input.minQuantity}; update or deactivate it instead`,
    );
  }

  const id = `pt-${uuidv4()}`;
  db.prepare(
    `INSERT INTO pricing_tiers (
      id, product_id, channel, min_quantity, unit_price_pesewas, priority, notes,
      applies_to_unit_id,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.productId,
    input.channel,
    input.minQuantity,
    input.unitPricePesewas,
    input.priority ?? 0,
    input.notes ?? null,
    input.appliesToUnitId ?? null,
    input.actorWorkerId,
    input.actorWorkerId,
    input.deviceId,
  );

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PRICING_TIER_ADDED',
    entityType: 'pricing_tiers',
    entityId: id,
    afterValue: {
      productId: input.productId, channel: input.channel,
      minQuantity: input.minQuantity, unitPricePesewas: input.unitPricePesewas,
      appliesToUnitId: input.appliesToUnitId ?? null,
    },
    deviceId: input.deviceId,
  });
  return { tierId: id };
}

export interface UpdateTierInput {
  tierId: string;
  fields: Partial<{ unitPricePesewas: number; priority: number; notes: string | null }>;
  actorWorkerId: string;
  deviceId: string;
}

export function updateTier(db: DB, input: UpdateTierInput): void {
  requireAdmin(db, input.actorWorkerId);
  const existing = db
    .prepare('SELECT unit_price_pesewas, priority, notes FROM pricing_tiers WHERE id = ?')
    .get(input.tierId) as
    | { unit_price_pesewas: number; priority: number; notes: string | null }
    | undefined;
  if (!existing) throw new Error(`tier ${input.tierId} not found`);

  const colMap: Record<string, string> = {
    unitPricePesewas: 'unit_price_pesewas',
    priority: 'priority',
    notes: 'notes',
  };
  const setParts: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input.fields) as Array<[keyof typeof colMap, unknown]>) {
    const col = colMap[key];
    if (!col) continue;
    if (key === 'unitPricePesewas' && (typeof val !== 'number' || !Number.isInteger(val) || val < 0)) {
      throw new Error('unitPricePesewas must be a non-negative integer');
    }
    setParts.push(`${col} = ?`);
    params.push(val);
    before[key] = existing[col as keyof typeof existing];
    after[key] = val;
  }
  if (setParts.length === 0) return;
  setParts.push('updated_at = ?', 'updated_by = ?');
  params.push(new Date().toISOString(), input.actorWorkerId, input.tierId);
  db.prepare(`UPDATE pricing_tiers SET ${setParts.join(', ')} WHERE id = ?`).run(...params);
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PRICING_TIER_UPDATED',
    entityType: 'pricing_tiers',
    entityId: input.tierId,
    beforeValue: before, afterValue: after,
    deviceId: input.deviceId,
  });
}

export function deactivateTier(db: DB, tierId: string, actorId: string, deviceId: string): void {
  requireAdmin(db, actorId);
  const t = db.prepare('SELECT active FROM pricing_tiers WHERE id = ?').get(tierId) as { active: number } | undefined;
  if (!t) throw new Error(`tier ${tierId} not found`);
  if (t.active === 0) throw new Error('tier already inactive');
  db.prepare('UPDATE pricing_tiers SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(new Date().toISOString(), actorId, tierId);
  logAudit(db, {
    workerId: actorId, action: 'PRICING_TIER_DEACTIVATED',
    entityType: 'pricing_tiers', entityId: tierId, deviceId,
  });
}

export function reactivateTier(db: DB, tierId: string, actorId: string, deviceId: string): void {
  requireAdmin(db, actorId);
  const t = db.prepare('SELECT active FROM pricing_tiers WHERE id = ?').get(tierId) as { active: number } | undefined;
  if (!t) throw new Error(`tier ${tierId} not found`);
  if (t.active === 1) throw new Error('tier already active');
  db.prepare('UPDATE pricing_tiers SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(new Date().toISOString(), actorId, tierId);
  logAudit(db, {
    workerId: actorId, action: 'PRICING_TIER_REACTIVATED',
    entityType: 'pricing_tiers', entityId: tierId, deviceId,
  });
}

export function listTiersForProduct(db: DB, productId: string): PricingTier[] {
  const rows = db
    .prepare(
      `SELECT id, product_id AS productId, channel, min_quantity AS minQuantity,
              unit_price_pesewas AS unitPricePesewas, priority, active, notes,
              applies_to_unit_id AS appliesToUnitId
         FROM pricing_tiers
         WHERE product_id = ?
         ORDER BY channel ASC, min_quantity ASC`,
    )
    .all(productId) as Array<Omit<PricingTier, 'active'> & { active: number }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}

/**
 * Find the best applicable tier for (product, channel, quantity, optional unit).
 * Preference order:
 *   - unit-specific tier beats unit-agnostic (NULL applies_to_unit_id)
 *   - exact channel match beats ALL channel
 *   - higher min_quantity that the qty meets
 *   - higher priority, then most recently created
 *
 * If unitId is omitted, only tiers with NULL applies_to_unit_id are considered
 * (legacy / canonical-only sales). If unitId is provided, tiers targeting that
 * unit OR tiers with NULL applies_to_unit_id are considered.
 */
export function bestTierFor(
  db: DB, productId: string, channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE', quantity: number,
  unitId?: string | null,
): PricingTier | null {
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  const row = db
    .prepare(
      `SELECT id, product_id AS productId, channel, min_quantity AS minQuantity,
              unit_price_pesewas AS unitPricePesewas, priority, active, notes,
              applies_to_unit_id AS appliesToUnitId
         FROM pricing_tiers
         WHERE product_id = ?
           AND active = 1
           AND (channel = ? OR channel = 'ALL')
           AND min_quantity <= ?
           AND (applies_to_unit_id IS NULL OR applies_to_unit_id = ?)
         ORDER BY
           CASE WHEN applies_to_unit_id IS NOT NULL THEN 0 ELSE 1 END,  -- unit-specific beats unit-agnostic
           CASE WHEN channel = ? THEN 0 ELSE 1 END,                      -- exact channel beats ALL
           min_quantity DESC,
           priority DESC,
           created_at DESC
         LIMIT 1`,
    )
    .get(productId, channel, quantity, unitId ?? null, channel) as
    | (Omit<PricingTier, 'active'> & { active: number })
    | undefined;
  if (!row) return null;
  return { ...row, active: row.active === 1 };
}
