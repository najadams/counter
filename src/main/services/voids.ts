// Queued void requests and the exact reversal of a completed sale.
//
// A void is NOT a delete. The original sales row stays — voided=1 is set,
// and a NEW set of stock_movements (positive, SALE_VOID_REVERSAL) is
// appended that brings inventory back to its pre-sale state. This way the
// void itself is auditable: you can see who voided what, when, why.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { assertNotSealed } from './periods.js';
import {
  isLedgerPostingEnabled,
  recordInventoryValuationMovement,
  reverseSaleJournalIfActive,
} from './ledger.js';
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
export type VoidRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';
export type VoidRequestScope = 'MINE' | 'REVIEWABLE' | 'ALL';

interface ActiveWorker {
  id: string;
  fullName: string;
  role: string;
}

interface VoidableSale {
  id: string;
  shiftId: string;
  locationId: string;
  customerId: string | null;
  channel: string;
  totalPesewas: number;
  isCredit: number;
  voided: number;
  supersededBy: string | null;
  createdAt: string;
  workerName: string;
  customerName: string | null;
}

export interface SaleVoidRequestSummary {
  id: string;
  saleId: string;
  locationId: string;
  shiftId: string;
  status: VoidRequestStatus;
  reason: string;
  requestedAt: string;
  requesterId: string;
  requesterName: string;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  withdrawnAt: string | null;
  saleCreatedAt: string;
  saleWorkerName: string;
  customerName: string | null;
  channel: string;
  totalPesewas: number;
  paymentMethod: string;
  lineCount: number;
}

export interface SaleVoidRequestDetail extends SaleVoidRequestSummary {
  lines: Array<{
    productId: string;
    productName: string;
    quantity: number;
    unitName: string | null;
    unitPricePesewas: number;
    lineTotalPesewas: number;
    canonicalQuantity: number;
    inventoryValuePesewas: number;
  }>;
  payments: Array<{ method: string; amountPesewas: number }>;
  creditBalanceDeltaPesewas: number;
  accountingEffect: {
    netSalesPesewas: number;
    cogsPesewas: number;
    vatPesewas: number;
    nhilPesewas: number;
    getfundPesewas: number;
  };
}

function activeWorker(db: DB, workerId: string): ActiveWorker {
  const worker = db.prepare(
    `SELECT id, full_name AS fullName, role
       FROM workers
      WHERE id = ? AND active = 1 AND deleted_at IS NULL AND terminated_at IS NULL`,
  ).get(workerId) as ActiveWorker | undefined;
  if (!worker) throw new Error('sale void request: worker not found or inactive');
  return worker;
}

function loadVoidableSale(db: DB, saleId: string): VoidableSale {
  const sale = db.prepare(
    `SELECT s.id, s.shift_id AS shiftId, s.location_id AS locationId,
            s.customer_id AS customerId, s.channel, s.total_pesewas AS totalPesewas,
            s.is_credit AS isCredit, s.voided,
            s.superseded_by_sale_id AS supersededBy, s.created_at AS createdAt,
            w.full_name AS workerName, c.display_name AS customerName
       FROM sales s
       JOIN workers w ON w.id = s.worker_id
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = ?`,
  ).get(saleId) as VoidableSale | undefined;
  if (!sale) throw new Error(`sale void request: sale ${saleId} not found`);
  return sale;
}

function assertVoidEligibility(db: DB, sale: VoidableSale, today: string): void {
  if (sale.voided === 1) throw new Error('sale void request: sale is already voided');
  if (sale.supersededBy) throw new Error('sale void request: sale was already corrected');
  if (sale.createdAt.slice(0, 10) !== today) {
    throw new Error('sale void request: only sales from the current business day can be voided');
  }
  assertNotSealed(db, sale.locationId, today, `voiding sale ${sale.id}`);
  const returned = db.prepare(
    'SELECT 1 FROM customer_returns WHERE original_sale_id = ? LIMIT 1',
  ).get(sale.id);
  if (returned) throw new Error('sale void request: sale has a linked customer return');
}

export function createSaleVoidRequest(db: DB, input: {
  saleId: string;
  reason: string;
  requesterWorkerId: string;
  deviceId: string;
}): SaleVoidRequestDetail {
  activeWorker(db, input.requesterWorkerId);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 200) {
    throw new Error('sale void request: reason must be between 3 and 200 characters');
  }
  const sale = loadVoidableSale(db, input.saleId);
  const today = new Date().toISOString().slice(0, 10);
  assertVoidEligibility(db, sale, today);
  const existing = db.prepare(
    `SELECT id FROM sale_void_requests WHERE sale_id = ? AND status = 'PENDING'`,
  ).get(sale.id) as { id: string } | undefined;
  if (existing) throw new Error('sale void request: this sale already has a pending request');

  const id = `svr-${uuidv4()}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sale_void_requests
         (id, sale_id, location_id, shift_id, requested_by, reason,
          request_device_id, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, sale.id, sale.locationId, sale.shiftId, input.requesterWorkerId,
      reason, input.deviceId, input.requesterWorkerId, input.requesterWorkerId,
    );
    logAudit(db, {
      workerId: input.requesterWorkerId,
      action: 'SALE_VOID_REQUESTED',
      entityType: 'sale_void_requests',
      entityId: id,
      afterValue: {
        saleId: sale.id,
        shiftId: sale.shiftId,
        locationId: sale.locationId,
        totalPesewas: sale.totalPesewas,
        reason,
      },
      deviceId: input.deviceId,
    });
  })();
  return getSaleVoidRequest(db, id, input.requesterWorkerId);
}

export function reviewSaleVoidRequest(db: DB, input: {
  requestId: string;
  decision: 'APPROVE' | 'DECLINE';
  note?: string | null;
  reviewerWorkerId: string;
  deviceId: string;
}): SaleVoidRequestDetail {
  const reviewer = activeWorker(db, input.reviewerWorkerId);
  if (!SUPERVISOR_ROLES.has(reviewer.role)) {
    throw new Error('sale void review requires SUPERVISOR, OWNER, or FOUNDER');
  }
  const note = input.note?.trim() || null;
  if (input.decision === 'DECLINE' && (!note || note.length < 3)) {
    throw new Error('sale void request: a decline note of at least 3 characters is required');
  }
  if (note && note.length > 200) throw new Error('sale void request: review note cannot exceed 200 characters');

  db.transaction(() => {
    const request = db.prepare(
      `SELECT id, sale_id AS saleId, requested_by AS requestedBy, reason, status
         FROM sale_void_requests WHERE id = ?`,
    ).get(input.requestId) as {
      id: string; saleId: string; requestedBy: string; reason: string; status: VoidRequestStatus;
    } | undefined;
    if (!request) throw new Error(`sale void request ${input.requestId} not found`);
    if (request.status !== 'PENDING') throw new Error(`sale void request is already ${request.status.toLowerCase()}`);
    if (request.requestedBy === reviewer.id && reviewer.role === 'SUPERVISOR') {
      throw new Error('a supervisor cannot review their own void request');
    }

    const now = new Date().toISOString();
    if (input.decision === 'DECLINE') {
      const changed = db.prepare(
        `UPDATE sale_void_requests
            SET status = 'DECLINED', reviewed_by = ?, reviewed_at = ?, review_note = ?,
                review_device_id = ?, updated_at = ?, updated_by = ?
          WHERE id = ? AND status = 'PENDING'`,
      ).run(reviewer.id, now, note, input.deviceId, now, reviewer.id, request.id);
      if (changed.changes !== 1) throw new Error('sale void request was already resolved');
      logAudit(db, {
        workerId: reviewer.id,
        action: 'SALE_VOID_REQUEST_DECLINED',
        entityType: 'sale_void_requests',
        entityId: request.id,
        afterValue: { saleId: request.saleId, note },
        deviceId: input.deviceId,
      });
      return;
    }

    const sale = loadVoidableSale(db, request.saleId);
    assertVoidEligibility(db, sale, now.slice(0, 10));
    const lines = loadSaleOutflows(db, sale.id);
    if (lines.length === 0) throw new Error('sale void request: sale has no stock movements');
    const changed = db.prepare(
      `UPDATE sale_void_requests
          SET status = 'APPROVED', reviewed_by = ?, reviewed_at = ?, review_note = ?,
              review_device_id = ?, updated_at = ?, updated_by = ?
        WHERE id = ? AND status = 'PENDING'`,
    ).run(reviewer.id, now, note, input.deviceId, now, reviewer.id, request.id);
    if (changed.changes !== 1) throw new Error('sale void request was already resolved');

    const reversal = voidSaleCore(db, {
      sale: {
        id: sale.id,
        location_id: sale.locationId,
        customer_id: sale.customerId,
        is_credit: sale.isCredit,
      },
      lines,
      workerId: request.requestedBy,
      reason: request.reason,
      deviceId: input.deviceId,
      supervisorApprovalId: reviewer.id,
    });
    logAudit(db, {
      workerId: reviewer.id,
      action: 'SALE_VOID_REQUEST_APPROVED',
      entityType: 'sale_void_requests',
      entityId: request.id,
      afterValue: {
        saleId: sale.id,
        note,
        selfApproved: request.requestedBy === reviewer.id,
        reversalMovementCount: reversal.reversalMovementCount,
        customerBalanceDelta: reversal.customerBalanceDelta,
      },
      deviceId: input.deviceId,
    });
  })();

  return getSaleVoidRequest(db, input.requestId, input.reviewerWorkerId);
}

export function withdrawSaleVoidRequest(db: DB, input: {
  requestId: string;
  requesterWorkerId: string;
  deviceId: string;
}): SaleVoidRequestDetail {
  activeWorker(db, input.requesterWorkerId);
  const now = new Date().toISOString();
  const request = db.prepare(
    `SELECT sale_id AS saleId, requested_by AS requestedBy, status
       FROM sale_void_requests WHERE id = ?`,
  ).get(input.requestId) as { saleId: string; requestedBy: string; status: VoidRequestStatus } | undefined;
  if (!request) throw new Error(`sale void request ${input.requestId} not found`);
  if (request.requestedBy !== input.requesterWorkerId) {
    throw new Error('only the requester can withdraw a void request');
  }
  if (request.status !== 'PENDING') throw new Error(`sale void request is already ${request.status.toLowerCase()}`);

  db.transaction(() => {
    const changed = db.prepare(
      `UPDATE sale_void_requests
          SET status = 'WITHDRAWN', withdrawn_at = ?, updated_at = ?, updated_by = ?
        WHERE id = ? AND status = 'PENDING'`,
    ).run(now, now, input.requesterWorkerId, input.requestId);
    if (changed.changes !== 1) throw new Error('sale void request was already resolved');
    logAudit(db, {
      workerId: input.requesterWorkerId,
      action: 'SALE_VOID_REQUEST_WITHDRAWN',
      entityType: 'sale_void_requests',
      entityId: input.requestId,
      afterValue: { saleId: request.saleId },
      deviceId: input.deviceId,
    });
  })();
  return getSaleVoidRequest(db, input.requestId, input.requesterWorkerId);
}

const REQUEST_SUMMARY_SQL = `
  SELECT vr.id, vr.sale_id AS saleId, vr.location_id AS locationId,
         vr.shift_id AS shiftId, vr.status, vr.reason,
         vr.requested_at AS requestedAt, vr.requested_by AS requesterId,
         requester.full_name AS requesterName, vr.reviewed_by AS reviewerId,
         reviewer.full_name AS reviewerName, vr.reviewed_at AS reviewedAt,
         vr.review_note AS reviewNote, vr.withdrawn_at AS withdrawnAt,
         s.created_at AS saleCreatedAt, seller.full_name AS saleWorkerName,
         customer.display_name AS customerName, s.channel,
         s.total_pesewas AS totalPesewas, s.payment_method AS paymentMethod,
         (SELECT COUNT(*) FROM sale_lines sl WHERE sl.sale_id = s.id) AS lineCount
    FROM sale_void_requests vr
    JOIN sales s ON s.id = vr.sale_id
    JOIN workers requester ON requester.id = vr.requested_by
    JOIN workers seller ON seller.id = s.worker_id
    LEFT JOIN workers reviewer ON reviewer.id = vr.reviewed_by
    LEFT JOIN customers customer ON customer.id = s.customer_id`;

export function listSaleVoidRequests(db: DB, input: {
  actorWorkerId: string;
  scope: VoidRequestScope;
  status?: VoidRequestStatus | 'RESOLVED';
  limit?: number;
}): SaleVoidRequestSummary[] {
  const actor = activeWorker(db, input.actorWorkerId);
  if ((input.scope === 'REVIEWABLE' || input.scope === 'ALL') && !SUPERVISOR_ROLES.has(actor.role)) {
    throw new Error('sale void request list requires a senior role');
  }
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.scope === 'MINE') {
    where.push('vr.requested_by = ?');
    params.push(actor.id);
  }
  if (input.scope === 'REVIEWABLE' && !input.status) where.push("vr.status = 'PENDING'");
  if (input.status === 'RESOLVED') where.push("vr.status <> 'PENDING'");
  else if (input.status) { where.push('vr.status = ?'); params.push(input.status); }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 250));
  params.push(limit);
  return db.prepare(
    `${REQUEST_SUMMARY_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE WHEN vr.status = 'PENDING' THEN 0 ELSE 1 END,
               vr.requested_at DESC LIMIT ?`,
  ).all(...params) as SaleVoidRequestSummary[];
}

export function getSaleVoidRequest(db: DB, requestId: string, actorWorkerId: string): SaleVoidRequestDetail {
  const actor = activeWorker(db, actorWorkerId);
  const summary = db.prepare(`${REQUEST_SUMMARY_SQL} WHERE vr.id = ?`).get(requestId) as SaleVoidRequestSummary | undefined;
  if (!summary) throw new Error(`sale void request ${requestId} not found`);
  if (summary.requesterId !== actor.id && !SUPERVISOR_ROLES.has(actor.role)) {
    throw new Error('sale void request is not visible to this worker');
  }
  const lines = db.prepare(
    `SELECT sl.product_id AS productId, p.name AS productName, sl.quantity,
            pu.unit_name AS unitName, sl.unit_price_pesewas AS unitPricePesewas,
            sl.line_total_pesewas AS lineTotalPesewas,
            sl.quantity * COALESCE(pu.conversion_factor, 1) AS canonicalQuantity,
            sl.line_cogs_pesewas AS inventoryValuePesewas
       FROM sale_lines sl
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN product_units pu ON pu.id = sl.applied_unit_id
      WHERE sl.sale_id = ? ORDER BY sl.created_at, sl.id`,
  ).all(summary.saleId) as Array<{
    productId: string; productName: string; quantity: number; unitName: string | null;
    unitPricePesewas: number; lineTotalPesewas: number;
    canonicalQuantity: number; inventoryValuePesewas: number;
  }>;
  const payments = db.prepare(
    `SELECT payment_method AS method, SUM(amount_pesewas) AS amountPesewas
       FROM sale_payments WHERE sale_id = ? GROUP BY payment_method ORDER BY payment_method`,
  ).all(summary.saleId) as Array<{ method: string; amountPesewas: number }>;
  const accounting = db.prepare(
    `SELECT s.total_pesewas - s.vat_pesewas - s.nhil_pesewas - s.getfund_pesewas AS netSalesPesewas,
            COALESCE(SUM(sl.line_cogs_pesewas), 0) AS cogsPesewas,
            s.vat_pesewas AS vatPesewas, s.nhil_pesewas AS nhilPesewas,
            s.getfund_pesewas AS getfundPesewas
       FROM sales s LEFT JOIN sale_lines sl ON sl.sale_id = s.id
      WHERE s.id = ? GROUP BY s.id`,
  ).get(summary.saleId) as SaleVoidRequestDetail['accountingEffect'];
  return {
    ...summary,
    lines,
    payments,
    creditBalanceDeltaPesewas: -(payments.find((payment) => payment.method === 'CREDIT')?.amountPesewas ?? 0),
    accountingEffect: accounting,
  };
}

export function pendingSaleVoidRequestCount(db: DB, actorWorkerId?: string): number {
  const row = actorWorkerId
    ? db.prepare("SELECT COUNT(*) AS n FROM sale_void_requests WHERE status = 'PENDING' AND requested_by = ?").get(actorWorkerId)
    : db.prepare("SELECT COUNT(*) AS n FROM sale_void_requests WHERE status = 'PENDING'").get();
  return (row as { n: number }).n;
}

export function assertNoPendingVoidRequestsForShift(db: DB, shiftId: string): void {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM sale_void_requests WHERE shift_id = ? AND status = 'PENDING'",
  ).get(shiftId) as { n: number };
  if (row.n > 0) {
    throw new Error(`shift has ${row.n} pending void request(s); resolve or withdraw them before closing`);
  }
}

export function assertNoPendingVoidRequestsForDay(db: DB, locationId: string, businessDate: string): void {
  const row = db.prepare(
    `SELECT COUNT(*) AS n
       FROM sale_void_requests vr
       JOIN sales s ON s.id = vr.sale_id
      WHERE vr.location_id = ? AND substr(s.created_at, 1, 10) = ? AND vr.status = 'PENDING'`,
  ).get(locationId, businessDate) as { n: number };
  if (row.n > 0) {
    throw new Error(`cannot seal ${businessDate}: ${row.n} void request(s) still await a decision`);
  }
}

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
    const movement = insertStockMovement(db, {
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
    if (isLedgerPostingEnabled(db, p.sale.location_id)) {
      recordInventoryValuationMovement(db, {
        stockMovementId: movement.id,
        exactInboundValuePesewas: line.total_value_pesewas,
        actorWorkerId: p.workerId,
        deviceId: p.deviceId,
      });
    }
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

  reverseSaleJournalIfActive(
    db, p.sale.id, p.sale.id, p.reason, p.workerId, p.deviceId,
  );

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
  voidRequest: {
    id: string;
    status: VoidRequestStatus;
    reason: string;
    requestedAt: string;
    requesterId: string;
    requesterName: string;
    reviewedAt: string | null;
    reviewerName: string | null;
    reviewNote: string | null;
  } | null;
}

/** Most recent N sales, with light join to workers/customers for display. */
export function listRecentSales(db: DB, limit = 25): RecentSale[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.created_at AS createdAt, s.channel, s.total_pesewas AS totalPesewas,
              s.payment_method AS paymentMethod, s.voided, s.customer_id,
              w.full_name AS workerName,
              c.display_name AS customerName,
              vr.id AS voidRequestId, vr.status AS voidRequestStatus,
              vr.reason AS voidRequestReason, vr.requested_at AS voidRequestedAt,
              vr.requested_by AS voidRequesterId,
              vr.reviewed_at AS voidReviewedAt, vr.review_note AS voidReviewNote,
              requester.full_name AS voidRequesterName,
              reviewer.full_name AS voidReviewerName,
              (SELECT COUNT(*) FROM sale_lines sl WHERE sl.sale_id = s.id) AS lineCount
         FROM sales s
         JOIN workers w ON w.id = s.worker_id
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN sale_void_requests vr ON vr.id = (
           SELECT latest.id FROM sale_void_requests latest
            WHERE latest.sale_id = s.id
            ORDER BY latest.requested_at DESC, latest.id DESC LIMIT 1
         )
         LEFT JOIN workers requester ON requester.id = vr.requested_by
         LEFT JOIN workers reviewer ON reviewer.id = vr.reviewed_by
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
      voidRequestId: string | null;
      voidRequestStatus: VoidRequestStatus | null;
      voidRequestReason: string | null;
      voidRequestedAt: string | null;
      voidRequesterId: string | null;
      voidRequesterName: string | null;
      voidReviewedAt: string | null;
      voidReviewerName: string | null;
      voidReviewNote: string | null;
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
    voidRequest: r.voidRequestId && r.voidRequestStatus && r.voidRequestReason
      && r.voidRequestedAt && r.voidRequesterId && r.voidRequesterName
      ? {
          id: r.voidRequestId,
          status: r.voidRequestStatus,
          reason: r.voidRequestReason,
          requestedAt: r.voidRequestedAt,
          requesterId: r.voidRequesterId,
          requesterName: r.voidRequesterName,
          reviewedAt: r.voidReviewedAt,
          reviewerName: r.voidReviewerName,
          reviewNote: r.voidReviewNote,
        }
      : null,
  }));
}
