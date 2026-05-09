// Petty cash expenses paid out of the till.
//
// Records cash going OUT to a third party (utility company, supplier, runner)
// for a non-stock purpose. Categorized so dad can see what's eating the
// margin.
//
// Service-level invariants:
//   - amount > 0 (also a DB CHECK)
//   - category from the closed enum (DB CHECK)
//   - photo_url required for amounts >= ₵50 (5000 pesewas)
//   - supervisor_approval_id required for amounts >= ₵100 (10000 pesewas);
//     supervisor PIN is verified upstream by the IPC layer and the
//     approval_id is the supervisor's worker_id.
//   - Day-lock guard via assertNotSealed.
//
// Expenses do NOT use insertStockMovement — there's no inventory effect.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { assertNotSealed } from './periods.js';

export const EXPENSE_CATEGORIES = [
  'RENT', 'UTILITIES', 'TRANSPORT', 'SUPPLIES', 'COMMS',
  'REPAIRS', 'BANK_FEES', 'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_PHOTO_THRESHOLD_PESEWAS = 5000;        // ₵50
export const EXPENSE_SUPERVISOR_THRESHOLD_PESEWAS = 10000;  // ₵100

export interface RecordExpenseInput {
  shiftId: string;
  locationId: string;
  workerId: string;
  amountPesewas: number;
  category: ExpenseCategory;
  payee?: string | null;
  photoUrl?: string | null;
  notes?: string | null;
  supervisorApprovalId?: string | null;
  deviceId: string;
}

export interface RecordExpenseResult {
  expenseId: string;
}

export function recordExpense(db: DB, input: RecordExpenseInput): RecordExpenseResult {
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('recordExpense: amountPesewas must be a positive integer');
  }
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new Error(`recordExpense: invalid category '${input.category}'`);
  }
  if (input.amountPesewas >= EXPENSE_PHOTO_THRESHOLD_PESEWAS && !input.photoUrl) {
    throw new Error(
      `recordExpense: receipt photo required for expenses ≥ ₵50.`,
    );
  }
  if (input.amountPesewas >= EXPENSE_SUPERVISOR_THRESHOLD_PESEWAS && !input.supervisorApprovalId) {
    throw new Error(
      `recordExpense: supervisor approval required for expenses ≥ ₵100.`,
    );
  }

  // Day-lock guard.
  const todayISO = new Date().toISOString().slice(0, 10);
  assertNotSealed(db, input.locationId, todayISO, 'recording an expense');

  // Verify shift is open at this location and belongs to this worker (or
  // the worker is staffed at this location). Refuse if shift is closed.
  const shift = db.prepare(
    `SELECT id, location_id, closed_at FROM shifts WHERE id = ?`,
  ).get(input.shiftId) as { id: string; location_id: string; closed_at: string | null } | undefined;
  if (!shift) throw new Error(`recordExpense: shift ${input.shiftId} not found`);
  if (shift.closed_at) throw new Error('recordExpense: shift already closed; expense must land in an open shift');
  if (shift.location_id !== input.locationId) {
    throw new Error(`recordExpense: shift location ${shift.location_id} ≠ input.locationId ${input.locationId}`);
  }

  const expenseId = `exp-${uuidv4()}`;
  db.prepare(
    `INSERT INTO petty_cash_expenses (
      id, shift_id, location_id, worker_id, amount_pesewas, category,
      payee, photo_url, notes, supervisor_approval_id,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    expenseId,
    input.shiftId, input.locationId, input.workerId, input.amountPesewas, input.category,
    input.payee?.trim() || null, input.photoUrl ?? null,
    input.notes?.trim() || null,
    input.supervisorApprovalId ?? null,
    input.workerId, input.workerId, input.deviceId,
  );

  logAudit(db, {
    workerId: input.workerId,
    action: 'EXPENSE_RECORDED',
    entityType: 'petty_cash_expenses',
    entityId: expenseId,
    afterValue: {
      amountPesewas: input.amountPesewas,
      category: input.category,
      payee: input.payee?.trim() || null,
      shiftId: input.shiftId,
      supervisorApprovalId: input.supervisorApprovalId ?? null,
    },
    deviceId: input.deviceId,
  });

  return { expenseId };
}

export interface ExpenseRow {
  id: string;
  amountPesewas: number;
  category: ExpenseCategory;
  payee: string | null;
  photoUrl: string | null;
  notes: string | null;
  workerId: string;
  workerName: string;
  supervisorApprovalId: string | null;
  supervisorName: string | null;
  createdAt: string;
}

export function listExpensesForShift(db: DB, shiftId: string): ExpenseRow[] {
  return db.prepare(
    `SELECT e.id, e.amount_pesewas AS amountPesewas, e.category,
            e.payee, e.photo_url AS photoUrl, e.notes,
            e.worker_id AS workerId, w.full_name AS workerName,
            e.supervisor_approval_id AS supervisorApprovalId,
            sw.full_name AS supervisorName,
            e.created_at AS createdAt
       FROM petty_cash_expenses e
       JOIN workers w ON w.id = e.worker_id
       LEFT JOIN workers sw ON sw.id = e.supervisor_approval_id
      WHERE e.shift_id = ?
      ORDER BY e.created_at ASC`,
  ).all(shiftId) as ExpenseRow[];
}

export interface ExpenseTotalsForShift {
  totalPesewas: number;
  byCategory: Array<{ category: ExpenseCategory; totalPesewas: number; count: number }>;
}

export function expenseTotalsForShift(db: DB, shiftId: string): ExpenseTotalsForShift {
  const total = db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS t FROM petty_cash_expenses WHERE shift_id = ?`,
  ).get(shiftId) as { t: number };
  const byCat = db.prepare(
    `SELECT category, COALESCE(SUM(amount_pesewas), 0) AS totalPesewas, COUNT(*) AS count
       FROM petty_cash_expenses WHERE shift_id = ?
       GROUP BY category ORDER BY totalPesewas DESC`,
  ).all(shiftId) as Array<{ category: ExpenseCategory; totalPesewas: number; count: number }>;
  return { totalPesewas: total.t, byCategory: byCat };
}

export function expensesByCategoryForRange(
  db: DB, locationId: string, fromDate: string, toDate: string,
): Array<{ category: ExpenseCategory; totalPesewas: number; count: number }> {
  const from = `${fromDate}T00:00:00.000Z`;
  const to = `${toDate}T23:59:59.999Z`;
  return db.prepare(
    `SELECT category, COALESCE(SUM(amount_pesewas), 0) AS totalPesewas, COUNT(*) AS count
       FROM petty_cash_expenses
      WHERE location_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY category ORDER BY totalPesewas DESC`,
  ).all(locationId, from, to) as Array<{ category: ExpenseCategory; totalPesewas: number; count: number }>;
}
