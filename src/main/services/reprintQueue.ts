// Pending receipt reprints — queue management.
//
// Sales that completed but couldn't print at the time get a row here.
// Supervisor or owner reviews the queue, retries the print, or discards
// with a reason. We never silently drop entries.

import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';

const QUEUE_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

function requireQueueRole(db: DB, actorId: string): string {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!QUEUE_ROLES.has(w.role)) {
    throw new Error(`reprint queue is SUPERVISOR/OWNER/FOUNDER only — your role is ${w.role}`);
  }
  return w.role;
}

export interface PendingReprint {
  id: string;
  saleId: string;
  reason: string;
  saleTotalPesewas: number;
  saleCreatedAt: string;
  saleWorkerName: string;
  ageHours: number;
  createdAt: string;
}

export function listPendingReprints(db: DB, actorId: string): PendingReprint[] {
  requireQueueRole(db, actorId);
  const rows = db
    .prepare(
      `SELECT pr.id, pr.sale_id AS saleId, pr.reason, pr.created_at AS createdAt,
              s.total_pesewas AS saleTotalPesewas,
              s.created_at AS saleCreatedAt,
              w.full_name AS saleWorkerName,
              CAST((julianday('now') - julianday(pr.created_at)) * 24 AS REAL) AS ageHours
         FROM pending_receipt_reprints pr
         JOIN sales s ON s.id = pr.sale_id
         JOIN workers w ON w.id = s.worker_id
        WHERE pr.resolved_at IS NULL
        ORDER BY pr.created_at ASC`,
    )
    .all() as Array<PendingReprint>;
  return rows;
}

export function discardReprint(
  db: DB,
  reprintId: string,
  reason: string,
  actorId: string,
  deviceId: string,
): void {
  requireQueueRole(db, actorId);
  if (!reason.trim()) throw new Error('discard reason required');

  const row = db
    .prepare('SELECT id, sale_id, resolved_at FROM pending_receipt_reprints WHERE id = ?')
    .get(reprintId) as { id: string; sale_id: string; resolved_at: string | null } | undefined;
  if (!row) throw new Error(`reprint ${reprintId} not found`);
  if (row.resolved_at) throw new Error('reprint already resolved');

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pending_receipt_reprints
        SET resolved_at = ?, resolved_by = ?, resolution_notes = ?,
            updated_at = ?, updated_by = ?
        WHERE id = ?`,
  ).run(now, actorId, `DISCARDED: ${reason.trim()}`, now, actorId, reprintId);

  logAudit(db, {
    workerId: actorId,
    action: 'RECEIPT_REPRINT_DISCARDED',
    entityType: 'pending_receipt_reprints',
    entityId: reprintId,
    afterValue: { saleId: row.sale_id, reason: reason.trim() },
    deviceId,
  });
}

/** Marks a queued reprint as resolved after a (successful or assumed-successful)
 *  reprint. The actual print job is handled by the printer adapter at the
 *  call site so this module stays I/O-free. */
export function markReprintResolved(
  db: DB,
  reprintId: string,
  notes: string | null,
  actorId: string,
  deviceId: string,
): void {
  requireQueueRole(db, actorId);

  const row = db
    .prepare('SELECT id, sale_id, resolved_at FROM pending_receipt_reprints WHERE id = ?')
    .get(reprintId) as { id: string; sale_id: string; resolved_at: string | null } | undefined;
  if (!row) throw new Error(`reprint ${reprintId} not found`);
  if (row.resolved_at) throw new Error('reprint already resolved');

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pending_receipt_reprints
        SET resolved_at = ?, resolved_by = ?, resolution_notes = ?,
            updated_at = ?, updated_by = ?
        WHERE id = ?`,
  ).run(now, actorId, notes, now, actorId, reprintId);

  // Clear the printer_failed flag on the sale itself.
  db.prepare(
    `UPDATE sales SET printer_failed = 0, updated_at = ? WHERE id = ?`,
  ).run(now, row.sale_id);

  logAudit(db, {
    workerId: actorId,
    action: 'RECEIPT_REPRINTED',
    entityType: 'pending_receipt_reprints',
    entityId: reprintId,
    afterValue: { saleId: row.sale_id, notes },
    deviceId,
  });
}

export function pendingReprintCount(db: DB): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM pending_receipt_reprints WHERE resolved_at IS NULL')
    .get() as { n: number };
  return r.n;
}

import type { SaleReceipt } from '../printer/receipt.js';
import { getShopHeader } from './sales.js';
import { getReceiptConfig } from './receiptConfig.js';

/** Reconstruct a printable SaleReceipt from a stored sale. Used by reprint
 *  queue retry. Walks sale_lines + sales + customers in one read. */
export function buildSaleReceiptForReprint(
  db: DB,
  saleId: string,
): SaleReceipt | null {
  const sale = db.prepare(
    `SELECT s.id, s.created_at AS saleAt, s.channel,
            s.subtotal_pesewas AS subtotalPesewas,
            s.discount_pesewas AS discountPesewas,
            s.total_pesewas AS totalPesewas,
            s.payment_method AS paymentMethod,
            s.payment_reference AS paymentReference,
            s.customer_id AS customerId,
            w.full_name AS workerName
       FROM sales s
       JOIN workers w ON w.id = s.worker_id
      WHERE s.id = ?`,
  ).get(saleId) as
    | { id: string; saleAt: string; channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
        subtotalPesewas: number; discountPesewas: number; totalPesewas: number;
        paymentMethod: string; paymentReference: string | null;
        customerId: string | null; workerName: string }
    | undefined;
  if (!sale) return null;

  const lines = db.prepare(
    `SELECT sl.quantity AS quantity,
            p.name AS name,
            sl.unit_price_pesewas AS unitPricePesewas,
            sl.line_total_pesewas AS lineTotalPesewas,
            COALESCE(pu.unit_name, '') AS unitName
       FROM sale_lines sl
       LEFT JOIN products p ON p.id = sl.product_id
       LEFT JOIN product_units pu ON pu.id = sl.applied_unit_id
      WHERE sl.sale_id = ?
      ORDER BY sl.created_at`,
  ).all(saleId) as Array<{
    quantity: number; name: string; unitPricePesewas: number;
    lineTotalPesewas: number; unitName: string;
  }>;

  let customerName: string | null = null;
  if (sale.customerId) {
    const c = db.prepare('SELECT display_name FROM customers WHERE id = ?')
      .get(sale.customerId) as { display_name: string } | undefined;
    customerName = c ? c.display_name : null;
  }

  // Load tenders. After migration 0019 every sale has at least one
  // sale_payments row. Order by display_order so the receipt prints them in
  // the same sequence the cashier entered.
  const tenders = db.prepare(
    `SELECT payment_method AS method, amount_pesewas AS amountPesewas,
            reference, cash_given_pesewas AS cashGivenPesewas,
            change_pesewas AS changePesewas
       FROM sale_payments
      WHERE sale_id = ?
      ORDER BY display_order ASC, created_at ASC`,
  ).all(saleId) as Array<{
    method: string; amountPesewas: number; reference: string | null;
    cashGivenPesewas: number | null; changePesewas: number | null;
  }>;

  const shop = getShopHeader(db);
  const cfg = getReceiptConfig(db);

  return {
    shopName: cfg.shopName || shop.shopName,
    shopSubtitle: cfg.shopSubtitle ?? shop.shopSubtitle,
    headerLine3: cfg.headerLine3,
    headerLine4: cfg.headerLine4,
    footerText: cfg.footerText,
    showCashier: cfg.showCashier,
    showChannel: cfg.showChannel,
    showCustomer: cfg.showCustomer,
    receiptId: sale.id,
    workerName: sale.workerName,
    saleAt: sale.saleAt,
    channel: sale.channel,
    customerName,
    lines: lines.map((l) => ({
      quantity: l.quantity,
      name: l.unitName && l.unitName !== 'UNIT' ? `${l.name} (${l.unitName})` : l.name,
      unitPricePesewas: l.unitPricePesewas,
      lineTotalPesewas: l.lineTotalPesewas,
    })),
    subtotalPesewas: sale.subtotalPesewas,
    discountPesewas: sale.discountPesewas,
    totalPesewas: sale.totalPesewas,
    payment: {
      method: sale.paymentMethod,
      reference: sale.paymentReference,
      // For backwards-compat callers reading `payment.cashGiven`, derive
      // from the first CASH tender if any.
      cashGivenPesewas: tenders.find((t) => t.method === 'CASH')?.cashGivenPesewas ?? null,
      changePesewas: tenders.find((t) => t.method === 'CASH')?.changePesewas ?? null,
    },
    payments: tenders,
    printerFailedNotice: false,
  };
}
