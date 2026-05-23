// customerStatement.ts — assemble a printable statement for one customer.
//
// Wave C.1. The statement gathers:
//   - shop header (name, subtitle, owner phone)
//   - customer block (name, phone, type, credit limit, blocked flag)
//   - aging totals across 0-30, 31-60, 61-90, 90+
//   - open invoices (oldest first), with total/paid/outstanding/age/bucket
//   - recent payments (newest first) within the requested history window
//   - a suggested settle-by date for 31+ day balances
//
// The data is read-only — this is just a query / projection. The actual
// rendering and window.print() happen in the renderer.

import type { Database } from 'better-sqlite3';
import type { CustomerStatementResponse } from '../../shared/types/ipc.js';
import { listOpenSalesForCustomer } from './customerCredit.js';
import { getShopHeader } from './sales.js';

type DB = Database;

function todayISO(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function ageBucket(days: number): 'current' | '0_30' | '31_60' | '61_90' | '90_plus' {
  if (days <= 0) return 'current';
  if (days <= 30) return '0_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

function shortRef(id: string): string {
  return id.slice(-6).toUpperCase();
}

/** Owner phone — used as the "please contact" number on the statement. */
function getOwnerPhone(db: DB): string | null {
  const row = db
    .prepare(
      `SELECT phone FROM workers
        WHERE role IN ('OWNER', 'FOUNDER')
          AND active = 1 AND deleted_at IS NULL AND terminated_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get() as { phone: string } | undefined;
  return row?.phone ?? null;
}

export function buildCustomerStatement(
  db: DB,
  input: { customerId: string; asOfDate?: string; monthsOfHistory?: number },
  now = new Date(),
): CustomerStatementResponse {
  const cust = db
    .prepare(
      `SELECT id, display_name AS displayName, phone, customer_type AS customerType,
              credit_limit_pesewas AS creditLimitPesewas,
              blocked, blocked_reason AS blockedReason
         FROM customers WHERE id = ?`,
    )
    .get(input.customerId) as
    | {
        id: string;
        displayName: string;
        phone: string;
        customerType: string;
        creditLimitPesewas: number;
        blocked: number;
        blockedReason: string | null;
      }
    | undefined;
  if (!cust) {
    throw new Error(`buildCustomerStatement: customer ${input.customerId} not found`);
  }

  const asOf = input.asOfDate ?? todayISO(now);
  const months = input.monthsOfHistory ?? 6;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffISO = cutoff.toISOString();

  const open = listOpenSalesForCustomer(db, cust.id, now);

  const totals = {
    outstandingPesewas: 0,
    bucket0_30: 0,
    bucket31_60: 0,
    bucket61_90: 0,
    bucket90_plus: 0,
    paidThisPeriodPesewas: 0,
  };
  for (const s of open) {
    totals.outstandingPesewas += s.outstandingPesewas;
    if (s.ageDays <= 30) totals.bucket0_30 += s.outstandingPesewas;
    else if (s.ageDays <= 60) totals.bucket31_60 += s.outstandingPesewas;
    else if (s.ageDays <= 90) totals.bucket61_90 += s.outstandingPesewas;
    else totals.bucket90_plus += s.outstandingPesewas;
  }

  const openInvoices = open.map((s) => ({
    saleId: s.saleId,
    shortRef: shortRef(s.saleId),
    createdAt: s.createdAt,
    totalPesewas: s.totalPesewas,
    paidPesewas: s.paidPesewas,
    outstandingPesewas: s.outstandingPesewas,
    ageDays: s.ageDays,
    bucket: ageBucket(s.ageDays),
  }));

  // Payments within the history window, newest first.
  const paymentsRaw = db
    .prepare(
      `SELECT id, received_at AS receivedAt, amount_pesewas AS amountPesewas,
              payment_method AS paymentMethod, payment_reference AS paymentReference
         FROM customer_payments
        WHERE customer_id = ? AND received_at >= ?
        ORDER BY received_at DESC, rowid DESC`,
    )
    .all(cust.id, cutoffISO) as Array<{
    id: string;
    receivedAt: string;
    amountPesewas: number;
    paymentMethod: string;
    paymentReference: string | null;
  }>;

  for (const p of paymentsRaw) totals.paidThisPeriodPesewas += p.amountPesewas;

  const recentPayments = paymentsRaw.map((p) => ({
    paymentId: p.id,
    shortRef: shortRef(p.id),
    receivedAt: p.receivedAt,
    amountPesewas: p.amountPesewas,
    paymentMethod: p.paymentMethod,
    paymentReference: p.paymentReference,
  }));

  // Suggested settle-by date: 7 days from now, but at least the end of the
  // current week — owner can adjust verbally with the customer.
  const settleBy = new Date(now);
  settleBy.setDate(settleBy.getDate() + 7);

  const shop = getShopHeader(db);
  const ownerPhone = getOwnerPhone(db);

  return {
    shop: { name: shop.shopName, subtitle: shop.shopSubtitle, phone: ownerPhone },
    asOfDate: asOf,
    customer: {
      id: cust.id,
      displayName: cust.displayName,
      phone: cust.phone,
      customerType: cust.customerType,
      creditLimitPesewas: cust.creditLimitPesewas,
      blocked: !!cust.blocked,
      blockedReason: cust.blockedReason,
    },
    totals,
    openInvoices,
    recentPayments,
    pleaseSettleByDate: settleBy.toISOString().slice(0, 10),
  };
}
