// insertStockMovement — the only sanctioned way to write to stock_movements.
// Pass a positive quantity; the function looks up reason_codes.category and
// signs the value. Never call this with a pre-signed quantity.
//
// This is invariant 4 in CLAUDE.md.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface InsertStockMovementInput {
  productId: string;
  locationId: string;
  /** ALWAYS positive. Sign is set automatically from the reason category. */
  quantity: number;
  reasonCode: string;
  shiftId?: string | null;
  workerId: string;
  saleId?: string | null;
  purchaseOrderId?: string | null;
  routeRunId?: string | null;
  breakageLogId?: string | null;
  unitCostPesewas: number;
  photoUrl?: string | null;
  supervisorApprovalId?: string | null;
  notes?: string | null;
  deviceId: string;
}

export interface StockMovementRow {
  id: string;
  signedQuantity: number;
  totalValuePesewas: number;
}

/**
 * Insert a stock movement. Caller passes positive quantity; we sign it based
 * on the reason code's category (inflow/outflow/neutral).
 *
 * Throws if the reason code is unknown, the quantity is non-positive, or a
 * required photo is missing.
 *
 * Caller is responsible for wrapping in a transaction when this is part of
 * a multi-write operation (sale, breakage, etc.).
 */
export function insertStockMovement(
  db: DB,
  input: InsertStockMovementInput,
): StockMovementRow {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error(
      `insertStockMovement: quantity must be a positive integer, got ${input.quantity}`,
    );
  }
  if (!Number.isInteger(input.unitCostPesewas) || input.unitCostPesewas < 0) {
    throw new Error(
      `insertStockMovement: unitCostPesewas must be a non-negative integer, got ${input.unitCostPesewas}`,
    );
  }

  const reason = db
    .prepare(
      'SELECT category, requires_photo, requires_supervisor FROM reason_codes WHERE code = ? AND active = 1',
    )
    .get(input.reasonCode) as
    | { category: 'inflow' | 'outflow' | 'neutral'; requires_photo: number; requires_supervisor: number }
    | undefined;

  if (!reason) {
    throw new Error(`insertStockMovement: unknown or inactive reason code '${input.reasonCode}'`);
  }
  if (reason.requires_photo === 1 && !input.photoUrl) {
    throw new Error(
      `insertStockMovement: reason '${input.reasonCode}' requires a photoUrl`,
    );
  }
  if (reason.requires_supervisor === 1 && !input.supervisorApprovalId) {
    throw new Error(
      `insertStockMovement: reason '${input.reasonCode}' requires supervisor approval`,
    );
  }

  // Sign the quantity. neutral => 0, but reasons that produce zero-net stock
  // changes should not generate a stock_movements row at all (CHECK rejects
  // quantity = 0). If a "neutral" reason genuinely needs a row, caller must
  // emit two rows (one inflow, one outflow) instead.
  let signedQuantity: number;
  switch (reason.category) {
    case 'inflow':
      signedQuantity = input.quantity;
      break;
    case 'outflow':
      signedQuantity = -input.quantity;
      break;
    case 'neutral':
      throw new Error(
        `insertStockMovement: reason '${input.reasonCode}' is neutral; emit paired rows instead.`,
      );
  }

  const totalValuePesewas = signedQuantity * input.unitCostPesewas;
  const id = `sm-${uuidv4()}`;

  db.prepare(
    `INSERT INTO stock_movements (
      id, product_id, location_id, quantity, reason_code,
      shift_id, worker_id, sale_id, purchase_order_id, route_run_id, breakage_log_id,
      unit_cost_pesewas, total_value_pesewas, photo_url, supervisor_approval_id, notes,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.productId,
    input.locationId,
    signedQuantity,
    input.reasonCode,
    input.shiftId ?? null,
    input.workerId,
    input.saleId ?? null,
    input.purchaseOrderId ?? null,
    input.routeRunId ?? null,
    input.breakageLogId ?? null,
    input.unitCostPesewas,
    totalValuePesewas,
    input.photoUrl ?? null,
    input.supervisorApprovalId ?? null,
    input.notes ?? null,
    input.workerId, // created_by = the worker performing the action
    input.workerId,
    input.deviceId,
  );

  return { id, signedQuantity, totalValuePesewas };
}

/** Compute current units on hand for a (product, location) pair.
 *  Truth lives here — there is no stock_levels cache table. */
export function unitsOnHand(
  db: DB,
  productId: string,
  locationId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS units
         FROM stock_movements
         WHERE product_id = ? AND location_id = ?`,
    )
    .get(productId, locationId) as { units: number };
  return row.units ?? 0;
}
