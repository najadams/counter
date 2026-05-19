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
              COALESCE((SELECT SUM(amount_pesewas) FROM supplier_payment_allocations
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
  currentBalancePesewas: number;        // cached: positive = we owe them
  lifetimePaidPesewas: number;          // sum of all supplier_payments
  lifetimeReceivedCostPesewas: number;  // sum of stock receipts (line_total = qty * unit_cost)
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
              s.current_balance_pesewas AS currentBalancePesewas,
              COALESCE((SELECT SUM(amount_pesewas) FROM supplier_payments
                         WHERE supplier_id = s.id), 0) AS lifetimePaidPesewas,
              COALESCE((SELECT SUM(CAST(json_extract(al.after_value, '$.totalValuePesewas') AS INTEGER))
                         FROM audit_log al
                         WHERE al.action IN ('STOCK_RECEIVED','OPENING_STOCK_ENTERED')
                           AND json_extract(al.after_value, '$.supplierId') = s.id), 0)
                AS lifetimeReceivedCostPesewas,
              (SELECT MAX(paid_at) FROM supplier_payments
                 WHERE supplier_id = s.id) AS lastPaidAt,
              (SELECT MAX(al.created_at) FROM audit_log al
                 WHERE al.action IN ('STOCK_RECEIVED','OPENING_STOCK_ENTERED')
                   AND json_extract(al.after_value, '$.supplierId') = s.id)
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
  notes?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export interface RecordSupplierPaymentResult {
  paymentId: string;
  newSupplierBalancePesewas: number;
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

    // Decrement cached supplier balance. Allowed to go negative (we
    // overpaid / paid an advance) — schema doesn't constrain sign.
    db.prepare(
      `UPDATE suppliers SET current_balance_pesewas = current_balance_pesewas - ?,
                            updated_at = ?, updated_by = ?
         WHERE id = ?`,
    ).run(input.amountPesewas, now, input.actorWorkerId, input.supplierId);

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
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  const after = db
    .prepare('SELECT current_balance_pesewas FROM suppliers WHERE id = ?')
    .get(input.supplierId) as { current_balance_pesewas: number };

  return { paymentId, newSupplierBalancePesewas: after.current_balance_pesewas };
}
