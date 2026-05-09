// Customer credit + debt tracking.
//
// The truth lives in:
//   sum of (sales.total_pesewas where customer_id = X and is_credit = 1 and voided = 0)
//   - sum of (customer_payment_allocations.amount where sale_id in those sales)
//
// customers.current_balance_pesewas is a denormalized cache, updated
// atomically with each credit-sale insert, void, and payment allocation.
// reconcileCustomerBalance() recomputes from truth — used to detect drift.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { assertNotSealed } from './periods.js';

export interface CustomerOverview {
  id: string;
  displayName: string;
  phone: string;
  customerType: string;
  creditLimitPesewas: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  cachedBalancePesewas: number;
  trueBalancePesewas: number;
  /** Cache vs truth difference. 0 means in sync. Non-zero means call reconcile. */
  driftPesewas: number;
  blocked: boolean;
  blockedReason: string | null;
  utilizationBps: number;          // balance / limit, 0..10000+; >10000 = over limit
  ageOfOldestUnpaidDays: number | null;
  agingBuckets: { bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number };
  recentSales: Array<{ id: string; createdAt: string; totalPesewas: number; amountOutstandingPesewas: number; voided: boolean }>;
  recentPayments: Array<{ id: string; receivedAt: string; amountPesewas: number; paymentMethod: string; paymentReference: string | null }>;
}

export interface OpenSale {
  saleId: string;
  createdAt: string;
  totalPesewas: number;
  paidPesewas: number;            // sum of allocations to this sale
  outstandingPesewas: number;     // total - paid
  ageDays: number;
}

function ageDays(iso: string, now = new Date()): number {
  const t = new Date(iso).getTime();
  return Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
}

function bucketFor(age: number): 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90_plus' {
  if (age <= 30) return 'bucket0_30';
  if (age <= 60) return 'bucket31_60';
  if (age <= 90) return 'bucket61_90';
  return 'bucket90_plus';
}

/** Open credit sales for a customer (any with outstanding > 0), oldest first. */
export function listOpenSalesForCustomer(db: DB, customerId: string, now = new Date()): OpenSale[] {
  const sales = db
    .prepare(
      `SELECT s.id, s.created_at AS createdAt, s.total_pesewas AS totalPesewas,
              COALESCE((SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                          WHERE sale_id = s.id), 0) AS paidPesewas
         FROM sales s
         WHERE s.customer_id = ? AND s.is_credit = 1 AND s.voided = 0
         ORDER BY s.created_at ASC`,
    )
    .all(customerId) as Array<{ id: string; createdAt: string; totalPesewas: number; paidPesewas: number }>;

  return sales
    .map((s) => ({
      saleId: s.id,
      createdAt: s.createdAt,
      totalPesewas: s.totalPesewas,
      paidPesewas: s.paidPesewas,
      outstandingPesewas: s.totalPesewas - s.paidPesewas,
      ageDays: ageDays(s.createdAt, now),
    }))
    .filter((s) => s.outstandingPesewas > 0);
}

/** Recompute customer.current_balance_pesewas from truth and update the cache. */
export function reconcileCustomerBalance(db: DB, customerId: string): { previousCached: number; newCached: number; driftPesewas: number } {
  const trueBalance = computeTrueBalance(db, customerId);
  const cust = db
    .prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?')
    .get(customerId) as { current_balance_pesewas: number } | undefined;
  if (!cust) throw new Error(`reconcileCustomerBalance: customer ${customerId} not found`);

  const previousCached = cust.current_balance_pesewas;
  if (previousCached !== trueBalance) {
    db.prepare(
      'UPDATE customers SET current_balance_pesewas = ?, updated_at = ? WHERE id = ?',
    ).run(trueBalance, new Date().toISOString(), customerId);
  }
  return {
    previousCached,
    newCached: trueBalance,
    driftPesewas: previousCached - trueBalance,
  };
}

function computeTrueBalance(db: DB, customerId: string): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(total_pesewas) FROM sales
                     WHERE customer_id = ? AND is_credit = 1 AND voided = 0), 0)
         -
         COALESCE((SELECT SUM(cpa.amount_pesewas) FROM customer_payment_allocations cpa
                     JOIN sales s ON s.id = cpa.sale_id
                     WHERE s.customer_id = ?), 0) AS balance`,
    )
    .get(customerId, customerId) as { balance: number };
  return row.balance;
}

export function getCustomerOverview(db: DB, customerId: string, now = new Date()): CustomerOverview {
  const cust = db
    .prepare(
      `SELECT id, display_name AS displayName, phone, customer_type AS customerType,
              credit_limit_pesewas AS creditLimitPesewas,
              current_balance_pesewas AS cachedBalancePesewas,
              blocked, blocked_reason AS blockedReason,
              preferred_channel AS preferredChannel
         FROM customers WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(customerId) as
    | { id: string; displayName: string; phone: string; customerType: string;
        creditLimitPesewas: number; cachedBalancePesewas: number;
        blocked: number; blockedReason: string | null;
        preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null }
    | undefined;
  if (!cust) throw new Error(`getCustomerOverview: customer ${customerId} not found`);

  const trueBalance = computeTrueBalance(db, customerId);
  const open = listOpenSalesForCustomer(db, customerId, now);
  const buckets = { bucket0_30: 0, bucket31_60: 0, bucket61_90: 0, bucket90_plus: 0 };
  let oldestAge: number | null = null;
  for (const s of open) {
    buckets[bucketFor(s.ageDays)] += s.outstandingPesewas;
    if (oldestAge === null || s.ageDays > oldestAge) oldestAge = s.ageDays;
  }

  const recentSales = db
    .prepare(
      `SELECT s.id, s.created_at AS createdAt, s.total_pesewas AS totalPesewas, s.voided,
              COALESCE((SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                          WHERE sale_id = s.id), 0) AS paidPesewas
         FROM sales s WHERE s.customer_id = ?
         ORDER BY s.created_at DESC LIMIT 10`,
    )
    .all(customerId) as Array<{ id: string; createdAt: string; totalPesewas: number; voided: number; paidPesewas: number }>;

  const recentPayments = db
    .prepare(
      `SELECT id, received_at AS receivedAt, amount_pesewas AS amountPesewas,
              payment_method AS paymentMethod, payment_reference AS paymentReference
         FROM customer_payments WHERE customer_id = ?
         ORDER BY received_at DESC LIMIT 10`,
    )
    .all(customerId) as Array<{ id: string; receivedAt: string; amountPesewas: number; paymentMethod: string; paymentReference: string | null }>;

  const utilizationBps =
    cust.creditLimitPesewas > 0
      ? Math.floor((trueBalance * 10000) / cust.creditLimitPesewas)
      : (trueBalance > 0 ? 99999 : 0);

  return {
    id: cust.id,
    displayName: cust.displayName,
    phone: cust.phone,
    customerType: cust.customerType,
    creditLimitPesewas: cust.creditLimitPesewas,
    preferredChannel: cust.preferredChannel,
    cachedBalancePesewas: cust.cachedBalancePesewas,
    trueBalancePesewas: trueBalance,
    driftPesewas: cust.cachedBalancePesewas - trueBalance,
    blocked: cust.blocked === 1,
    blockedReason: cust.blockedReason,
    utilizationBps,
    ageOfOldestUnpaidDays: oldestAge,
    agingBuckets: buckets,
    recentSales: recentSales.map((s) => ({
      id: s.id, createdAt: s.createdAt, totalPesewas: s.totalPesewas,
      amountOutstandingPesewas: s.totalPesewas - s.paidPesewas,
      voided: s.voided === 1,
    })),
    recentPayments,
  };
}

export interface RecordPaymentInput {
  customerId: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference?: string | null;
  /** Optional manual allocation. If omitted, FIFO-allocates oldest first. */
  allocations?: Array<{ saleId: string; amountPesewas: number }>;
  notes?: string | null;
  shiftId?: string | null;
  workerId: string;
  deviceId: string;
}

export interface RecordPaymentResult {
  paymentId: string;
  totalAllocatedPesewas: number;
  unallocatedPesewas: number;     // overpayment that doesn't fit on any open sale
  allocations: Array<{ saleId: string; amountPesewas: number }>;
  newBalancePesewas: number;
}

/**
 * Record a customer payment + allocate it (FIFO by default; manual if
 * allocations[] provided). Updates customers.current_balance_pesewas in the
 * same transaction. Refuses zero / negative amounts. Refuses MoMo without ref.
 *
 * If the payment exceeds total outstanding, the unallocated amount is still
 * recorded on the payment row but no allocations are made for the excess —
 * the customer effectively has credit with the shop. This is rare but
 * legitimate (deposit before purchase). The result reports both numbers.
 */
export function recordCustomerPayment(
  db: DB, input: RecordPaymentInput,
): RecordPaymentResult {
  // Day-lock guard: today's date cannot be sealed when recording a payment.
  // We use DEFAULT_LOCATION_ID since payments are not yet location-tagged in
  // the schema. Future multi-location work should add input.locationId.
  const todayISO = new Date().toISOString().slice(0, 10);
  assertNotSealed(db, DEFAULT_LOCATION_ID, todayISO, 'recording a customer payment');
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('recordCustomerPayment: amountPesewas must be a positive integer');
  }
  if (input.paymentMethod.startsWith('MOMO_') &&
      (!input.paymentReference || input.paymentReference.trim() === '')) {
    throw new Error('MoMo payment requires a transaction reference');
  }

  const cust = db
    .prepare('SELECT id, current_balance_pesewas FROM customers WHERE id = ? AND deleted_at IS NULL')
    .get(input.customerId) as { id: string; current_balance_pesewas: number } | undefined;
  if (!cust) throw new Error(`recordCustomerPayment: customer ${input.customerId} not found`);

  const openSales = listOpenSalesForCustomer(db, input.customerId);

  // Compute the allocation plan.
  let plan: Array<{ saleId: string; amountPesewas: number }>;
  if (input.allocations && input.allocations.length > 0) {
    const sum = input.allocations.reduce((s, a) => s + a.amountPesewas, 0);
    if (sum > input.amountPesewas) {
      throw new Error(`allocations total ${sum} > payment amount ${input.amountPesewas}`);
    }
    // Validate every saleId is one of this customer's open sales.
    const openMap = new Map(openSales.map((s) => [s.saleId, s]));
    for (const a of input.allocations) {
      if (!openMap.has(a.saleId)) {
        throw new Error(`allocation references sale ${a.saleId} which is not open for this customer`);
      }
      if (!Number.isInteger(a.amountPesewas) || a.amountPesewas <= 0) {
        throw new Error(`allocation amount must be a positive integer`);
      }
      const sale = openMap.get(a.saleId)!;
      if (a.amountPesewas > sale.outstandingPesewas) {
        throw new Error(
          `allocation of ${a.amountPesewas} on sale ${a.saleId} exceeds outstanding ${sale.outstandingPesewas}`,
        );
      }
    }
    plan = input.allocations;
  } else {
    // FIFO: walk oldest-first and consume.
    plan = [];
    let remaining = input.amountPesewas;
    for (const s of openSales) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, s.outstandingPesewas);
      if (take > 0) plan.push({ saleId: s.saleId, amountPesewas: take });
      remaining -= take;
    }
  }

  const totalAllocated = plan.reduce((s, a) => s + a.amountPesewas, 0);
  const unallocated = input.amountPesewas - totalAllocated;
  const paymentId = `cp-${uuidv4()}`;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO customer_payments (
         id, customer_id, amount_pesewas, payment_method, payment_reference,
         received_at, received_by, shift_id, notes,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      paymentId, input.customerId, input.amountPesewas,
      input.paymentMethod, input.paymentReference ?? null,
      now, input.workerId, input.shiftId ?? null,
      input.notes ?? null,
      input.workerId, input.workerId, input.deviceId,
    );

    for (const a of plan) {
      db.prepare(
        `INSERT INTO customer_payment_allocations
           (id, customer_payment_id, sale_id, amount_pesewas,
            created_by, updated_by, device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `cpa-${uuidv4()}`, paymentId, a.saleId, a.amountPesewas,
        input.workerId, input.workerId, input.deviceId,
      );
    }

    // Update cached balance: decrement by allocated amount only.
    // Unallocated overpayment does NOT reduce the balance (there's nothing
    // to apply it against), but it's still recorded on customer_payments.
    if (totalAllocated > 0) {
      db.prepare(
        `UPDATE customers SET current_balance_pesewas = current_balance_pesewas - ?,
                              updated_at = ?, updated_by = ?
           WHERE id = ?`,
      ).run(totalAllocated, now, input.workerId, input.customerId);
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'CUSTOMER_PAYMENT_RECORDED',
      entityType: 'customer_payments',
      entityId: paymentId,
      afterValue: {
        customerId: input.customerId,
        amountPesewas: input.amountPesewas,
        paymentMethod: input.paymentMethod,
        totalAllocatedPesewas: totalAllocated,
        unallocatedPesewas: unallocated,
        allocations: plan,
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  const newBalance = cust.current_balance_pesewas - totalAllocated;
  return {
    paymentId,
    totalAllocatedPesewas: totalAllocated,
    unallocatedPesewas: unallocated,
    allocations: plan,
    newBalancePesewas: newBalance,
  };
}

export interface CustomerWithOutstanding {
  id: string;
  displayName: string;
  phone: string;
  customerType: string;
  creditLimitPesewas: number;
  trueBalancePesewas: number;
  blocked: boolean;
  ageOfOldestUnpaidDays: number | null;
  oldestUnpaidBucket: 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90_plus' | null;
  /** True if the cached balance disagrees with the recomputed truth — UI flags this. */
  needsReconcile: boolean;
}

export interface ListCustomersByOutstandingOptions {
  agingBucket?: 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90_plus';
  includeBlocked?: boolean;
  includeZeroBalance?: boolean;
  limit?: number;
}

export function listCustomersByOutstanding(
  db: DB, opts: ListCustomersByOutstandingOptions = {}, now = new Date(),
): CustomerWithOutstanding[] {
  const rows = db
    .prepare(
      `SELECT id, display_name AS displayName, phone, customer_type AS customerType,
              credit_limit_pesewas AS creditLimitPesewas,
              current_balance_pesewas AS cachedBalancePesewas,
              blocked
         FROM customers WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; displayName: string; phone: string; customerType: string;
                       creditLimitPesewas: number; cachedBalancePesewas: number; blocked: number }>;

  const enriched: CustomerWithOutstanding[] = rows.map((r) => {
    const trueBalance = computeTrueBalance(db, r.id);
    const open = listOpenSalesForCustomer(db, r.id, now);
    const oldest = open.length > 0 ? open[open.length - 1]?.ageDays ?? null : null;
    return {
      id: r.id,
      displayName: r.displayName,
      phone: r.phone,
      customerType: r.customerType,
      creditLimitPesewas: r.creditLimitPesewas,
      trueBalancePesewas: trueBalance,
      blocked: r.blocked === 1,
      ageOfOldestUnpaidDays: oldest,
      oldestUnpaidBucket: oldest === null ? null : bucketFor(oldest),
      needsReconcile: r.cachedBalancePesewas !== trueBalance,
    };
  });

  let filtered = enriched;
  if (!opts.includeBlocked) filtered = filtered.filter((c) => !c.blocked);
  if (!opts.includeZeroBalance) filtered = filtered.filter((c) => c.trueBalancePesewas > 0);
  if (opts.agingBucket) filtered = filtered.filter((c) => c.oldestUnpaidBucket === opts.agingBucket);

  filtered.sort((a, b) => b.trueBalancePesewas - a.trueBalancePesewas);
  if (opts.limit) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

export interface AgingSummary {
  bucket0_30: number;
  bucket31_60: number;
  bucket61_90: number;
  bucket90_plus: number;
  total: number;
  blockedCount: number;
  needsReviewCount: number;       // active customers at or over their limit
}

export function getAgingSummary(db: DB, now = new Date()): AgingSummary {
  const customers = db
    .prepare(
      `SELECT id, credit_limit_pesewas AS creditLimitPesewas, blocked
         FROM customers WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; creditLimitPesewas: number; blocked: number }>;

  const summary: AgingSummary = {
    bucket0_30: 0, bucket31_60: 0, bucket61_90: 0, bucket90_plus: 0,
    total: 0, blockedCount: 0, needsReviewCount: 0,
  };
  for (const c of customers) {
    if (c.blocked === 1) summary.blockedCount++;
    const open = listOpenSalesForCustomer(db, c.id, now);
    let custBalance = 0;
    for (const s of open) {
      summary[bucketFor(s.ageDays)] += s.outstandingPesewas;
      summary.total += s.outstandingPesewas;
      custBalance += s.outstandingPesewas;
    }
    if (c.blocked === 0 && c.creditLimitPesewas > 0 && custBalance >= c.creditLimitPesewas) {
      summary.needsReviewCount++;
    }
  }
  return summary;
}
