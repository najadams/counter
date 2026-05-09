// Physical stocktake: parent event groups per-product counts; on complete,
// each non-zero-variance line emits a STOCKTAKE_VARIANCE_LOSS (counted <
// expected) or STOCK_FOUND (counted > expected) stock_movement.
//
// The completed event's totals are what daily_summaries reads to compute
// the corrected shrinkage rate (pushback fix #2).

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { insertStockMovement, unitsOnHand } from './stockMovements.js';
import { getUnit } from './productUnits.js';
import { verifyPin } from './workers.js';

const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

export interface StocktakeEventSummary {
  id: string;
  status: 'DRAFT' | 'COMPLETED' | 'CANCELLED';
  startedAt: string;
  completedAt: string | null;
  productsCounted: number;
  productsWithVariance: number;
  totalLossValuePesewas: number;
  totalFoundValuePesewas: number;
  totalExpectedStockValuePesewas: number;
  shrinkageRate: number | null;
  notes: string | null;
}

export interface StocktakeLineRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  expectedQty: number;
  countedQty: number | null;
  variance: number | null;
  unitCostPesewas: number;
  varianceValuePesewas: number | null;
}

/**
 * Start a new stocktake. Snapshots expected qty + cost for every active product.
 * Refuses if a DRAFT already exists at the location.
 */
export function startStocktake(
  db: DB,
  input: {
    locationId: string;
    workerId: string;
    deviceId: string;
    /** Optional cycle-counting filter. When set, only products with this
     *  count_class are snapshotted. NULL/missing = full stocktake. */
    countClass?: 'A' | 'B' | 'C' | null;
  },
): { eventId: string; productCount: number } {
  const existing = db
    .prepare(
      `SELECT id FROM stocktake_events
         WHERE location_id = ? AND status = 'DRAFT' LIMIT 1`,
    )
    .get(input.locationId) as { id: string } | undefined;
  if (existing) {
    throw new Error(
      `startStocktake: a DRAFT stocktake already exists for this location (${existing.id}). Complete or cancel it first.`,
    );
  }

  const params: unknown[] = [];
  let where = `active = 1 AND deleted_at IS NULL`;
  if (input.countClass) {
    where += ` AND count_class = ?`;
    params.push(input.countClass);
  }
  const products = db
    .prepare(
      `SELECT id, cost_price_pesewas FROM products
         WHERE ${where}
         ORDER BY name ASC`,
    )
    .all(...params) as Array<{ id: string; cost_price_pesewas: number }>;
  if (products.length === 0) {
    throw new Error(
      input.countClass
        ? `startStocktake: no active products in class ${input.countClass}`
        : 'startStocktake: no active products to count',
    );
  }

  const eventId = `st-${uuidv4()}`;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO stocktake_events (
         id, location_id, status, started_by, started_at,
         created_by, updated_by, device_id
       ) VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    ).run(eventId, input.locationId, input.workerId, now, input.workerId, input.workerId, input.deviceId);

    let totalExpectedValue = 0;
    for (const p of products) {
      const expected = unitsOnHand(db, p.id, input.locationId);
      const lineId = `stl-${uuidv4()}`;
      db.prepare(
        `INSERT INTO stocktake_lines (
           id, stocktake_event_id, product_id, expected_qty, unit_cost_pesewas,
           created_by, updated_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(lineId, eventId, p.id, expected, p.cost_price_pesewas, input.workerId, input.workerId, input.deviceId);
      totalExpectedValue += Math.max(0, expected) * p.cost_price_pesewas;
    }

    db.prepare(
      `UPDATE stocktake_events
          SET total_expected_stock_value_pesewas = ?, updated_at = ?
          WHERE id = ?`,
    ).run(totalExpectedValue, now, eventId);

    logAudit(db, {
      workerId: input.workerId,
      action: 'STOCKTAKE_STARTED',
      entityType: 'stocktake_events',
      entityId: eventId,
      afterValue: { locationId: input.locationId, productCount: products.length, totalExpectedStockValuePesewas: totalExpectedValue },
      deviceId: input.deviceId,
    });
  });

  tx();

  return { eventId, productCount: products.length };
}

/**
 * Update one line's counted qty and variance.
 *
 * The worker can count in any unit (BOTTLE, CRATE, ML…). If unitId is
 * provided, the entered quantity is multiplied by the unit's conversion
 * factor to get canonical units before comparing against expected.
 *
 * If unitId is omitted, countedQty is treated as canonical.
 */
export function recordStocktakeCount(
  db: DB,
  eventId: string,
  productId: string,
  countedQty: number,
  workerId: string,
  deviceId: string,
  unitId?: string | null,
): { variance: number; varianceValuePesewas: number; canonicalCount: number } {
  if (!Number.isInteger(countedQty) || countedQty < 0) {
    throw new Error('recordStocktakeCount: countedQty must be a non-negative integer');
  }
  let factor = 1;
  if (unitId) {
    const u = getUnit(db, unitId);
    if (!u) throw new Error(`recordStocktakeCount: unit ${unitId} not found`);
    if (u.productId !== productId) {
      throw new Error(`recordStocktakeCount: unit ${unitId} does not belong to product ${productId}`);
    }
    factor = u.conversionFactor;
  }
  const canonicalCount = countedQty * factor;

  const event = db
    .prepare('SELECT id, status FROM stocktake_events WHERE id = ?')
    .get(eventId) as { id: string; status: string } | undefined;
  if (!event) throw new Error(`recordStocktakeCount: event ${eventId} not found`);
  if (event.status !== 'DRAFT') {
    throw new Error(`recordStocktakeCount: event is ${event.status}, can only record on DRAFT`);
  }

  const line = db
    .prepare(
      `SELECT id, expected_qty, unit_cost_pesewas
         FROM stocktake_lines
         WHERE stocktake_event_id = ? AND product_id = ?`,
    )
    .get(eventId, productId) as
    | { id: string; expected_qty: number; unit_cost_pesewas: number }
    | undefined;
  if (!line) {
    throw new Error(`recordStocktakeCount: line for product ${productId} not in this event`);
  }

  const variance = canonicalCount - line.expected_qty;
  const varianceValue = variance * line.unit_cost_pesewas;

  db.prepare(
    `UPDATE stocktake_lines
        SET counted_qty = ?, variance = ?, variance_value_pesewas = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
  ).run(canonicalCount, variance, varianceValue, new Date().toISOString(), workerId, line.id);

  return { variance, varianceValuePesewas: varianceValue, canonicalCount };
}

export interface CompleteStocktakeInput {
  eventId: string;
  workerId: string;
  supervisorWorkerId: string;
  supervisorPin: string;
  notes?: string | null;
  deviceId: string;
}

export interface CompleteStocktakeResult {
  eventId: string;
  movementsEmitted: number;
  totalLossValuePesewas: number;
  totalFoundValuePesewas: number;
  shrinkageRate: number | null;
  productsCounted: number;
  productsWithVariance: number;
}

/**
 * Complete a stocktake. Verifies supervisor PIN; opens transaction; emits
 * one stock_movement per non-zero-variance line; updates event totals.
 *
 * Lines with counted_qty IS NULL (un-counted) are treated as zero-variance —
 * the worker hasn't physically counted them. These lines do NOT emit a
 * movement. The application UI should warn the worker before completing
 * with un-counted lines.
 */
export function completeStocktake(
  db: DB,
  input: CompleteStocktakeInput,
): CompleteStocktakeResult {
  const event = db
    .prepare(
      `SELECT id, location_id, status, total_expected_stock_value_pesewas
         FROM stocktake_events WHERE id = ?`,
    )
    .get(input.eventId) as
    | { id: string; location_id: string; status: string; total_expected_stock_value_pesewas: number }
    | undefined;
  if (!event) throw new Error(`completeStocktake: event ${input.eventId} not found`);
  if (event.status !== 'DRAFT') {
    throw new Error(`completeStocktake: event is ${event.status}, only DRAFT can be completed`);
  }

  // Supervisor verification
  const sup = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(input.supervisorWorkerId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!sup || sup.active !== 1 || sup.deleted_at || sup.terminated_at) {
    throw new Error('completeStocktake: supervisor not found');
  }
  if (!SUPERVISOR_ROLES.has(sup.role)) {
    throw new Error(`completeStocktake: ${sup.role} cannot approve a stocktake`);
  }
  const auth = verifyPin(db, input.supervisorWorkerId, input.supervisorPin, input.deviceId);
  if (!auth.ok) {
    throw new Error(
      auth.reason === 'LOCKED_OUT'
        ? `completeStocktake: supervisor locked out until ${auth.lockedUntil}`
        : `completeStocktake: supervisor PIN check failed (${auth.reason})`,
    );
  }

  const lines = db
    .prepare(
      `SELECT id, product_id, expected_qty, counted_qty, variance, unit_cost_pesewas, variance_value_pesewas
         FROM stocktake_lines WHERE stocktake_event_id = ?`,
    )
    .all(input.eventId) as Array<{
      id: string; product_id: string; expected_qty: number;
      counted_qty: number | null; variance: number | null;
      unit_cost_pesewas: number; variance_value_pesewas: number | null;
    }>;

  let totalLossValue = 0;
  let totalFoundValue = 0;
  let movementsEmitted = 0;
  let productsCounted = 0;
  let productsWithVariance = 0;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const line of lines) {
      if (line.counted_qty === null) continue;
      productsCounted++;
      if (line.variance === null || line.variance === 0) continue;
      productsWithVariance++;

      // Emit signed movement: variance > 0 => STOCK_FOUND (inflow);
      // variance < 0 => STOCKTAKE_VARIANCE_LOSS (outflow).
      const isLoss = line.variance < 0;
      const reasonCode = isLoss ? 'STOCKTAKE_VARIANCE_LOSS' : 'STOCK_FOUND';
      const sm = insertStockMovement(db, {
        productId: line.product_id,
        locationId: event.location_id,
        quantity: Math.abs(line.variance),
        reasonCode,
        workerId: input.workerId,
        unitCostPesewas: line.unit_cost_pesewas,
        supervisorApprovalId: input.supervisorWorkerId,
        notes: input.notes ?? null,
        deviceId: input.deviceId,
      });
      db.prepare(
        `UPDATE stocktake_lines SET stock_movement_id = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      ).run(sm.id, now, input.workerId, line.id);
      movementsEmitted++;
      if (isLoss) totalLossValue += -line.variance_value_pesewas!;
      else totalFoundValue += line.variance_value_pesewas!;
    }

    const denom = event.total_expected_stock_value_pesewas;
    const shrinkageRate = denom > 0 ? totalLossValue / denom : null;

    db.prepare(
      `UPDATE stocktake_events
          SET status = 'COMPLETED',
              completed_at = ?,
              supervisor_approval_id = ?,
              total_loss_value_pesewas = ?,
              total_found_value_pesewas = ?,
              products_counted = ?,
              products_with_variance = ?,
              shrinkage_rate = ?,
              notes = ?,
              updated_at = ?,
              updated_by = ?
          WHERE id = ?`,
    ).run(
      now,
      input.supervisorWorkerId,
      totalLossValue,
      totalFoundValue,
      productsCounted,
      productsWithVariance,
      shrinkageRate,
      input.notes ?? null,
      now,
      input.workerId,
      input.eventId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'STOCKTAKE_COMPLETED',
      entityType: 'stocktake_events',
      entityId: input.eventId,
      afterValue: {
        movementsEmitted,
        totalLossValuePesewas: totalLossValue,
        totalFoundValuePesewas: totalFoundValue,
        shrinkageRate,
        productsCounted,
        productsWithVariance,
        supervisorApprovalId: input.supervisorWorkerId,
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  const denom = event.total_expected_stock_value_pesewas;
  const shrinkageRate = denom > 0 ? totalLossValue / denom : null;
  return {
    eventId: input.eventId,
    movementsEmitted,
    totalLossValuePesewas: totalLossValue,
    totalFoundValuePesewas: totalFoundValue,
    shrinkageRate,
    productsCounted,
    productsWithVariance,
  };
}

/** Cancel a DRAFT event without emitting any movements. */
export function cancelStocktake(
  db: DB,
  eventId: string,
  workerId: string,
  deviceId: string,
): void {
  const event = db
    .prepare('SELECT status FROM stocktake_events WHERE id = ?')
    .get(eventId) as { status: string } | undefined;
  if (!event) throw new Error(`cancelStocktake: event ${eventId} not found`);
  if (event.status !== 'DRAFT') {
    throw new Error(`cancelStocktake: event is ${event.status}, only DRAFT can be cancelled`);
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE stocktake_events
        SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
  ).run(now, now, workerId, eventId);

  logAudit(db, {
    workerId,
    action: 'STOCKTAKE_CANCELLED',
    entityType: 'stocktake_events',
    entityId: eventId,
    deviceId,
  });
}

export function getActiveStocktake(db: DB, locationId: string): StocktakeEventSummary | null {
  const row = db
    .prepare(
      `SELECT id, status, started_at AS startedAt, completed_at AS completedAt,
              products_counted AS productsCounted,
              products_with_variance AS productsWithVariance,
              total_loss_value_pesewas AS totalLossValuePesewas,
              total_found_value_pesewas AS totalFoundValuePesewas,
              total_expected_stock_value_pesewas AS totalExpectedStockValuePesewas,
              shrinkage_rate AS shrinkageRate, notes
         FROM stocktake_events WHERE location_id = ? AND status = 'DRAFT' LIMIT 1`,
    )
    .get(locationId) as StocktakeEventSummary | undefined;
  return row ?? null;
}

export function getStocktakeWithLines(db: DB, eventId: string): {
  event: StocktakeEventSummary;
  lines: StocktakeLineRow[];
} {
  const event = db
    .prepare(
      `SELECT id, status, started_at AS startedAt, completed_at AS completedAt,
              products_counted AS productsCounted,
              products_with_variance AS productsWithVariance,
              total_loss_value_pesewas AS totalLossValuePesewas,
              total_found_value_pesewas AS totalFoundValuePesewas,
              total_expected_stock_value_pesewas AS totalExpectedStockValuePesewas,
              shrinkage_rate AS shrinkageRate, notes
         FROM stocktake_events WHERE id = ?`,
    )
    .get(eventId) as StocktakeEventSummary | undefined;
  if (!event) throw new Error(`getStocktakeWithLines: event ${eventId} not found`);

  const lines = db
    .prepare(
      `SELECT sl.id, sl.product_id AS productId, p.name AS productName, p.sku AS productSku,
              sl.expected_qty AS expectedQty, sl.counted_qty AS countedQty,
              sl.variance, sl.unit_cost_pesewas AS unitCostPesewas,
              sl.variance_value_pesewas AS varianceValuePesewas
         FROM stocktake_lines sl
         JOIN products p ON p.id = sl.product_id
         WHERE sl.stocktake_event_id = ?
         ORDER BY p.name ASC`,
    )
    .all(eventId) as StocktakeLineRow[];

  return { event, lines };
}

export function listRecentStocktakes(db: DB, limit = 25): StocktakeEventSummary[] {
  return db
    .prepare(
      `SELECT id, status, started_at AS startedAt, completed_at AS completedAt,
              products_counted AS productsCounted,
              products_with_variance AS productsWithVariance,
              total_loss_value_pesewas AS totalLossValuePesewas,
              total_found_value_pesewas AS totalFoundValuePesewas,
              total_expected_stock_value_pesewas AS totalExpectedStockValuePesewas,
              shrinkage_rate AS shrinkageRate, notes
         FROM stocktake_events
         ORDER BY COALESCE(completed_at, started_at) DESC
         LIMIT ?`,
    )
    .all(limit) as StocktakeEventSummary[];
}
