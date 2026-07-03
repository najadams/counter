// Void-sale: supervisor-approved reversal of a completed sale.
//
// A void is NOT a delete. The original sales row stays — voided=1 is set,
// and a NEW set of stock_movements (positive, SALE_VOID_REVERSAL) is
// appended that brings inventory back to its pre-sale state. This way the
// void itself is auditable: you can see who voided what, when, why.

import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';
import { assertNotSealed } from './periods.js';
import { insertStockMovement } from './stockMovements.js';
import { verifyPin } from './workers.js';

export interface VoidSaleInput {
  saleId: string;
  reason: string;
  supervisorWorkerId: string;
  supervisorPin: string;
  workerId: string;
  deviceId: string;
}

export interface VoidSaleResult {
  saleId: string;
  reversalMovementCount: number;
  customerBalanceDelta: number; // negative or zero
}

const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

/**
 * Void a completed sale. Verifies supervisor PIN before any DB writes.
 * Reverses stock + customer balance + sets voided=1 in one transaction.
 * Refuses if already voided or if supervisor has wrong role / PIN.
 */
export function voidSale(db: DB, input: VoidSaleInput): VoidSaleResult {
  if (!input.reason || input.reason.trim() === '') {
    throw new Error('voidSale: void reason is required');
  }

  // Supervisor PIN check (this also writes WORKER_LOGIN_* audit).
  const supervisor = db
    .prepare('SELECT id, role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(input.supervisorWorkerId) as
    | { id: string; role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!supervisor || supervisor.active !== 1 || supervisor.deleted_at || supervisor.terminated_at) {
    throw new Error('voidSale: supervisor not found');
  }
  if (!SUPERVISOR_ROLES.has(supervisor.role)) {
    throw new Error(`voidSale: ${supervisor.role} cannot approve a void; need SUPERVISOR/OWNER/FOUNDER`);
  }
  const auth = verifyPin(db, input.supervisorWorkerId, input.supervisorPin, input.deviceId);
  if (!auth.ok) {
    throw new Error(
      auth.reason === 'LOCKED_OUT'
        ? `voidSale: supervisor locked out until ${auth.lockedUntil}`
        : `voidSale: supervisor PIN check failed (${auth.reason})`,
    );
  }

  const sale = db
    .prepare(
      `SELECT id, location_id, customer_id, total_pesewas, is_credit, voided, created_at
         FROM sales WHERE id = ?`,
    )
    .get(input.saleId) as
    | { id: string; location_id: string; customer_id: string | null; total_pesewas: number; is_credit: number; voided: number; created_at: string }
    | undefined;
  if (!sale) throw new Error(`voidSale: sale ${input.saleId} not found`);
  if (sale.voided === 1) throw new Error(`voidSale: sale ${input.saleId} already voided`);

  // Day-lock guard: refuse if the sale's business date is sealed.
  const businessDate = sale.created_at.slice(0, 10);
  assertNotSealed(db, sale.location_id, businessDate, `voiding sale ${input.saleId}`);

  // Reverse from the sale's ORIGINAL stock movements, not from sale_lines ×
  // the unit's conversion factor. The original movement already holds the
  // exact canonical quantity and cost that left the shelf at sale time; a
  // conversion factor edited since the sale (CRATE 24 → 12) must not change
  // what the reversal restores. Filter to the sale outflows only — a prior
  // partial return's inflow rows (positive) must not be re-reversed.
  const lines = loadSaleOutflows(db, input.saleId);
  if (lines.length === 0) throw new Error(`voidSale: sale has no stock movements (corrupt)`);

  const result = db.transaction(() => voidSaleCore(db, {
    sale,
    lines,
    workerId: input.workerId,
    reason: input.reason,
    deviceId: input.deviceId,
    supervisorApprovalId: input.supervisorWorkerId,
  }))();

  return { saleId: input.saleId, ...result };
}

export interface VoidReversalLine {
  product_id: string;
  /** Canonical units that left the shelf at sale time (positive). */
  canonical_qty: number;
  /** Per-canonical-unit cost snapshotted on the original movement. */
  unit_cost_pesewas: number;
  /** Exact cost value of the original outflow (positive). */
  total_value_pesewas: number;
}

/** The sale's original outflow movements, sign-flipped to positives — the
 *  exact canonical quantities and cost values the reversal must restore. */
export function loadSaleOutflows(db: DB, saleId: string): VoidReversalLine[] {
  return db
    .prepare(
      `SELECT product_id, -quantity AS canonical_qty,
              unit_cost_pesewas, -total_value_pesewas AS total_value_pesewas
         FROM stock_movements
         WHERE sale_id = ? AND quantity < 0`,
    )
    .all(saleId) as VoidReversalLine[];
}

export interface VoidSaleCoreParams {
  sale: { id: string; location_id: string; customer_id: string | null; is_credit: number };
  lines: VoidReversalLine[];
  workerId: string;
  reason: string;
  deviceId: string;
  /** Supervisor who approved the void, or null for a correction void (the
   *  correction's composition gate is the control there, not a PIN). */
  supervisorApprovalId: string | null;
}

/**
 * The DB writes of a void — reversal stock movements, credit-balance reversal,
 * mark voided=1, SALE_VOIDED audit — with NO verification and NO transaction
 * wrapper, so it composes inside a larger transaction (correctSale's void +
 * re-ring). voidSale wraps this in its own transaction after verifying.
 */
export function voidSaleCore(
  db: DB,
  p: VoidSaleCoreParams,
): { reversalMovementCount: number; customerBalanceDelta: number } {
  const now = new Date().toISOString();
  let customerDelta = 0;
  let reversalMovementCount = 0;

  // 1) Reversing stock movements (positive, SALE_VOID_REVERSAL) — exact
  //    mirrors of the original outflows: same canonical quantity, same
  //    per-canonical cost, same total value.
  for (const line of p.lines) {
    insertStockMovement(db, {
      productId: line.product_id,
      locationId: p.sale.location_id,
      quantity: line.canonical_qty,
      reasonCode: 'SALE_VOID_REVERSAL',
      workerId: p.workerId,
      saleId: p.sale.id,
      unitCostPesewas: line.unit_cost_pesewas,
      totalValuePesewasOverride: line.total_value_pesewas,
      supervisorApprovalId: p.supervisorApprovalId ?? undefined,
      notes: p.reason.slice(0, 200),
      deviceId: p.deviceId,
    });
    reversalMovementCount++;
  }

  // 2) Reverse customer balance — only the CREDIT-tender portion (mirrors
  //    completeSale, which bumps by credit tenders only).
  if (p.sale.is_credit === 1 && p.sale.customer_id) {
    const creditRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_pesewas), 0) AS creditAmount
           FROM sale_payments WHERE sale_id = ? AND payment_method = 'CREDIT'`,
      )
      .get(p.sale.id) as { creditAmount: number };
    if (creditRow.creditAmount > 0) {
      db.prepare(
        `UPDATE customers
            SET current_balance_pesewas = current_balance_pesewas - ?,
                updated_at = ?, updated_by = ? WHERE id = ?`,
      ).run(creditRow.creditAmount, now, p.workerId, p.sale.customer_id);
      customerDelta = -creditRow.creditAmount;
    }
  }

  // 3) Mark sale voided.
  db.prepare(
    `UPDATE sales
        SET voided = 1, voided_at = ?, voided_by = ?, void_reason = ?,
            updated_at = ?, updated_by = ? WHERE id = ?`,
  ).run(now, p.workerId, p.reason, now, p.workerId, p.sale.id);

  logAudit(db, {
    workerId: p.workerId,
    action: 'SALE_VOIDED',
    entityType: 'sales',
    entityId: p.sale.id,
    afterValue: {
      voidedAt: now,
      reason: p.reason,
      supervisorWorkerId: p.supervisorApprovalId,
      customerBalanceDelta: customerDelta,
      reversalMovementCount,
    },
    deviceId: p.deviceId,
  });

  return { reversalMovementCount, customerBalanceDelta: customerDelta };
}

export interface RecentSale {
  id: string;
  createdAt: string;
  channel: string;
  totalPesewas: number;
  paymentMethod: string;
  workerName: string;
  customerName: string | null;
  voided: boolean;
  lineCount: number;
}

/** Most recent N sales, with light join to workers/customers for display. */
export function listRecentSales(db: DB, limit = 25): RecentSale[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.created_at AS createdAt, s.channel, s.total_pesewas AS totalPesewas,
              s.payment_method AS paymentMethod, s.voided, s.customer_id,
              w.full_name AS workerName,
              c.display_name AS customerName,
              (SELECT COUNT(*) FROM sale_lines sl WHERE sl.sale_id = s.id) AS lineCount
         FROM sales s
         JOIN workers w ON w.id = s.worker_id
         LEFT JOIN customers c ON c.id = s.customer_id
         ORDER BY s.created_at DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string;
      createdAt: string;
      channel: string;
      totalPesewas: number;
      paymentMethod: string;
      voided: number;
      customer_id: string | null;
      workerName: string;
      customerName: string | null;
      lineCount: number;
    }>;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    channel: r.channel,
    totalPesewas: r.totalPesewas,
    paymentMethod: r.paymentMethod,
    workerName: r.workerName,
    customerName: r.customerName,
    voided: r.voided === 1,
    lineCount: r.lineCount,
  }));
}
