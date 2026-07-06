// Supplier payments admin: list, record. OWNER/FOUNDER only.
//
// supplier_payments holds lump-sum payments to a supplier. Each payment
// optionally splits into supplier_payment_allocations against individual
// POs — but in informal trade we mostly just record the lump sum and
// reconcile against the supplier's overall outstanding balance.
//
// suppliers.current_balance_pesewas is a denormalized cache:
//   positive = we owe them (goods received but not yet paid for)
// Recording a payment decrements that cache; allocations against
// purchase_orders.total_paid_pesewas are handled separately because POs
// are not always in use (StockReceive bypasses them).

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
    throw new Error('actor worker not found or inactive');
  }
  if (!ADMIN_ROLES.has(w.role)) {
    throw new Error(`actor role ${w.role} not permitted (need OWNER or FOUNDER)`);
  }
}

export interface SupplierPaymentRow {
  id: string;
  supplierId: string;
  supplierName: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference: string | null;
  paidAt: string;
  approvedByWorkerId: string;
  approvedByName: string;
  notes: string | null;
  createdAt: string;
  allocatedPesewas: number;
}

export interface SupplierInvoiceRow {
  id: string;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  totalPesewas: number;
  totalPaidPesewas: number;
  outstandingPesewas: number;
  status: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'DISPUTED' | 'VOID';
  notes: string | null;
  createdAt: string;
}

export interface SupplierStatementLineRow {
  invoiceId: string;
  invoiceNumber: string;
  productSku: string;
  productName: string;
  quantity: number;
  canonicalQuantity: number;
  unitName: string | null;
  unitCostPesewas: number;
  lineTotalPesewas: number;
  allocatedTransportCostPesewas: number;
  allocatedLoadingCostPesewas: number;
  landedLineTotalPesewas: number;
}

export interface ListSupplierPaymentsInput {
  supplierId?: string | null;
  /** ISO date YYYY-MM-DD inclusive */
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListSupplierPaymentsResult {
  payments: SupplierPaymentRow[];
  totalCount: number;
}

export function listSupplierPayments(
  db: DB, input: ListSupplierPaymentsInput = {},
): ListSupplierPaymentsResult {
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.supplierId) {
    where.push('sp.supplier_id = ?');
    params.push(input.supplierId);
  }
  if (input.fromDate) {
    where.push("date(sp.paid_at) >= date(?)");
    params.push(input.fromDate);
  }
  if (input.toDate) {
    where.push("date(sp.paid_at) <= date(?)");
    params.push(input.toDate);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM supplier_payments sp ${whereSql}`)
    .get(...params) as { n: number };

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT sp.id, sp.supplier_id AS supplierId, s.name AS supplierName,
              sp.amount_pesewas AS amountPesewas,
              sp.payment_method AS paymentMethod,
              sp.payment_reference AS paymentReference,
              sp.paid_at AS paidAt,
              sp.approved_by AS approvedByWorkerId,
              w.full_name AS approvedByName,
              sp.notes,
              sp.created_at AS createdAt,
              COALESCE((SELECT SUM(amount_pesewas) FROM supplier_invoice_payment_allocations
                         WHERE supplier_payment_id = sp.id), 0) AS allocatedPesewas
         FROM supplier_payments sp
         JOIN suppliers s ON s.id = sp.supplier_id
         JOIN workers w ON w.id = sp.approved_by
         ${whereSql}
         ORDER BY sp.paid_at DESC, sp.created_at DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as SupplierPaymentRow[];

  return { payments: rows, totalCount: totalRow.n };
}

export interface SupplierStatementRow {
  supplierId: string;
  supplierName: string;
  active: boolean;
  paymentTermsDays: number;
  creditLimitPesewas: number;
  paymentSchedule: string;
  currentBalancePesewas: number;        // cached: positive = we owe them
  lifetimePaidPesewas: number;          // sum of all supplier_payments
  lifetimeReceivedCostPesewas: number;  // sum of landed receipt lines
  openInvoiceCount: number;
  overdueInvoiceCount: number;
  nextDueDate: string | null;
  lastPaidAt: string | null;
  lastReceiptAt: string | null;
}

/**
 * One row per supplier (active by default) with a money summary suitable for
 * the "How much do we owe whom?" view.
 *
 * Caveat on lifetimeReceivedCostPesewas: stock_movements does NOT have a
 * supplier_id column today — receiveStock() only logs the supplier into the
 * audit_log JSON. So we extract it back out of audit_log for an honest
 * lifetime-received total. It will be 0 for any historical data that
 * predates this auditing convention.
 */
export function listSupplierStatements(
  db: DB, includeInactive = false,
): SupplierStatementRow[] {
  const whereActive = includeInactive ? '' : 'AND s.active = 1';
  return db
    .prepare(
      `SELECT s.id AS supplierId, s.name AS supplierName, s.active AS active,
              s.payment_terms_days AS paymentTermsDays,
              s.credit_limit_pesewas AS creditLimitPesewas,
              s.payment_schedule AS paymentSchedule,
              s.current_balance_pesewas AS currentBalancePesewas,
              COALESCE((SELECT SUM(amount_pesewas) FROM supplier_payments
                         WHERE supplier_id = s.id), 0) AS lifetimePaidPesewas,
              COALESCE((SELECT SUM(CASE
                           WHEN landed_line_total_pesewas > 0 THEN landed_line_total_pesewas
                           ELSE line_total_pesewas
                         END)
                         FROM supplier_invoice_lines sil
                         JOIN supplier_invoices si ON si.id = sil.supplier_invoice_id
                         WHERE si.supplier_id = s.id AND si.status != 'VOID'), 0)
                AS lifetimeReceivedCostPesewas,
              (SELECT COUNT(*) FROM supplier_invoices si
                 WHERE si.supplier_id = s.id AND si.status IN ('OPEN','PARTIALLY_PAID','DISPUTED'))
                AS openInvoiceCount,
              (SELECT COUNT(*) FROM supplier_invoices si
                 WHERE si.supplier_id = s.id AND si.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
                   AND si.due_date IS NOT NULL AND si.due_date < date('now'))
                AS overdueInvoiceCount,
              (SELECT MIN(due_date) FROM supplier_invoices si
                 WHERE si.supplier_id = s.id AND si.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
                   AND si.due_date IS NOT NULL)
                AS nextDueDate,
              (SELECT MAX(paid_at) FROM supplier_payments
                 WHERE supplier_id = s.id) AS lastPaidAt,
              (SELECT MAX(created_at) FROM supplier_invoices si
                 WHERE si.supplier_id = s.id)
                AS lastReceiptAt
         FROM suppliers s
         WHERE s.deleted_at IS NULL ${whereActive}
         ORDER BY s.current_balance_pesewas DESC, s.name ASC`,
    )
    .all()
    .map((r) => ({ ...(r as object), active: ((r as { active: number }).active) === 1 })) as SupplierStatementRow[];
}

export interface RecordSupplierPaymentInput {
  supplierId: string;
  amountPesewas: number;
  paymentMethod: string;         // FK into payment_methods.code
  paymentReference?: string | null;
  paidAt?: string | null;        // ISO; defaults to now
  allocations?: Array<{ supplierInvoiceId: string; amountPesewas: number }>;
  notes?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export interface RecordSupplierPaymentResult {
  paymentId: string;
  newSupplierBalancePesewas: number;
  totalAllocatedPesewas: number;
  unallocatedPesewas: number;
  allocations: Array<{ supplierInvoiceId: string; amountPesewas: number }>;
}

function listOpenSupplierInvoices(db: DB, supplierId: string): SupplierInvoiceRow[] {
  return db.prepare(
    `SELECT si.id, si.supplier_id AS supplierId, s.name AS supplierName,
            si.purchase_order_id AS purchaseOrderId,
            si.invoice_number AS invoiceNumber, si.invoice_date AS invoiceDate,
            si.due_date AS dueDate, si.total_pesewas AS totalPesewas,
            si.total_paid_pesewas AS totalPaidPesewas,
            si.total_pesewas - si.total_paid_pesewas AS outstandingPesewas,
            si.status, si.notes, si.created_at AS createdAt
       FROM supplier_invoices si
       JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.supplier_id = ?
        AND si.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
        AND si.total_pesewas > si.total_paid_pesewas
      ORDER BY COALESCE(si.due_date, si.invoice_date) ASC, si.created_at ASC`,
  ).all(supplierId) as SupplierInvoiceRow[];
}

export function recordSupplierPayment(
  db: DB, input: RecordSupplierPaymentInput,
): RecordSupplierPaymentResult {
  requireAdmin(db, input.actorWorkerId);

  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('amountPesewas must be a positive integer (in pesewas)');
  }

  const pm = db
    .prepare('SELECT code, requires_reference, active FROM payment_methods WHERE code = ?')
    .get(input.paymentMethod) as
    | { code: string; requires_reference: number; active: number }
    | undefined;
  if (!pm) throw new Error(`unknown payment method '${input.paymentMethod}'`);
  if (pm.active !== 1) throw new Error(`payment method '${input.paymentMethod}' is inactive`);
  if (pm.code === 'CREDIT') {
    throw new Error("payment method 'CREDIT' is not valid for supplier payments");
  }
  if (pm.requires_reference === 1 &&
      (!input.paymentReference || !input.paymentReference.trim())) {
    throw new Error(`${pm.code} payment requires a reference number`);
  }

  const sup = db
    .prepare('SELECT id, current_balance_pesewas, active FROM suppliers WHERE id = ? AND deleted_at IS NULL')
    .get(input.supplierId) as
    | { id: string; current_balance_pesewas: number; active: number }
    | undefined;
  if (!sup) throw new Error(`supplier ${input.supplierId} not found`);
  // Inactive suppliers are allowed (paying off old debt), but warn upstream if needed.

  const paymentId = `spay-${uuidv4()}`;
  const now = new Date().toISOString();
  const paidAt = input.paidAt ?? now;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO supplier_payments (
         id, supplier_id, amount_pesewas, payment_method, payment_reference,
         paid_at, approved_by, notes,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      paymentId, input.supplierId, input.amountPesewas,
      input.paymentMethod, input.paymentReference?.trim() || null,
      paidAt, input.actorWorkerId, input.notes?.trim() || null,
      input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );

    const openInvoices = listOpenSupplierInvoices(db, input.supplierId);
    let plan: Array<{ supplierInvoiceId: string; amountPesewas: number }>;
    if (input.allocations && input.allocations.length > 0) {
      const openMap = new Map(openInvoices.map((i) => [i.id, i]));
      const sum = input.allocations.reduce((s, a) => s + a.amountPesewas, 0);
      if (sum > input.amountPesewas) throw new Error(`supplier payment allocations exceed payment amount`);
      for (const a of input.allocations) {
        const inv = openMap.get(a.supplierInvoiceId);
        if (!inv) throw new Error(`invoice ${a.supplierInvoiceId} is not open for this supplier`);
        if (!Number.isInteger(a.amountPesewas) || a.amountPesewas <= 0) throw new Error('allocation amount must be positive');
        if (a.amountPesewas > inv.outstandingPesewas) throw new Error(`allocation exceeds invoice outstanding`);
      }
      plan = input.allocations;
    } else {
      plan = [];
      let remaining = input.amountPesewas;
      for (const inv of openInvoices) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, inv.outstandingPesewas);
        if (take > 0) plan.push({ supplierInvoiceId: inv.id, amountPesewas: take });
        remaining -= take;
      }
    }
    const totalAllocated = plan.reduce((s, a) => s + a.amountPesewas, 0);

    // Decrement cached supplier balance. Allowed to go negative (we
    // overpaid / paid an advance) — schema doesn't constrain sign.
    db.prepare(
      `UPDATE suppliers SET current_balance_pesewas = current_balance_pesewas - ?,
                            updated_at = ?, updated_by = ?
         WHERE id = ?`,
    ).run(input.amountPesewas, now, input.actorWorkerId, input.supplierId);

    for (const a of plan) {
      db.prepare(
        `INSERT INTO supplier_invoice_payment_allocations (
           id, supplier_payment_id, supplier_invoice_id, amount_pesewas,
           created_by, updated_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `sipa-${uuidv4()}`, paymentId, a.supplierInvoiceId, a.amountPesewas,
        input.actorWorkerId, input.actorWorkerId, input.deviceId,
      );
      db.prepare(
        `UPDATE supplier_invoices
            SET total_paid_pesewas = total_paid_pesewas + ?,
                status = CASE
                  WHEN total_paid_pesewas + ? >= total_pesewas THEN 'PAID'
                  ELSE 'PARTIALLY_PAID'
                END,
                updated_at = ?, updated_by = ?
          WHERE id = ?`,
      ).run(a.amountPesewas, a.amountPesewas, now, input.actorWorkerId, a.supplierInvoiceId);

      const invoice = db.prepare(
        `SELECT purchase_order_id AS purchaseOrderId
           FROM supplier_invoices
          WHERE id = ?`,
      ).get(a.supplierInvoiceId) as { purchaseOrderId: string | null } | undefined;
      if (invoice?.purchaseOrderId) {
        db.prepare(
          `INSERT INTO supplier_payment_allocations (
             id, supplier_payment_id, purchase_order_id, amount_pesewas,
             created_by, updated_by, device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `spa-${uuidv4()}`,
          paymentId,
          invoice.purchaseOrderId,
          a.amountPesewas,
          input.actorWorkerId,
          input.actorWorkerId,
          input.deviceId,
        );
        db.prepare(
          `UPDATE purchase_orders
              SET total_paid_pesewas = total_paid_pesewas + ?,
                  paid_at = CASE
                    WHEN total_paid_pesewas + ? >= total_ordered_pesewas THEN COALESCE(paid_at, ?)
                    ELSE paid_at
                  END,
                  status = CASE
                    WHEN total_paid_pesewas + ? >= total_ordered_pesewas THEN 'PAID'
                    ELSE status
                  END,
                  updated_at = ?, updated_by = ?
            WHERE id = ?`,
        ).run(
          a.amountPesewas,
          a.amountPesewas,
          paidAt,
          a.amountPesewas,
          now,
          input.actorWorkerId,
          invoice.purchaseOrderId,
        );
      }
    }

    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'SUPPLIER_PAYMENT_RECORDED',
      entityType: 'supplier_payments',
      entityId: paymentId,
      afterValue: {
        supplierId: input.supplierId,
        amountPesewas: input.amountPesewas,
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference?.trim() || null,
        paidAt,
        totalAllocatedPesewas: totalAllocated,
        unallocatedPesewas: input.amountPesewas - totalAllocated,
        allocations: plan,
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  const after = db
    .prepare('SELECT current_balance_pesewas FROM suppliers WHERE id = ?')
    .get(input.supplierId) as { current_balance_pesewas: number };

  const allocations = db.prepare(
    `SELECT supplier_invoice_id AS supplierInvoiceId, amount_pesewas AS amountPesewas
       FROM supplier_invoice_payment_allocations
      WHERE supplier_payment_id = ?
      ORDER BY created_at ASC`,
  ).all(paymentId) as Array<{ supplierInvoiceId: string; amountPesewas: number }>;
  const totalAllocated = allocations.reduce((s, a) => s + a.amountPesewas, 0);

  return {
    paymentId,
    newSupplierBalancePesewas: after.current_balance_pesewas,
    totalAllocatedPesewas: totalAllocated,
    unallocatedPesewas: input.amountPesewas - totalAllocated,
    allocations,
  };
}

export function listSupplierInvoices(
  db: DB,
  input: { supplierId?: string | null; includePaid?: boolean; limit?: number } = {},
): SupplierInvoiceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.supplierId) { where.push('si.supplier_id = ?'); params.push(input.supplierId); }
  if (!input.includePaid) where.push("si.status != 'PAID' AND si.status != 'VOID'");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT si.id, si.supplier_id AS supplierId, s.name AS supplierName,
            si.purchase_order_id AS purchaseOrderId,
            si.invoice_number AS invoiceNumber, si.invoice_date AS invoiceDate,
            si.due_date AS dueDate, si.total_pesewas AS totalPesewas,
            si.total_paid_pesewas AS totalPaidPesewas,
            si.total_pesewas - si.total_paid_pesewas AS outstandingPesewas,
            si.status, si.notes, si.created_at AS createdAt
       FROM supplier_invoices si
       JOIN suppliers s ON s.id = si.supplier_id
       ${whereSql}
      ORDER BY COALESCE(si.due_date, si.invoice_date) ASC, si.created_at DESC
      LIMIT ?`,
  ).all(...params, Math.min(Math.max(input.limit ?? 100, 1), 500)) as SupplierInvoiceRow[];
}

export function getSupplierStatementLines(
  db: DB,
  supplierId: string,
  includePaid = false,
): SupplierStatementLineRow[] {
  const paidSql = includePaid ? '' : "AND si.status != 'PAID'";
  return db.prepare(
    `SELECT si.id AS invoiceId, si.invoice_number AS invoiceNumber,
            p.sku AS productSku, p.name AS productName,
            sil.quantity, sil.canonical_quantity AS canonicalQuantity,
            pu.unit_name AS unitName,
            sil.unit_cost_pesewas AS unitCostPesewas,
            sil.line_total_pesewas AS lineTotalPesewas,
            sil.allocated_transport_cost_pesewas AS allocatedTransportCostPesewas,
            sil.allocated_loading_cost_pesewas AS allocatedLoadingCostPesewas,
            CASE WHEN sil.landed_line_total_pesewas > 0 THEN sil.landed_line_total_pesewas
                 ELSE sil.line_total_pesewas
            END AS landedLineTotalPesewas
       FROM supplier_invoice_lines sil
       JOIN supplier_invoices si ON si.id = sil.supplier_invoice_id
       JOIN products p ON p.id = sil.product_id
       LEFT JOIN product_units pu ON pu.id = sil.source_unit_id
      WHERE si.supplier_id = ? ${paidSql}
      ORDER BY COALESCE(si.due_date, si.invoice_date) ASC, si.invoice_number ASC, p.name ASC`,
  ).all(supplierId) as SupplierStatementLineRow[];
}
