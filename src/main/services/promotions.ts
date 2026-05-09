// promotions.ts — Wave D bonus-unit promotions ("buy 5 get 1 free").
//
// Three responsibilities:
//   1. CRUD for the promotions table (admin UI).
//   2. computeBonusLines: given a sale's regular lines + channel,
//      figure out which bonus lines to add. Pure / read-only — the sale
//      service calls this and inserts the resulting bonus rows.
//   3. listPromotionsForProduct: lookup helper for the sale screen UI badge.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';

type DB = Database;
export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface PromotionRow {
  id: string;
  productId: string;
  productName: string;
  appliesToUnitId: string | null;
  unitName: string | null;
  channel: SaleChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
  validFrom: string | null;
  validTo: string | null;
  supplierId: string | null;
  active: boolean;
  notes: string | null;
}

interface ActivePromo {
  id: string;
  productId: string;
  appliesToUnitId: string | null;
  channel: SaleChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
}

/** All currently-valid promotions matching (product, unit, channel). */
function findActivePromosFor(
  db: DB,
  productId: string,
  unitId: string | null,
  channel: SaleChannel,
  todayISO: string,
): ActivePromo[] {
  return db
    .prepare(
      `SELECT id, product_id AS productId, applies_to_unit_id AS appliesToUnitId,
              channel, qty_buy AS qtyBuy, qty_get_free AS qtyGetFree
         FROM promotions
        WHERE active = 1
          AND product_id = ?
          AND (channel IS NULL OR channel = ?)
          AND (applies_to_unit_id IS NULL OR applies_to_unit_id = ?)
          AND (valid_from IS NULL OR valid_from <= ?)
          AND (valid_to IS NULL OR valid_to >= ?)
        ORDER BY qty_buy DESC`,
    )
    .all(productId, channel, unitId, todayISO, todayISO) as ActivePromo[];
}

export interface ResolvedBonus {
  productId: string;
  unitId: string | null;
  /** Display-unit qty of free product to add as a BONUS sale line. */
  bonusQty: number;
  /** The promotion that fired. */
  promotionId: string;
}

/**
 * For each regular line, decide whether a bonus line should be added.
 * Greedy on the highest qty_buy threshold (so a 12-buy promo beats a
 * 6-buy promo when qty=24 — gives 2 free, not 4).
 *
 * Returns one ResolvedBonus per line that triggers; lines that don't
 * trigger any promo aren't returned.
 *
 * Note: bonusQty is in display units, matching the line's display unit.
 * The sale service converts to canonical when posting stock movements.
 */
export function computeBonusLines(
  db: DB,
  channel: SaleChannel,
  lines: Array<{ productId: string; unitId: string | null; quantity: number }>,
  now = new Date(),
): ResolvedBonus[] {
  const today = now.toISOString().slice(0, 10);
  const bonuses: ResolvedBonus[] = [];

  for (const l of lines) {
    if (l.quantity <= 0) continue;
    const promos = findActivePromosFor(db, l.productId, l.unitId, channel, today);
    if (promos.length === 0) continue;

    // Greedy: try the largest qty_buy first; if it divides l.quantity
    // evenly OR fits at least once, use it. Otherwise step down.
    let chosen: ActivePromo | null = null;
    let multiplier = 0;
    for (const p of promos) {
      const m = Math.floor(l.quantity / p.qtyBuy);
      if (m > 0) {
        chosen = p;
        multiplier = m;
        break;
      }
    }
    if (!chosen || multiplier === 0) continue;

    bonuses.push({
      productId: l.productId,
      unitId: chosen.appliesToUnitId ?? l.unitId,
      bonusQty: multiplier * chosen.qtyGetFree,
      promotionId: chosen.id,
    });
  }
  return bonuses;
}

// --- Admin CRUD -----------------------------------------------------------

export interface AddPromotionInput {
  productId: string;
  appliesToUnitId?: string | null;
  channel?: SaleChannel | null;
  qtyBuy: number;
  qtyGetFree: number;
  validFrom?: string | null;
  validTo?: string | null;
  supplierId?: string | null;
  notes?: string | null;
  workerId: string;
  deviceId: string;
}

export function addPromotion(db: DB, input: AddPromotionInput): { id: string } {
  if (!Number.isInteger(input.qtyBuy) || input.qtyBuy <= 0) {
    throw new Error('addPromotion: qtyBuy must be a positive integer');
  }
  if (!Number.isInteger(input.qtyGetFree) || input.qtyGetFree <= 0) {
    throw new Error('addPromotion: qtyGetFree must be a positive integer');
  }
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    throw new Error('addPromotion: validFrom must be on or before validTo');
  }
  const id = `promo-${uuidv4()}`;
  db.prepare(
    `INSERT INTO promotions
       (id, product_id, applies_to_unit_id, channel, qty_buy, qty_get_free,
        valid_from, valid_to, supplier_id, active, notes,
        created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id, input.productId, input.appliesToUnitId ?? null, input.channel ?? null,
    input.qtyBuy, input.qtyGetFree,
    input.validFrom ?? null, input.validTo ?? null,
    input.supplierId ?? null, input.notes ?? null,
    input.workerId, input.workerId, input.deviceId,
  );
  return { id };
}

export function deactivatePromotion(db: DB, id: string, workerId: string): void {
  const r = db.prepare(
    `UPDATE promotions SET active = 0,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_by = ?
      WHERE id = ? AND active = 1`,
  ).run(workerId, id);
  if (r.changes === 0) throw new Error(`deactivatePromotion: ${id} not found or already inactive`);
}

export function listActivePromotions(db: DB): PromotionRow[] {
  return db
    .prepare(
      `SELECT p.id, p.product_id AS productId, prod.name AS productName,
              p.applies_to_unit_id AS appliesToUnitId, pu.unit_name AS unitName,
              p.channel, p.qty_buy AS qtyBuy, p.qty_get_free AS qtyGetFree,
              p.valid_from AS validFrom, p.valid_to AS validTo,
              p.supplier_id AS supplierId, p.active, p.notes
         FROM promotions p
         JOIN products prod ON prod.id = p.product_id
         LEFT JOIN product_units pu ON pu.id = p.applies_to_unit_id
        WHERE p.active = 1
        ORDER BY prod.name ASC, p.qty_buy DESC`,
    )
    .all()
    .map((r: any) => ({ ...r, active: !!r.active })) as PromotionRow[];
}

/** Bonus-unit COGS reporting helper for the daily summary.
 *  Returns rows grouped by supplier so dad can claim rebates.
 */
export function bonusUnitsByDay(
  db: DB, dateISO: string,
): Array<{ supplierId: string | null; supplierName: string | null;
           costPesewas: number; bonusUnits: number }> {
  return db
    .prepare(
      `SELECT prom.supplier_id AS supplierId, sup.name AS supplierName,
              COALESCE(SUM(sl.unit_cost_pesewas * sl.quantity), 0) AS costPesewas,
              COALESCE(SUM(sl.quantity), 0) AS bonusUnits
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         LEFT JOIN promotions prom ON prom.id = sl.applied_promotion_id
         LEFT JOIN suppliers sup ON sup.id = prom.supplier_id
        WHERE sl.kind = 'BONUS' AND s.voided = 0
          AND substr(s.created_at, 1, 10) = ?
        GROUP BY prom.supplier_id, sup.name
        ORDER BY costPesewas DESC`,
    )
    .all(dateISO) as Array<{
      supplierId: string | null; supplierName: string | null;
      costPesewas: number; bonusUnits: number;
    }>;
}
