// Worker consumption: track free-tier drinking against monthly allowance.
//
// Allowance is per worker (workers.consumption_allowance_units), measured
// in units (bottles for now — when consumption_weight lands, this becomes
// points). A worker who exceeds their allowance can still consume, but the
// extra units are flagged WORKER_CONSUMED_PAID and the cost is recorded
// against the worker for end-of-month payroll deduction.
//
// Crossing the threshold MID-PURCHASE (e.g. 1 left, drinking 2): the first
// unit is free, the second is paid. We split into two log rows.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { insertStockMovement } from './stockMovements.js';

export interface ConsumptionUsage {
  workerId: string;
  monthIso: string;          // 'YYYY-MM'
  unitsAllowed: number;
  unitsUsed: number;
  unitsRemaining: number;
}

/** Sum month-to-date consumption units for a worker. */
export function getMonthlyUsage(
  db: DB,
  workerId: string,
  /** Optional override for tests; defaults to current month UTC. */
  monthIso?: string,
): ConsumptionUsage {
  const month = monthIso ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01T00:00:00.000Z`;
  // First day of next month
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) throw new Error(`getMonthlyUsage: invalid monthIso ${month}`);
  const next = m === 12 ? `${y + 1}-01-01T00:00:00.000Z` : `${y}-${(m + 1).toString().padStart(2, '0')}-01T00:00:00.000Z`;

  const usedRow = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS used
         FROM worker_consumption_log
         WHERE worker_id = ?
           AND created_at >= ? AND created_at < ?`,
    )
    .get(workerId, monthStart, next) as { used: number };

  const worker = db
    .prepare('SELECT consumption_allowance_units FROM workers WHERE id = ?')
    .get(workerId) as { consumption_allowance_units: number } | undefined;
  if (!worker) throw new Error(`getMonthlyUsage: worker ${workerId} not found`);

  return {
    workerId,
    monthIso: month,
    unitsAllowed: worker.consumption_allowance_units,
    unitsUsed: usedRow.used,
    unitsRemaining: Math.max(0, worker.consumption_allowance_units - usedRow.used),
  };
}

export interface RecordConsumptionInput {
  shiftId: string;
  workerId: string;
  locationId: string;
  productId: string;
  quantity: number;
  /** Required when ANY unit will be paid (over-allowance). */
  supervisorApprovalId?: string | null;
  deviceId: string;
}

export interface RecordConsumptionResult {
  rowsInserted: number;
  unitsFree: number;
  unitsPaid: number;
  costToWorkerPesewas: number;
}

/**
 * Record a consumption event. May insert ONE or TWO worker_consumption_log
 * rows depending on whether this purchase crosses the allowance boundary.
 *
 * If any units are paid (over allowance), supervisor approval is required.
 */
export function recordConsumption(
  db: DB,
  input: RecordConsumptionInput,
): RecordConsumptionResult {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error(`recordConsumption: quantity must be a positive integer`);
  }

  const product = db
    .prepare(
      `SELECT name, cost_price_pesewas, walk_in_price_pesewas
         FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL`,
    )
    .get(input.productId) as
    | { name: string; cost_price_pesewas: number; walk_in_price_pesewas: number }
    | undefined;
  if (!product) throw new Error(`recordConsumption: product not found or inactive`);

  const usage = getMonthlyUsage(db, input.workerId);
  const free = Math.max(0, Math.min(input.quantity, usage.unitsRemaining));
  const paid = input.quantity - free;

  if (paid > 0 && !input.supervisorApprovalId) {
    throw new Error(
      `recordConsumption: ${paid} unit(s) over allowance — supervisor approval required`,
    );
  }

  const result: RecordConsumptionResult = {
    rowsInserted: 0,
    unitsFree: free,
    unitsPaid: paid,
    costToWorkerPesewas: paid * product.walk_in_price_pesewas,
  };

  const tx = db.transaction(() => {
    if (free > 0) {
      const sm = insertStockMovement(db, {
        productId: input.productId,
        locationId: input.locationId,
        quantity: free,
        reasonCode: 'WORKER_CONSUMED_FREE',
        shiftId: input.shiftId,
        workerId: input.workerId,
        unitCostPesewas: product.cost_price_pesewas,
        deviceId: input.deviceId,
      });
      const id = `wc-${uuidv4()}`;
      db.prepare(
        `INSERT INTO worker_consumption_log (
          id, shift_id, location_id, worker_id, product_id, quantity,
          within_allowance, cost_to_worker_pesewas, stock_movement_id,
          created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
      ).run(
        id, input.shiftId, input.locationId, input.workerId, input.productId,
        free, sm.id, input.workerId, input.workerId, input.deviceId,
      );
      result.rowsInserted++;
    }
    if (paid > 0) {
      const sm = insertStockMovement(db, {
        productId: input.productId,
        locationId: input.locationId,
        quantity: paid,
        reasonCode: 'WORKER_CONSUMED_PAID',
        shiftId: input.shiftId,
        workerId: input.workerId,
        unitCostPesewas: product.cost_price_pesewas,
        supervisorApprovalId: input.supervisorApprovalId ?? null,
        deviceId: input.deviceId,
      });
      const id = `wc-${uuidv4()}`;
      const cost = paid * product.walk_in_price_pesewas;
      db.prepare(
        `INSERT INTO worker_consumption_log (
          id, shift_id, location_id, worker_id, product_id, quantity,
          within_allowance, cost_to_worker_pesewas, stock_movement_id,
          created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.shiftId, input.locationId, input.workerId, input.productId,
        paid, cost, sm.id, input.workerId, input.workerId, input.deviceId,
      );
      result.rowsInserted++;
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'CONSUMPTION_LOGGED',
      entityType: 'worker_consumption_log',
      entityId: input.workerId,
      afterValue: {
        productId: input.productId,
        productName: product.name,
        quantity: input.quantity,
        unitsFree: free,
        unitsPaid: paid,
        costToWorkerPesewas: result.costToWorkerPesewas,
      },
      deviceId: input.deviceId,
    });
  });

  tx();
  return result;
}
