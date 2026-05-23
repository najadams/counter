// customerReturns.ts — Wave C.3.
//
// Customer returns: distinct from sale voids. The customer brings unsold
// stock back, we re-shelve it, and make them whole via:
//   - CASH:    we pay them out of the till; recorded as a NEGATIVE cash drop
//   - CREDIT:  reduce their outstanding sale balance(s) (FIFO) — for credit
//              customers; partial allocations OK
//   - STORE:   store credit (future). For now, treat as CREDIT — caller
//              should not pass STORE until the store-credit ledger lands.
//
// Each return line creates a positive stock_movements row tagged
// RETURN_FROM_CUSTOMER. The original sale stays intact; the return is its
// own header so reports can split "voided" vs "returned" cleanly.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { verifyPin } from './workers.js';
import { reconcileCustomerBalance } from './customerCredit.js';
import { assertNotSealed } from './periods.js';

type DB = Database;

const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

export interface ReturnLineInput {
  productId: string;
  /** Display-unit id, optional. If absent, quantity is treated as canonical. */
  unitId?: string | null;
  /** Quantity in the display unit. Must be > 0. */
  quantity: number;
  /** Per-unit refund price (matches what the customer was originally charged). */
  unitPricePesewas: number;
}

export interface RecordReturnInput {
  customerId: string;
  /** Original sale, if known. May be null for receipt-less returns. */
  originalSaleId?: string | null;
  locationId: string;
  workerId: string;
  shiftId?: string | null;
  supervisorWorkerId: string;
  supervisorPin: string;
  refundMethod: 'CASH' | 'CREDIT' | 'STORE';
  reason: string;
  notes?: string | null;
  lines: ReturnLineInput[];
  deviceId: string;
}

export interface RecordReturnResult {
  returnId: string;
  totalRefundPesewas: number;
  /** Allocations to original sale rows when refundMethod = CREDIT. */
  creditAllocations: Array<{ saleId: string; amountPesewas: number }>;
  /** When refundMethod = CASH, the negative cash-drop id we created. */
  negativeCashDropId: string | null;
}

export function recordCustomerReturn(
  db: DB,
  input: RecordReturnInput,
): RecordReturnResult {
  if (input.lines.length === 0) {
    throw new Error('recordCustomerReturn: at least one line required');
  }
  if (!input.reason || !input.reason.trim()) {
    throw new Error('recordCustomerReturn: reason required');
  }
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error('recordCustomerReturn: line quantity must be a positive integer');
    }
    if (!Number.isInteger(l.unitPricePesewas) || l.unitPricePesewas < 0) {
      throw new Error('recordCustomerReturn: unitPricePesewas must be a non-negative integer');
    }
  }
  if (input.refundMethod === 'STORE') {
    // Until the store-credit ledger lands, treat STORE as CREDIT explicitly.
    throw new Error('recordCustomerReturn: STORE refund method not yet supported; use CREDIT or CASH');
  }

  // Supervisor PIN check.
  const sup = db
    .prepare(
      `SELECT id, role, active, deleted_at, terminated_at FROM workers WHERE id = ?`,
    )
    .get(input.supervisorWorkerId) as
    | { id: string; role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!sup || sup.active !== 1 || sup.deleted_at || sup.terminated_at) {
    throw new Error('recordCustomerReturn: supervisor not found');
  }
  if (!SUPERVISOR_ROLES.has(sup.role)) {
    throw new Error(
      `recordCustomerReturn: ${sup.role} cannot approve a return; need SUPERVISOR/OWNER/FOUNDER`,
    );
  }
  const auth = verifyPin(db, input.supervisorWorkerId, input.supervisorPin, input.deviceId);
  if (!auth.ok) {
    throw new Error(
      auth.reason === 'LOCKED_OUT'
        ? `recordCustomerReturn: supervisor locked out until ${auth.lockedUntil}`
        : `recordCustomerReturn: supervisor PIN check failed (${auth.reason})`,
    );
  }

  // Customer must exist.
  const customer = db
    .prepare(`SELECT id FROM customers WHERE id = ?`)
    .get(input.customerId) as { id: string } | undefined;
  if (!customer) throw new Error(`recordCustomerReturn: customer ${input.customerId} not found`);

  // CREDIT method works for any customer: FIFO allocation against open
  // credit sales reduces their balance; any leftover stays as store credit
  // (a negative balance row), which behaves identically to recordCustomerPayment.

  // Resolve product unit conversion factors.
  const resolvedLines = input.lines.map((l) => {
    let factor = 1;
    let unitId: string | null = null;
    if (l.unitId) {
      const u = db
        .prepare(`SELECT id, conversion_factor FROM product_units WHERE id = ? AND active = 1`)
        .get(l.unitId) as { id: string; conversion_factor: number } | undefined;
      if (!u) throw new Error(`recordCustomerReturn: unit ${l.unitId} not found or inactive`);
      factor = u.conversion_factor;
      unitId = u.id;
    }
    const product = db.prepare(`SELECT id, cost_price_pesewas FROM products WHERE id = ?`)
      .get(l.productId) as { id: string; cost_price_pesewas: number } | undefined;
    if (!product) throw new Error(`recordCustomerReturn: product ${l.productId} not found`);

    const quantityCanonical = l.quantity * factor;
    const lineTotal = l.unitPricePesewas * l.quantity;
    return {
      productId: product.id,
      unitId,
      quantityDisplay: l.quantity,
      quantityCanonical,
      unitPricePesewas: l.unitPricePesewas,
      canonicalUnitCost: Math.floor(product.cost_price_pesewas / factor),
      lineTotalPesewas: lineTotal,
    };
  });

  const totalRefund = resolvedLines.reduce((s, l) => s + l.lineTotalPesewas, 0);

  // Day-lock guard: returns restock items AND reduce customer balance (or
  // emit a cash drop) — both must be locked once the day is sealed.
  const todayISO = new Date().toISOString().slice(0, 10);
  assertNotSealed(db, input.locationId, todayISO, 'recording a customer return');

  return db.transaction(() => {
    const returnId = `cr-${uuidv4()}`;
    db.prepare(
      `INSERT INTO customer_returns
         (id, customer_id, original_sale_id, location_id, worker_id, shift_id,
          supervisor_approval_id, refund_method, total_refund_pesewas, reason, notes,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      returnId, input.customerId, input.originalSaleId ?? null,
      input.locationId, input.workerId, input.shiftId ?? null,
      input.supervisorWorkerId, input.refundMethod, totalRefund,
      input.reason.trim(), input.notes ?? null,
      input.workerId, input.workerId, input.deviceId,
    );

    // Per-line: stock_movements (positive RETURN_FROM_CUSTOMER) + customer_return_lines.
    for (const l of resolvedLines) {
      const movId = `sm-${uuidv4()}`;
      // stock_movements has no customer_id column. Customer linkage lives
      // on customer_returns.customer_id, joined back through
      // customer_return_lines.stock_movement_id below.
      db.prepare(
        `INSERT INTO stock_movements
           (id, product_id, location_id, quantity, reason_code, worker_id,
            unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
            created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, 'RETURN_FROM_CUSTOMER', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        movId, l.productId, input.locationId, l.quantityCanonical,
        input.workerId, l.canonicalUnitCost,
        l.canonicalUnitCost * l.quantityCanonical,
        input.supervisorWorkerId,
        input.workerId, input.workerId, input.deviceId,
      );

      const lineId = `crl-${uuidv4()}`;
      db.prepare(
        `INSERT INTO customer_return_lines
           (id, return_id, product_id, applies_to_unit_id, quantity, unit_price_pesewas,
            line_total_pesewas, stock_movement_id, created_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lineId, returnId, l.productId, l.unitId, l.quantityDisplay,
        l.unitPricePesewas, l.lineTotalPesewas, movId,
        input.workerId, input.deviceId,
      );
    }

    // Refund accounting.
    let creditAllocations: Array<{ saleId: string; amountPesewas: number }> = [];
    let negativeCashDropId: string | null = null;

    if (input.refundMethod === 'CREDIT') {
      // FIFO allocate against the customer's open credit sales: oldest first,
      // up to totalRefund. Any leftover stays as customer credit (negative
      // balance) — reconcileCustomerBalance below recomputes the cache.
      // Outstanding = sum of CREDIT tenders − allocations already applied.
      // For pure-CREDIT sales this equals s.total_pesewas; for split-tender
      // sales the cash/MoMo portions are NOT owed (they were paid up
      // front), so we mustn't allocate refund credit against them.
      const open = db.prepare(
        `SELECT s.id,
                COALESCE((SELECT SUM(amount_pesewas)
                            FROM sale_payments
                            WHERE sale_id = s.id AND payment_method = 'CREDIT'), 0)
                - COALESCE((SELECT SUM(amount_pesewas)
                              FROM customer_payment_allocations
                             WHERE sale_id = s.id), 0)
                AS outstanding
           FROM sales s
          WHERE s.customer_id = ? AND s.is_credit = 1 AND s.voided = 0
          ORDER BY s.created_at ASC`,
      ).all(input.customerId) as Array<{ id: string; outstanding: number }>;

      let remaining = totalRefund;
      for (const s of open) {
        if (remaining <= 0) break;
        const out = s.outstanding;
        if (out <= 0) continue;
        const apply = Math.min(out, remaining);
        // Record as a synthetic payment + allocation so the existing
        // open-sales/aging math just works.
        const paymentId = `cp-${uuidv4()}`;
        db.prepare(
          `INSERT INTO customer_payments
             (id, customer_id, amount_pesewas, payment_method, payment_reference,
              received_at, received_by, shift_id, notes,
              created_by, updated_by, device_id)
           VALUES (?, ?, ?, 'RETURN_CREDIT', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   ?, ?, ?, ?, ?, ?)`,
        ).run(
          paymentId, input.customerId, apply, returnId,
          input.workerId, input.shiftId ?? null,
          `Customer return credit: ${input.reason.trim()}`,
          input.workerId, input.workerId, input.deviceId,
        );
        db.prepare(
          `INSERT INTO customer_payment_allocations
             (id, customer_payment_id, sale_id, amount_pesewas,
              created_by, updated_by, device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `cpa-${uuidv4()}`, paymentId, s.id, apply,
          input.workerId, input.workerId, input.deviceId,
        );
        creditAllocations.push({ saleId: s.id, amountPesewas: apply });
        remaining -= apply;
      }
      // If remaining > 0, the customer has store credit. Record an
      // unallocated "payment" so the aging math reflects the credit.
      if (remaining > 0) {
        const paymentId = `cp-${uuidv4()}`;
        db.prepare(
          `INSERT INTO customer_payments
             (id, customer_id, amount_pesewas, payment_method, payment_reference,
              received_at, received_by, shift_id, notes,
              created_by, updated_by, device_id)
           VALUES (?, ?, ?, 'RETURN_CREDIT', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   ?, ?, ?, ?, ?, ?)`,
        ).run(
          paymentId, input.customerId, remaining, returnId,
          input.workerId, input.shiftId ?? null,
          `Customer return overage (store credit): ${input.reason.trim()}`,
          input.workerId, input.workerId, input.deviceId,
        );
      }
      reconcileCustomerBalance(db, input.customerId);
    } else if (input.refundMethod === 'CASH') {
      // Cash refund -> till loses cash. Recorded as a CASH_DROP-typed
      // cash_counts row to mirror cashDrops.recordCashDrop, so the daily
      // summary & shift expected-cash math just work. The notes column
      // tags it as a customer refund so reports can split.
      if (!input.shiftId) {
        throw new Error('recordCustomerReturn: CASH refund requires an open shiftId');
      }
      const dropId = `cc-${uuidv4()}`;
      db.prepare(
        `INSERT INTO cash_counts
           (id, shift_id, location_id, worker_id, count_type, counted_pesewas,
            notes, supervisor_id, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, 'CASH_DROP', ?, ?, ?, ?, ?, ?)`,
      ).run(
        dropId, input.shiftId, input.locationId, input.workerId, totalRefund,
        `customer-refund:${input.customerId} — ${input.reason.trim()}`,
        input.supervisorWorkerId,
        input.workerId, input.workerId, input.deviceId,
      );
      negativeCashDropId = dropId;
    }

    return {
      returnId,
      totalRefundPesewas: totalRefund,
      creditAllocations,
      negativeCashDropId,
    };
  })();
}

export interface CustomerReturnRow {
  id: string;
  customerId: string;
  customerName: string;
  originalSaleId: string | null;
  refundMethod: 'CASH' | 'CREDIT' | 'STORE';
  totalRefundPesewas: number;
  reason: string;
  createdAt: string;
  workerName: string;
  supervisorName: string;
}

export function listReturnsForCustomer(
  db: DB, customerId: string, limit = 50,
): CustomerReturnRow[] {
  return db
    .prepare(
      `SELECT cr.id, cr.customer_id AS customerId, c.display_name AS customerName,
              cr.original_sale_id AS originalSaleId, cr.refund_method AS refundMethod,
              cr.total_refund_pesewas AS totalRefundPesewas,
              cr.reason, cr.created_at AS createdAt,
              w.full_name AS workerName, s.full_name AS supervisorName
         FROM customer_returns cr
         JOIN customers c ON c.id = cr.customer_id
         JOIN workers w ON w.id = cr.worker_id
         JOIN workers s ON s.id = cr.supervisor_approval_id
        WHERE cr.customer_id = ?
        ORDER BY cr.created_at DESC
        LIMIT ?`,
    )
    .all(customerId, limit) as CustomerReturnRow[];
}
