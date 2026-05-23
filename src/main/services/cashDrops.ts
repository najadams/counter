// Cash drops mid-shift: worker hands cash to the owner / takes it to the
// safe / pays a supplier. Recorded as a CASH_DROP cash_count row so
// computeAndCloseShift subtracts it from expected cash automatically.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { verifyPin } from './workers.js';

const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

export interface RecordCashDropInput {
  shiftId: string;
  workerId: string;
  amountPesewas: number;
  recipient: string;
  notes?: string | null;
  supervisorWorkerId: string;
  supervisorPin: string;
  deviceId: string;
}

export interface RecordCashDropResult {
  cashCountId: string;
  expectedCashAfterDropPesewas: number;
}

/**
 * Record a cash drop. Verifies supervisor PIN. Refuses if the amount
 * exceeds the current expected cash in the till (you can't drop more than
 * you should have).
 */
export function recordCashDrop(
  db: DB,
  input: RecordCashDropInput,
): RecordCashDropResult {
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('recordCashDrop: amountPesewas must be a positive integer');
  }
  if (!input.recipient.trim()) {
    throw new Error('recordCashDrop: recipient is required');
  }

  // Supervisor check
  const sup = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(input.supervisorWorkerId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!sup || sup.active !== 1 || sup.deleted_at || sup.terminated_at) {
    throw new Error('recordCashDrop: supervisor not found');
  }
  if (!SUPERVISOR_ROLES.has(sup.role)) {
    throw new Error(`recordCashDrop: ${sup.role} cannot approve a cash drop`);
  }
  const auth = verifyPin(db, input.supervisorWorkerId, input.supervisorPin, input.deviceId);
  if (!auth.ok) {
    throw new Error(
      auth.reason === 'LOCKED_OUT'
        ? `recordCashDrop: supervisor locked out until ${auth.lockedUntil}`
        : `recordCashDrop: supervisor PIN check failed (${auth.reason})`,
    );
  }

  const shift = db
    .prepare(
      `SELECT id, location_id, opening_cash_pesewas, closed_at FROM shifts WHERE id = ?`,
    )
    .get(input.shiftId) as
    | { id: string; location_id: string; opening_cash_pesewas: number; closed_at: string | null }
    | undefined;
  if (!shift) throw new Error(`recordCashDrop: shift ${input.shiftId} not found`);
  if (shift.closed_at) throw new Error(`recordCashDrop: shift already closed`);

  // Compute current expected cash:
  //  opening + cash sales + debt payments in cash - drops - expenses
  const cashSales = (db
    .prepare(
      `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.shift_id = ? AND sp.payment_method = 'CASH' AND s.voided = 0`,
    )
    .get(input.shiftId) as { total: number }).total;
  const debtPaymentsCash = (db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM customer_payments
         WHERE shift_id = ? AND payment_method = 'CASH'`,
    )
    .get(input.shiftId) as { total: number }).total;
  const priorDrops = (db
    .prepare(
      `SELECT COALESCE(SUM(counted_pesewas), 0) AS total FROM cash_counts
         WHERE shift_id = ? AND count_type = 'CASH_DROP'`,
    )
    .get(input.shiftId) as { total: number }).total;

  const expensesPriorRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM petty_cash_expenses
         WHERE shift_id = ?`,
    )
    .get(input.shiftId) as { total: number };
  const expensesPrior = expensesPriorRow.total;

  const currentExpected =
    shift.opening_cash_pesewas + cashSales + debtPaymentsCash - priorDrops - expensesPrior;
  if (input.amountPesewas > currentExpected) {
    throw new Error(
      `recordCashDrop: drop amount (${input.amountPesewas}) exceeds current expected cash (${currentExpected})`,
    );
  }

  const cashCountId = `cc-${uuidv4()}`;
  const recipientNote =
    `to: ${input.recipient.trim()}` +
    (input.notes && input.notes.trim() ? ` — ${input.notes.trim()}` : '');

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO cash_counts (
         id, shift_id, location_id, worker_id, count_type, counted_pesewas,
         notes, supervisor_id,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, 'CASH_DROP', ?, ?, ?, ?, ?, ?)`,
    ).run(
      cashCountId,
      input.shiftId,
      shift.location_id,
      input.workerId,
      input.amountPesewas,
      recipientNote,
      input.supervisorWorkerId,
      input.workerId,
      input.workerId,
      input.deviceId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'CASH_DROP_RECORDED',
      entityType: 'cash_counts',
      entityId: cashCountId,
      afterValue: {
        shiftId: input.shiftId,
        amountPesewas: input.amountPesewas,
        recipient: input.recipient.trim(),
        supervisorApprovalId: input.supervisorWorkerId,
        expectedCashAfterDropPesewas: currentExpected - input.amountPesewas,
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  return {
    cashCountId,
    expectedCashAfterDropPesewas: currentExpected - input.amountPesewas,
  };
}

export interface CashDropRow {
  id: string;
  amountPesewas: number;
  notes: string | null;
  supervisorId: string | null;
  createdAt: string;
  workerName: string;
  supervisorName: string | null;
}

export function listCashDropsForShift(db: DB, shiftId: string): CashDropRow[] {
  return db
    .prepare(
      `SELECT cc.id, cc.counted_pesewas AS amountPesewas, cc.notes,
              cc.supervisor_id AS supervisorId, cc.created_at AS createdAt,
              w.full_name AS workerName,
              s.full_name AS supervisorName
         FROM cash_counts cc
         JOIN workers w ON w.id = cc.worker_id
         LEFT JOIN workers s ON s.id = cc.supervisor_id
         WHERE cc.shift_id = ? AND cc.count_type = 'CASH_DROP'
         ORDER BY cc.created_at DESC`,
    )
    .all(shiftId) as CashDropRow[];
}

/** Compute the current expected cash (opening + cash sales - drops). Useful
 *  for a "current till expected" display in the cash drop modal. */
export function getCurrentExpectedCash(db: DB, shiftId: string): number {
  const shift = db
    .prepare('SELECT opening_cash_pesewas FROM shifts WHERE id = ?')
    .get(shiftId) as { opening_cash_pesewas: number } | undefined;
  if (!shift) return 0;
  const cashSales = (db
    .prepare(
      `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.shift_id = ? AND sp.payment_method = 'CASH' AND s.voided = 0`,
    )
    .get(shiftId) as { total: number }).total;
  // Cash brought into the till by customers paying down credit balances.
  // Must match the inclusion in recordCashDrop and computeAndCloseShift —
  // otherwise the three views of "expected cash" disagree.
  const debtPaymentsCash = (db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM customer_payments
         WHERE shift_id = ? AND payment_method = 'CASH'`,
    )
    .get(shiftId) as { total: number }).total;
  const drops = (db
    .prepare(
      `SELECT COALESCE(SUM(counted_pesewas), 0) AS total FROM cash_counts
         WHERE shift_id = ? AND count_type = 'CASH_DROP'`,
    )
    .get(shiftId) as { total: number }).total;
  return shift.opening_cash_pesewas + cashSales + debtPaymentsCash - drops;
}
