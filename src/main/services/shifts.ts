// shift service: open, close (blind two-step), and query.
//
// Invariant 9 (blind cash count) is enforced as a two-step close:
//   1. submitClosingCount(shiftId, countedPesewas) — writes counted only.
//   2. computeAndCloseShift(shiftId) — computes expected, fills variance,
//      finalises the shift row.
// computeAndCloseShift will refuse to run unless step 1 happened first.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';

export interface OpenShiftInput {
  workerId: string;
  locationId: string;
  shiftType: 'COUNTER' | 'ROUTE';
  openingCashPesewas: number;
  deviceId: string;
}

export interface OpenShiftResult {
  shiftId: string;
  cashCountId: string;
}

export interface ShiftSummary {
  id: string;
  workerId: string;
  locationId: string;
  openedAt: string;
  closedAt: string | null;
  shiftType: string;
  openingCashPesewas: number;
  totalSalesPesewas: number;
}

/**
 * Open a shift. Inserts:
 *   - shifts row (closed_at = NULL)
 *   - cash_counts row with count_type = SHIFT_OPEN, counted = opening cash
 * In one transaction. Audits SHIFT_OPENED.
 *
 * Rejects if the worker already has an open shift (DB-level unique partial
 * index also enforces this as a safety net).
 */
export function openShift(db: DB, input: OpenShiftInput): OpenShiftResult {
  if (!Number.isInteger(input.openingCashPesewas) || input.openingCashPesewas < 0) {
    throw new Error(
      `openShift: openingCashPesewas must be a non-negative integer, got ${input.openingCashPesewas}`,
    );
  }

  const existingOpen = db
    .prepare(
      `SELECT id FROM shifts
         WHERE worker_id = ? AND closed_at IS NULL
         LIMIT 1`,
    )
    .get(input.workerId) as { id: string } | undefined;
  if (existingOpen) {
    throw new Error(
      `openShift: worker already has an open shift (${existingOpen.id})`,
    );
  }

  const shiftId = `sh-${uuidv4()}`;
  const cashCountId = `cc-${uuidv4()}`;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO shifts (
         id, worker_id, location_id, opened_at, shift_type,
         opening_cash_pesewas,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      shiftId,
      input.workerId,
      input.locationId,
      now,
      input.shiftType,
      input.openingCashPesewas,
      input.workerId,
      input.workerId,
      input.deviceId,
    );

    db.prepare(
      `INSERT INTO cash_counts (
         id, shift_id, location_id, worker_id, count_type, counted_pesewas,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cashCountId,
      shiftId,
      input.locationId,
      input.workerId,
      'SHIFT_OPEN',
      input.openingCashPesewas,
      input.workerId,
      input.workerId,
      input.deviceId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'SHIFT_OPENED',
      entityType: 'shifts',
      entityId: shiftId,
      afterValue: {
        workerId: input.workerId,
        locationId: input.locationId,
        openingCashPesewas: input.openingCashPesewas,
        shiftType: input.shiftType,
      },
      deviceId: input.deviceId,
    });
  });

  tx();
  return { shiftId, cashCountId };
}

/** Get the open shift for a worker, or null. */
export function getOpenShift(db: DB, workerId: string): ShiftSummary | null {
  const row = db
    .prepare(
      `SELECT id, worker_id AS workerId, location_id AS locationId,
              opened_at AS openedAt, closed_at AS closedAt,
              shift_type AS shiftType,
              opening_cash_pesewas AS openingCashPesewas,
              total_sales_pesewas AS totalSalesPesewas
         FROM shifts
         WHERE worker_id = ? AND closed_at IS NULL
         LIMIT 1`,
    )
    .get(workerId) as ShiftSummary | undefined;
  return row ?? null;
}

/**
 * Step 1 of close: worker enters their counted amount. Saved to a
 * cash_counts row with count_type = SHIFT_CLOSE, expected/variance NULL.
 * The follow-up computeAndCloseShift() reads this row, computes expected,
 * and updates it.
 *
 * Rejects if a SHIFT_CLOSE count already exists for this shift.
 */
export function submitClosingCount(
  db: DB,
  shiftId: string,
  countedPesewas: number,
  workerId: string,
  deviceId: string,
): { cashCountId: string } {
  if (!Number.isInteger(countedPesewas) || countedPesewas < 0) {
    throw new Error(
      `submitClosingCount: countedPesewas must be a non-negative integer, got ${countedPesewas}`,
    );
  }

  const shift = db
    .prepare(
      `SELECT id, location_id, closed_at FROM shifts WHERE id = ?`,
    )
    .get(shiftId) as
    | { id: string; location_id: string; closed_at: string | null }
    | undefined;
  if (!shift) throw new Error(`submitClosingCount: shift ${shiftId} not found`);
  if (shift.closed_at) throw new Error(`submitClosingCount: shift already closed`);

  const existing = db
    .prepare(
      `SELECT id FROM cash_counts
         WHERE shift_id = ? AND count_type = 'SHIFT_CLOSE' LIMIT 1`,
    )
    .get(shiftId) as { id: string } | undefined;
  if (existing) {
    throw new Error(
      `submitClosingCount: closing count already submitted for this shift`,
    );
  }

  const cashCountId = `cc-${uuidv4()}`;
  db.prepare(
    `INSERT INTO cash_counts (
       id, shift_id, location_id, worker_id, count_type, counted_pesewas,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, 'SHIFT_CLOSE', ?, ?, ?, ?)`,
  ).run(cashCountId, shiftId, shift.location_id, workerId, countedPesewas, workerId, workerId, deviceId);

  return { cashCountId };
}

export interface CloseShiftResult {
  shiftId: string;
  countedPesewas: number;
  expectedPesewas: number;
  variancePesewas: number;
  totalSalesPesewas: number;
  totalBreakageValuePesewas: number;
}

/**
 * Step 2 of close: compute expected cash, write variance, finalize the shift.
 * Expected = opening_cash + cash sales - cash drops.
 *   - cash sales = SUM(sales.total_pesewas) WHERE shift_id AND payment_method = 'CASH' AND voided = 0
 *   - cash drops = SUM(cash_counts.counted_pesewas) WHERE shift_id AND count_type = 'CASH_DROP'
 * (CASH_DROP isn't used yet — Week 2 — but the formula is ready.)
 *
 * Audits SHIFT_CLOSED with full reconciliation snapshot.
 */
export function computeAndCloseShift(
  db: DB,
  shiftId: string,
  workerId: string,
  deviceId: string,
): CloseShiftResult {
  const shift = db
    .prepare(
      `SELECT id, opening_cash_pesewas, closed_at FROM shifts WHERE id = ?`,
    )
    .get(shiftId) as
    | { id: string; opening_cash_pesewas: number; closed_at: string | null }
    | undefined;
  if (!shift) throw new Error(`computeAndCloseShift: shift ${shiftId} not found`);
  if (shift.closed_at) throw new Error(`computeAndCloseShift: shift already closed`);

  const closeCount = db
    .prepare(
      `SELECT id, counted_pesewas, expected_pesewas
         FROM cash_counts
         WHERE shift_id = ? AND count_type = 'SHIFT_CLOSE'
         LIMIT 1`,
    )
    .get(shiftId) as
    | { id: string; counted_pesewas: number; expected_pesewas: number | null }
    | undefined;
  if (!closeCount) {
    throw new Error(
      `computeAndCloseShift: closing count not yet submitted (call submitClosingCount first)`,
    );
  }
  if (closeCount.expected_pesewas !== null) {
    throw new Error(
      `computeAndCloseShift: shift already reconciled — cannot recompute`,
    );
  }

  // Sum CASH tenders across all sales in this shift. Split-tender sales
  // contribute only their CASH portion, not the full sale total. Voided
  // sales contribute nothing.
  const cashSalesRow = db
    .prepare(
      `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.shift_id = ? AND sp.payment_method = 'CASH' AND s.voided = 0`,
    )
    .get(shiftId) as { total: number };

  const cashDropsRow = db
    .prepare(
      `SELECT COALESCE(SUM(counted_pesewas), 0) AS total
         FROM cash_counts
         WHERE shift_id = ? AND count_type = 'CASH_DROP'`,
    )
    .get(shiftId) as { total: number };

  // Petty cash expenses paid out of the till during this shift.
  const expensesRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM petty_cash_expenses
         WHERE shift_id = ?`,
    )
    .get(shiftId) as { total: number };

  // Cash brought into the till by customers paying down credit during the
  // shift. customer_payments.payment_method = 'CASH' is real cash received;
  // RETURN_CREDIT (synthetic, from customerReturns) and MOMO_*/BANK_TRANSFER
  // don't touch the till and are filtered out.
  const debtPaymentsCashRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM customer_payments
         WHERE shift_id = ? AND payment_method = 'CASH'`,
    )
    .get(shiftId) as { total: number };

  const expected =
    shift.opening_cash_pesewas
    + cashSalesRow.total
    + debtPaymentsCashRow.total
    - cashDropsRow.total
    - expensesRow.total;
  const variance = closeCount.counted_pesewas - expected;

  // Total breakage value during this shift (negative pesewas in stock_movements).
  const breakageRow = db
    .prepare(
      `SELECT COALESCE(SUM(-total_value_pesewas), 0) AS total
         FROM stock_movements
         WHERE shift_id = ? AND reason_code = 'BREAKAGE'`,
    )
    .get(shiftId) as { total: number };

  // Total sales (all payment methods) during this shift.
  const allSalesRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_pesewas), 0) AS total
         FROM sales WHERE shift_id = ? AND voided = 0`,
    )
    .get(shiftId) as { total: number };

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Update the cash_counts row with expected + variance.
    db.prepare(
      `UPDATE cash_counts
          SET expected_pesewas = ?, variance_pesewas = ?, updated_at = ?
          WHERE id = ?`,
    ).run(expected, variance, now, closeCount.id);

    // Finalize the shift row.
    db.prepare(
      `UPDATE shifts
          SET closed_at = ?,
              closing_cash_counted_pesewas = ?,
              closing_cash_expected_pesewas = ?,
              cash_variance_pesewas = ?,
              total_sales_pesewas = ?,
              total_breakage_value_pesewas = ?,
              updated_at = ?,
              updated_by = ?
          WHERE id = ?`,
    ).run(
      now,
      closeCount.counted_pesewas,
      expected,
      variance,
      allSalesRow.total,
      breakageRow.total,
      now,
      workerId,
      shiftId,
    );

    logAudit(db, {
      workerId,
      action: 'SHIFT_CLOSED',
      entityType: 'shifts',
      entityId: shiftId,
      afterValue: {
        countedPesewas: closeCount.counted_pesewas,
        expectedPesewas: expected,
        variancePesewas: variance,
        totalSalesPesewas: allSalesRow.total,
        totalBreakageValuePesewas: breakageRow.total,
      },
      deviceId,
    });
  });

  tx();

  return {
    shiftId,
    countedPesewas: closeCount.counted_pesewas,
    expectedPesewas: expected,
    variancePesewas: variance,
    totalSalesPesewas: allSalesRow.total,
    totalBreakageValuePesewas: breakageRow.total,
  };
}
