// Debt collection workflow on top of the credit ledger.
//
// The money truth stays in sales + sale_payments + allocations (customerCredit).
// This service adds management state: due dates, recovery status, call/WhatsApp
// follow-ups, and payment promises.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { creditPrincipalExpr, type DebtStatus } from './customerCredit.js';

const DEBT_STATUSES = new Set<DebtStatus>([
  'CURRENT', 'OVERDUE', 'PROMISED', 'RECOVERABLE', 'DOUBTFUL', 'DEAD',
]);
const CONTACT_METHODS = new Set(['CALL', 'WHATSAPP', 'VISIT', 'IN_PERSON', 'SMS', 'OTHER']);
const FOLLOWUP_OUTCOMES = new Set([
  'NO_ANSWER', 'PROMISED_TO_PAY', 'PART_PAID', 'DISPUTED', 'REFUSED', 'REMINDER_SENT', 'OTHER',
]);
const PROMISE_STATUSES = new Set(['OPEN', 'KEPT', 'BROKEN', 'CANCELLED']);
const SENIOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

export type DebtContactMethod = 'CALL' | 'WHATSAPP' | 'VISIT' | 'IN_PERSON' | 'SMS' | 'OTHER';
export type DebtFollowupOutcome =
  | 'NO_ANSWER' | 'PROMISED_TO_PAY' | 'PART_PAID' | 'DISPUTED'
  | 'REFUSED' | 'REMINDER_SENT' | 'OTHER';
export type PaymentPromiseStatus = 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';

export interface DebtCollectionSale {
  saleId: string;
  customerId: string;
  customerName: string;
  phone: string;
  createdAt: string;
  totalPesewas: number;
  creditPesewas: number;
  paidPesewas: number;
  outstandingPesewas: number;
  dueDate: string | null;
  daysOverdue: number | null;
  debtStatus: DebtStatus;
  cashOnly: boolean;
  creditLimitPesewas: number;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  openPromise: {
    id: string;
    promisedAmountPesewas: number;
    promiseDueDate: string;
    status: PaymentPromiseStatus;
    notes: string | null;
  } | null;
}

export interface DebtFollowupRow {
  id: string;
  customerId: string;
  saleId: string | null;
  contactMethod: DebtContactMethod;
  outcome: DebtFollowupOutcome;
  notes: string | null;
  nextFollowUpAt: string | null;
  createdAt: string;
  workerName: string;
}

export interface PaymentPromiseRow {
  id: string;
  customerId: string;
  saleId: string | null;
  promisedAmountPesewas: number;
  promiseDueDate: string;
  status: PaymentPromiseStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDebtCollection {
  customerId: string;
  customerName: string;
  phone: string;
  cashOnly: boolean;
  blocked: boolean;
  blockedReason: string | null;
  creditLimitPesewas: number;
  totalOutstandingPesewas: number;
  oldestOverdueDays: number | null;
  openSales: DebtCollectionSale[];
  recentFollowUps: DebtFollowupRow[];
  promises: PaymentPromiseRow[];
}

function todayISO(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, days));
  return d.toISOString().slice(0, 10);
}

function daysBetweenDates(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${toDate}T00:00:00.000Z`).getTime();
  return Math.floor((to - from) / 86_400_000);
}

function effectiveStatus(status: DebtStatus, dueDate: string | null, now = new Date()): DebtStatus {
  if (status !== 'CURRENT') return status;
  return dueDate && dueDate < todayISO(now) ? 'OVERDUE' : 'CURRENT';
}

function requireSeniorForSevereStatus(db: DB, workerId: string, status: DebtStatus): void {
  if (status !== 'DOUBTFUL' && status !== 'DEAD') return;
  const w = db.prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(workerId) as { role: string; active: number; deleted_at: string | null; terminated_at: string | null } | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) throw new Error('worker not active');
  if (!SENIOR_ROLES.has(w.role)) {
    throw new Error(`status ${status} requires SUPERVISOR, OWNER, or FOUNDER`);
  }
}

function assertISODate(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
}

function mapSaleRow(r: {
  saleId: string; customerId: string; customerName: string; phone: string;
  cashOnly: number; creditLimitPesewas: number; createdAt: string;
  totalPesewas: number; creditPesewas: number; paidPesewas: number;
  dueDate: string | null; creditTermsDays: number; debtStatus: DebtStatus;
  lastFollowUpAt: string | null; nextFollowUpAt: string | null;
  promiseId: string | null; promisedAmountPesewas: number | null;
  promiseDueDate: string | null; promiseStatus: PaymentPromiseStatus | null;
  promiseNotes: string | null;
}, now = new Date()): DebtCollectionSale {
  const dueDate = r.dueDate ?? addDaysISO(r.createdAt, r.creditTermsDays);
  const outstanding = r.creditPesewas - r.paidPesewas;
  const daysOverdue = dueDate < todayISO(now) ? daysBetweenDates(dueDate, todayISO(now)) : null;
  return {
    saleId: r.saleId,
    customerId: r.customerId,
    customerName: r.customerName,
    phone: r.phone,
    createdAt: r.createdAt,
    totalPesewas: r.totalPesewas,
    creditPesewas: r.creditPesewas,
    paidPesewas: r.paidPesewas,
    outstandingPesewas: outstanding,
    dueDate,
    daysOverdue,
    debtStatus: effectiveStatus(r.debtStatus, dueDate, now),
    cashOnly: r.cashOnly === 1,
    creditLimitPesewas: r.creditLimitPesewas,
    lastFollowUpAt: r.lastFollowUpAt,
    nextFollowUpAt: r.nextFollowUpAt,
    openPromise: r.promiseId
      ? {
          id: r.promiseId,
          promisedAmountPesewas: r.promisedAmountPesewas ?? 0,
          promiseDueDate: r.promiseDueDate ?? '',
          status: r.promiseStatus ?? 'OPEN',
          notes: r.promiseNotes,
        }
      : null,
  };
}

function openDebtSales(db: DB, customerId?: string, now = new Date()): DebtCollectionSale[] {
  const whereCustomer = customerId ? 'AND s.customer_id = ?' : '';
  const rows = db.prepare(
    `SELECT s.id AS saleId,
            s.customer_id AS customerId,
            c.display_name AS customerName,
            c.phone,
            c.cash_only AS cashOnly,
            c.credit_limit_pesewas AS creditLimitPesewas,
            c.credit_terms_days AS creditTermsDays,
            s.created_at AS createdAt,
            s.total_pesewas AS totalPesewas,
            ${creditPrincipalExpr('s')} AS creditPesewas,
            COALESCE((SELECT SUM(amount_pesewas)
                        FROM customer_payment_allocations
                       WHERE sale_id = s.id), 0) AS paidPesewas,
            s.credit_due_date AS dueDate,
            s.debt_status AS debtStatus,
            (SELECT MAX(created_at) FROM customer_debt_followups f
              WHERE f.customer_id = s.customer_id AND (f.sale_id = s.id OR f.sale_id IS NULL))
              AS lastFollowUpAt,
            (SELECT MIN(next_follow_up_at) FROM customer_debt_followups f
              WHERE f.customer_id = s.customer_id
                AND (f.sale_id = s.id OR f.sale_id IS NULL)
                AND f.next_follow_up_at IS NOT NULL)
              AS nextFollowUpAt,
            p.id AS promiseId,
            p.promised_amount_pesewas AS promisedAmountPesewas,
            p.promise_due_date AS promiseDueDate,
            p.status AS promiseStatus,
            p.notes AS promiseNotes
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN customer_payment_promises p
         ON p.id = (
           SELECT p2.id FROM customer_payment_promises p2
            WHERE p2.customer_id = s.customer_id
              AND p2.status = 'OPEN'
              AND (p2.sale_id = s.id OR p2.sale_id IS NULL)
            ORDER BY p2.promise_due_date ASC, p2.created_at ASC
            LIMIT 1
         )
      WHERE s.is_credit = 1
        AND s.voided = 0
        AND s.customer_id IS NOT NULL
        ${whereCustomer}
      ORDER BY c.display_name ASC, s.created_at ASC`,
  ).all(...(customerId ? [customerId] : [])) as Parameters<typeof mapSaleRow>[0][];

  return rows
    .map((r) => mapSaleRow(r, now))
    .filter((s) => s.outstandingPesewas > 0);
}

export function getCustomerDebtCollection(db: DB, customerId: string, now = new Date()): CustomerDebtCollection {
  const c = db.prepare(
    `SELECT id, display_name AS customerName, phone, cash_only AS cashOnly,
            blocked, blocked_reason AS blockedReason,
            credit_limit_pesewas AS creditLimitPesewas
       FROM customers
      WHERE id = ? AND deleted_at IS NULL`,
  ).get(customerId) as
    | { id: string; customerName: string; phone: string; cashOnly: number; blocked: number; blockedReason: string | null; creditLimitPesewas: number }
    | undefined;
  if (!c) throw new Error(`customer ${customerId} not found`);

  const openSales = openDebtSales(db, customerId, now);
  const totalOutstanding = openSales.reduce((sum, s) => sum + s.outstandingPesewas, 0);
  const overdue = openSales
    .map((s) => s.daysOverdue)
    .filter((d): d is number => d !== null);

  const recentFollowUps = db.prepare(
    `SELECT f.id, f.customer_id AS customerId, f.sale_id AS saleId,
            f.contact_method AS contactMethod, f.outcome, f.notes,
            f.next_follow_up_at AS nextFollowUpAt,
            f.created_at AS createdAt,
            w.full_name AS workerName
       FROM customer_debt_followups f
       JOIN workers w ON w.id = f.created_by
      WHERE f.customer_id = ?
      ORDER BY f.created_at DESC
      LIMIT 20`,
  ).all(customerId) as DebtFollowupRow[];

  const promises = db.prepare(
    `SELECT id, customer_id AS customerId, sale_id AS saleId,
            promised_amount_pesewas AS promisedAmountPesewas,
            promise_due_date AS promiseDueDate,
            status, notes, created_at AS createdAt, updated_at AS updatedAt
       FROM customer_payment_promises
      WHERE customer_id = ?
      ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END,
               promise_due_date ASC, created_at DESC
      LIMIT 30`,
  ).all(customerId) as PaymentPromiseRow[];

  return {
    customerId: c.id,
    customerName: c.customerName,
    phone: c.phone,
    cashOnly: c.cashOnly === 1,
    blocked: c.blocked === 1,
    blockedReason: c.blockedReason,
    creditLimitPesewas: c.creditLimitPesewas,
    totalOutstandingPesewas: totalOutstanding,
    oldestOverdueDays: overdue.length ? Math.max(...overdue) : null,
    openSales,
    recentFollowUps,
    promises,
  };
}

export function listDebtCollectionQueue(
  db: DB,
  opts: { includeCurrent?: boolean; limit?: number } = {},
  now = new Date(),
): DebtCollectionSale[] {
  let rows = openDebtSales(db, undefined, now);
  if (!opts.includeCurrent) {
    rows = rows.filter((r) => r.debtStatus !== 'CURRENT' || r.daysOverdue !== null || r.openPromise);
  }
  rows.sort((a, b) => {
    const ao = a.daysOverdue ?? -1;
    const bo = b.daysOverdue ?? -1;
    if (bo !== ao) return bo - ao;
    return b.outstandingPesewas - a.outstandingPesewas;
  });
  return rows.slice(0, Math.min(Math.max(opts.limit ?? 100, 1), 500));
}

export function setSaleDebtStatus(
  db: DB,
  input: { saleId: string; status: DebtStatus; workerId: string; deviceId: string },
): void {
  if (!DEBT_STATUSES.has(input.status)) throw new Error(`invalid debt status '${input.status}'`);
  requireSeniorForSevereStatus(db, input.workerId, input.status);
  const sale = db.prepare('SELECT id, is_credit, voided FROM sales WHERE id = ?')
    .get(input.saleId) as { id: string; is_credit: number; voided: number } | undefined;
  if (!sale) throw new Error(`sale ${input.saleId} not found`);
  if (sale.is_credit !== 1 || sale.voided === 1) throw new Error('debt status can only be set on open credit sales');

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE sales
        SET debt_status = ?, debt_status_updated_at = ?, debt_status_updated_by = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(input.status, now, input.workerId, now, input.workerId, input.saleId);
  logAudit(db, {
    workerId: input.workerId,
    action: 'DEBT_STATUS_UPDATED',
    entityType: 'sales',
    entityId: input.saleId,
    afterValue: { status: input.status },
    deviceId: input.deviceId,
  });
}

export function recordDebtFollowUp(
  db: DB,
  input: {
    customerId: string;
    saleId?: string | null;
    contactMethod: DebtContactMethod;
    outcome: DebtFollowupOutcome;
    notes?: string | null;
    nextFollowUpAt?: string | null;
    promisedAmountPesewas?: number | null;
    promiseDueDate?: string | null;
    workerId: string;
    deviceId: string;
  },
): { followupId: string; promiseId: string | null } {
  if (!CONTACT_METHODS.has(input.contactMethod)) throw new Error(`invalid contact method '${input.contactMethod}'`);
  if (!FOLLOWUP_OUTCOMES.has(input.outcome)) throw new Error(`invalid follow-up outcome '${input.outcome}'`);
  if (input.nextFollowUpAt) assertISODate('nextFollowUpAt', input.nextFollowUpAt);

  const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL')
    .get(input.customerId) as { id: string } | undefined;
  if (!customer) throw new Error(`customer ${input.customerId} not found`);
  if (input.saleId) {
    const sale = db.prepare('SELECT customer_id, is_credit, voided FROM sales WHERE id = ?')
      .get(input.saleId) as { customer_id: string | null; is_credit: number; voided: number } | undefined;
    if (!sale || sale.customer_id !== input.customerId || sale.is_credit !== 1 || sale.voided === 1) {
      throw new Error(`sale ${input.saleId} is not an open credit sale for this customer`);
    }
  }

  let promiseId: string | null = null;
  if (input.outcome === 'PROMISED_TO_PAY') {
    if (!input.promiseDueDate) throw new Error('promiseDueDate is required when outcome is PROMISED_TO_PAY');
    assertISODate('promiseDueDate', input.promiseDueDate);
    if (!Number.isInteger(input.promisedAmountPesewas) || (input.promisedAmountPesewas ?? 0) <= 0) {
      throw new Error('promisedAmountPesewas must be a positive integer');
    }
    promiseId = `prom-${uuidv4()}`;
  }

  const followupId = `dfu-${uuidv4()}`;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO customer_debt_followups (
         id, customer_id, sale_id, contact_method, outcome, notes,
         next_follow_up_at, created_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      followupId,
      input.customerId,
      input.saleId ?? null,
      input.contactMethod,
      input.outcome,
      input.notes?.trim() || null,
      input.nextFollowUpAt ?? null,
      input.workerId,
      input.deviceId,
    );

    if (promiseId) {
      db.prepare(
        `INSERT INTO customer_payment_promises (
           id, customer_id, sale_id, promised_amount_pesewas, promise_due_date,
           status, notes, created_by, updated_by, device_id
         ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      ).run(
        promiseId,
        input.customerId,
        input.saleId ?? null,
        input.promisedAmountPesewas,
        input.promiseDueDate,
        input.notes?.trim() || null,
        input.workerId,
        input.workerId,
        input.deviceId,
      );
      if (input.saleId) {
        db.prepare(
          `UPDATE sales
              SET debt_status = 'PROMISED',
                  debt_status_updated_at = ?, debt_status_updated_by = ?,
                  updated_at = ?, updated_by = ?
            WHERE id = ?`,
        ).run(now, input.workerId, now, input.workerId, input.saleId);
      }
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'DEBT_FOLLOWUP_RECORDED',
      entityType: 'customer_debt_followups',
      entityId: followupId,
      afterValue: {
        customerId: input.customerId,
        saleId: input.saleId ?? null,
        contactMethod: input.contactMethod,
        outcome: input.outcome,
        nextFollowUpAt: input.nextFollowUpAt ?? null,
        promiseId,
      },
      deviceId: input.deviceId,
    });
  });
  tx();

  return { followupId, promiseId };
}

export function updatePaymentPromiseStatus(
  db: DB,
  input: {
    promiseId: string;
    status: PaymentPromiseStatus;
    fulfilledPaymentId?: string | null;
    workerId: string;
    deviceId: string;
  },
): void {
  if (!PROMISE_STATUSES.has(input.status)) throw new Error(`invalid promise status '${input.status}'`);
  const p = db.prepare('SELECT id FROM customer_payment_promises WHERE id = ?')
    .get(input.promiseId) as { id: string } | undefined;
  if (!p) throw new Error(`promise ${input.promiseId} not found`);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE customer_payment_promises
        SET status = ?, fulfilled_payment_id = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(input.status, input.fulfilledPaymentId ?? null, now, input.workerId, input.promiseId);
  logAudit(db, {
    workerId: input.workerId,
    action: 'PAYMENT_PROMISE_UPDATED',
    entityType: 'customer_payment_promises',
    entityId: input.promiseId,
    afterValue: { status: input.status, fulfilledPaymentId: input.fulfilledPaymentId ?? null },
    deviceId: input.deviceId,
  });
}
