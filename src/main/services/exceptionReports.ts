// Exception reports.
//
// Audit log captures everything but nobody reads raw audit logs. These
// derived queries surface the patterns that actually matter for
// anti-shrinkage:
//   - per-cashier voids ranked
//   - per-cashier discounts ranked
//   - post-sale edits (any sales-entity audit entry after SALE_COMPLETED)
//   - repeated SKU voids by same cashier in a single day
//   - large discounts above a threshold
//
// OWNER/FOUNDER only.

import type { Database as DB } from 'better-sqlite3';

const VIEWER_ROLES = new Set(['OWNER', 'FOUNDER']);

function requireViewer(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!VIEWER_ROLES.has(w.role)) {
    throw new Error(`exception reports require OWNER or FOUNDER — your role is ${w.role}`);
  }
}

function bounds(fromDate: string, toDate: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error(`invalid fromDate ${fromDate}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) throw new Error(`invalid toDate ${toDate}`);
  return { from: `${fromDate}T00:00:00.000Z`, to: `${toDate}T23:59:59.999Z` };
}

export interface CashierVoidRow {
  workerId: string;
  workerName: string;
  workerRole: string;
  voidCount: number;
  voidValuePesewas: number;
}

export function voidsByCashier(db: DB, actorId: string, fromDate: string, toDate: string): CashierVoidRow[] {
  requireViewer(db, actorId);
  const { from, to } = bounds(fromDate, toDate);
  return db.prepare(
    `SELECT s.voided_by AS workerId,
            w.full_name AS workerName, w.role AS workerRole,
            COUNT(*) AS voidCount,
            COALESCE(SUM(s.total_pesewas), 0) AS voidValuePesewas
       FROM sales s
       JOIN workers w ON w.id = s.voided_by
      WHERE s.voided = 1
        AND s.voided_at >= ? AND s.voided_at <= ?
      GROUP BY s.voided_by
      ORDER BY voidCount DESC, voidValuePesewas DESC`,
  ).all(from, to) as CashierVoidRow[];
}

export interface CashierDiscountRow {
  workerId: string;
  workerName: string;
  workerRole: string;
  discountSaleCount: number;
  totalDiscountPesewas: number;
  largestDiscountPesewas: number;
}

export function discountsByCashier(db: DB, actorId: string, fromDate: string, toDate: string): CashierDiscountRow[] {
  requireViewer(db, actorId);
  const { from, to } = bounds(fromDate, toDate);
  return db.prepare(
    `SELECT s.worker_id AS workerId,
            w.full_name AS workerName, w.role AS workerRole,
            COUNT(*) AS discountSaleCount,
            COALESCE(SUM(s.discount_pesewas), 0) AS totalDiscountPesewas,
            COALESCE(MAX(s.discount_pesewas), 0) AS largestDiscountPesewas
       FROM sales s
       JOIN workers w ON w.id = s.worker_id
      WHERE s.discount_pesewas > 0 AND s.voided = 0
        AND s.created_at >= ? AND s.created_at <= ?
      GROUP BY s.worker_id
      ORDER BY totalDiscountPesewas DESC`,
  ).all(from, to) as CashierDiscountRow[];
}

export interface PostSaleEditRow {
  saleId: string;
  saleCreatedAt: string;
  saleWorkerName: string;
  editAuditId: string;
  editAt: string;
  editAction: string;
  editWorkerName: string;
  editWorkerRole: string;
}

/** Any audit entry on a `sales` entity whose action != SALE_COMPLETED, that
 *  references a sale already created (i.e. flagged after-the-fact edits). */
export function postSaleEdits(db: DB, actorId: string, fromDate: string, toDate: string): PostSaleEditRow[] {
  requireViewer(db, actorId);
  const { from, to } = bounds(fromDate, toDate);
  return db.prepare(
    `SELECT s.id AS saleId, s.created_at AS saleCreatedAt,
            sw.full_name AS saleWorkerName,
            a.id AS editAuditId, a.created_at AS editAt, a.action AS editAction,
            ew.full_name AS editWorkerName, ew.role AS editWorkerRole
       FROM audit_log a
       JOIN sales s ON s.id = a.entity_id
       JOIN workers sw ON sw.id = s.worker_id
       JOIN workers ew ON ew.id = a.worker_id
      WHERE a.entity_type = 'sales'
        AND a.action != 'SALE_COMPLETED'
        AND a.created_at >= ? AND a.created_at <= ?
        AND a.created_at > s.created_at
      ORDER BY a.created_at DESC`,
  ).all(from, to) as PostSaleEditRow[];
}

export interface RepeatedSkuVoidRow {
  businessDate: string;
  workerId: string;
  workerName: string;
  productId: string;
  productName: string;
  voidCount: number;
}

/** Per (date, cashier, product), count voided sales whose lines included
 *  that product. Threshold ≥3 surfaces "same SKU voided 3× by same
 *  cashier in one day" — a classic shrinkage pattern. */
export function repeatedSkuVoids(db: DB, actorId: string, fromDate: string, toDate: string, minCount = 3): RepeatedSkuVoidRow[] {
  requireViewer(db, actorId);
  const { from, to } = bounds(fromDate, toDate);
  return db.prepare(
    `SELECT date(s.voided_at) AS businessDate,
            s.voided_by AS workerId, w.full_name AS workerName,
            sl.product_id AS productId, p.name AS productName,
            COUNT(DISTINCT s.id) AS voidCount
       FROM sales s
       JOIN sale_lines sl ON sl.sale_id = s.id
       JOIN workers w ON w.id = s.voided_by
       JOIN products p ON p.id = sl.product_id
      WHERE s.voided = 1
        AND s.voided_at >= ? AND s.voided_at <= ?
      GROUP BY date(s.voided_at), s.voided_by, sl.product_id
      HAVING COUNT(DISTINCT s.id) >= ?
      ORDER BY voidCount DESC, businessDate DESC`,
  ).all(from, to, minCount) as RepeatedSkuVoidRow[];
}

export interface LargeDiscountRow {
  saleId: string;
  saleAt: string;
  workerName: string;
  totalPesewas: number;
  discountPesewas: number;
  discountRatio: number;
  reason: string | null;
}

/** Sales whose discount exceeded the absolute threshold OR whose discount
 *  ratio exceeded the percentage threshold. Surfaces oversized writeoffs. */
export function largeDiscounts(
  db: DB, actorId: string, fromDate: string, toDate: string,
  absoluteThresholdPesewas = 200, ratioThreshold = 0.05,
): LargeDiscountRow[] {
  requireViewer(db, actorId);
  const { from, to } = bounds(fromDate, toDate);
  return db.prepare(
    `SELECT s.id AS saleId, s.created_at AS saleAt,
            w.full_name AS workerName,
            s.total_pesewas AS totalPesewas, s.discount_pesewas AS discountPesewas,
            CAST(s.discount_pesewas AS REAL) / NULLIF(s.subtotal_pesewas, 0) AS discountRatio,
            s.discount_reason AS reason
       FROM sales s
       JOIN workers w ON w.id = s.worker_id
      WHERE s.discount_pesewas > 0 AND s.voided = 0
        AND s.created_at >= ? AND s.created_at <= ?
        AND (s.discount_pesewas >= ?
          OR (CAST(s.discount_pesewas AS REAL) / NULLIF(s.subtotal_pesewas, 0)) >= ?)
      ORDER BY s.discount_pesewas DESC`,
  ).all(from, to, absoluteThresholdPesewas, ratioThreshold) as LargeDiscountRow[];
}
