// Cash drops mid-shift: worker hands cash to the owner / takes it to the
// safe / pays a supplier. Recorded as a CASH_DROP cash_count row so
// computeAndCloseShift subtracts it from expected cash automatically.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { verifyPin } from './workers.js';

const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);
const DRAWING_CATEGORIES = new Set(['OWNER_DRAWING', 'FAMILY_SUPPORT', 'OWNER_SALARY', 'OTHER_DRAWING']);

export type CashDropCategory =
  | 'GENERIC_DROP' | 'OWNER_DRAWING' | 'FAMILY_SUPPORT' | 'OWNER_SALARY' | 'OTHER_DRAWING';
export type DrawingCategory = Exclude<CashDropCategory, 'GENERIC_DROP'>;
export type DrawingCadence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'AD_HOC';

export interface RecordCashDropInput {
  shiftId: string;
  workerId: string;
  amountPesewas: number;
  recipient: string;
  category?: CashDropCategory;
  drawingPolicyId?: string | null;
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
  const taxPaymentsCash = (db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM tax_payments
        WHERE shift_id = ? AND payment_method = 'CASH'`,
    )
    .get(input.shiftId) as { total: number }).total;

  const currentExpected =
    shift.opening_cash_pesewas + cashSales + debtPaymentsCash - priorDrops - expensesPrior - taxPaymentsCash;
  if (input.amountPesewas > currentExpected) {
    throw new Error(
      `recordCashDrop: drop amount (${input.amountPesewas}) exceeds current expected cash (${currentExpected})`,
    );
  }

  const cashCountId = `cc-${uuidv4()}`;
  const category = input.category ?? 'GENERIC_DROP';
  if (category !== 'GENERIC_DROP' && !isDrawingCategory(category)) {
    throw new Error(`recordCashDrop: invalid category '${category}'`);
  }
  const recipientNote =
    `to: ${input.recipient.trim()}` +
    (input.notes && input.notes.trim() ? ` — ${input.notes.trim()}` : '');
  let drawingPolicy: DrawingPolicyRow | null = null;
  let drawingPeriodKey: string | null = null;

  if (isDrawingCategory(category) && input.drawingPolicyId) {
    const row = db.prepare(
      `SELECT id, category, beneficiary_name AS beneficiaryName, cadence,
              limit_pesewas AS limitPesewas, active, notes
         FROM drawing_policies
        WHERE id = ? AND deleted_at IS NULL`,
    ).get(input.drawingPolicyId) as
      | (Omit<DrawingPolicyRow, 'active'> & { active: number })
      | undefined;
    if (!row || row.active !== 1) {
      throw new Error(`recordCashDrop: drawing policy ${input.drawingPolicyId} not found or inactive`);
    }
    if (row.category !== category) {
      throw new Error(`recordCashDrop: drawing policy category ${row.category} does not match ${category}`);
    }
    drawingPolicy = { ...row, active: true };
    drawingPeriodKey = policyPeriodKey(drawingPolicy.cadence, new Date());
    if (drawingPeriodKey) {
      const used = (db.prepare(
        `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
           FROM owner_drawings
          WHERE policy_id = ? AND policy_period_key = ?`,
      ).get(drawingPolicy.id, drawingPeriodKey) as { total: number }).total;
      if (used + input.amountPesewas > drawingPolicy.limitPesewas) {
        throw new Error(
          `recordCashDrop: drawing policy limit exceeded ` +
          `(${used + input.amountPesewas} > ${drawingPolicy.limitPesewas} pesewas)`,
        );
      }
    }
  }

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

    if (isDrawingCategory(category)) {
      db.prepare(
        `INSERT INTO owner_drawings (
           id, cash_count_id, shift_id, location_id, category, beneficiary_name,
           amount_pesewas, policy_id, policy_period_key, notes,
           approved_by, worker_id, created_by, updated_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `draw-${uuidv4()}`,
        cashCountId,
        input.shiftId,
        shift.location_id,
        category,
        input.recipient.trim(),
        input.amountPesewas,
        drawingPolicy?.id ?? null,
        drawingPeriodKey,
        input.notes?.trim() || null,
        input.supervisorWorkerId,
        input.workerId,
        input.workerId,
        input.workerId,
        input.deviceId,
      );
    }

    logAudit(db, {
      workerId: input.workerId,
      action: isDrawingCategory(category) ? 'OWNER_DRAWING_RECORDED' : 'CASH_DROP_RECORDED',
      entityType: 'cash_counts',
      entityId: cashCountId,
      afterValue: {
        shiftId: input.shiftId,
        amountPesewas: input.amountPesewas,
        recipient: input.recipient.trim(),
        category,
        drawingPolicyId: drawingPolicy?.id ?? null,
        drawingPeriodKey,
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
  category: CashDropCategory;
  beneficiaryName: string | null;
  notes: string | null;
  supervisorId: string | null;
  createdAt: string;
  workerName: string;
  supervisorName: string | null;
}

export interface DrawingPolicyRow {
  id: string;
  category: DrawingCategory;
  beneficiaryName: string;
  cadence: DrawingCadence;
  limitPesewas: number;
  active: boolean;
  notes: string | null;
}

export interface DrawingReportRow {
  periodKey: string;
  category: DrawingCategory;
  beneficiaryName: string;
  totalPesewas: number;
  count: number;
}

function isDrawingCategory(category: string): category is DrawingCategory {
  return DRAWING_CATEGORIES.has(category);
}

function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function policyPeriodKey(cadence: DrawingCadence, at: Date): string | null {
  if (cadence === 'AD_HOC') return null;
  const day = at.toISOString().slice(0, 10);
  if (cadence === 'DAILY') return day;
  if (cadence === 'WEEKLY') return weekKey(at);
  return day.slice(0, 7);
}

export function listCashDropsForShift(db: DB, shiftId: string): CashDropRow[] {
  return db
    .prepare(
      `SELECT cc.id, cc.counted_pesewas AS amountPesewas, cc.notes,
              COALESCE(od.category, 'GENERIC_DROP') AS category,
              od.beneficiary_name AS beneficiaryName,
              cc.supervisor_id AS supervisorId, cc.created_at AS createdAt,
              w.full_name AS workerName,
              s.full_name AS supervisorName
         FROM cash_counts cc
         JOIN workers w ON w.id = cc.worker_id
         LEFT JOIN workers s ON s.id = cc.supervisor_id
         LEFT JOIN owner_drawings od ON od.cash_count_id = cc.id
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
  const expenses = (db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM petty_cash_expenses
        WHERE shift_id = ?`,
    )
    .get(shiftId) as { total: number }).total;
  const taxPaymentsCash = (db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM tax_payments
        WHERE shift_id = ? AND payment_method = 'CASH'`,
    )
    .get(shiftId) as { total: number }).total;
  return shift.opening_cash_pesewas + cashSales + debtPaymentsCash - drops - expenses - taxPaymentsCash;
}

export function listDrawingPolicies(db: DB): DrawingPolicyRow[] {
  const rows = db.prepare(
    `SELECT id, category, beneficiary_name AS beneficiaryName, cadence,
            limit_pesewas AS limitPesewas, active, notes
       FROM drawing_policies
      WHERE deleted_at IS NULL
      ORDER BY active DESC, category ASC, beneficiary_name ASC`,
  ).all() as Array<Omit<DrawingPolicyRow, 'active'> & { active: number }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}

export function upsertDrawingPolicy(
  db: DB,
  input: {
    id?: string | null;
    category: DrawingCategory;
    beneficiaryName: string;
    cadence: DrawingCadence;
    limitPesewas: number;
    active?: boolean;
    notes?: string | null;
    workerId: string;
    deviceId: string;
  },
): { policyId: string } {
  if (!isDrawingCategory(input.category)) throw new Error(`invalid drawing category '${input.category}'`);
  if (!input.beneficiaryName.trim()) throw new Error('beneficiaryName required');
  if (!Number.isInteger(input.limitPesewas) || input.limitPesewas < 0) {
    throw new Error('limitPesewas must be a non-negative integer');
  }
  const now = new Date().toISOString();
  if (input.id) {
    const exists = db.prepare('SELECT id FROM drawing_policies WHERE id = ? AND deleted_at IS NULL').get(input.id);
    if (!exists) throw new Error(`drawing policy ${input.id} not found`);
    db.prepare(
      `UPDATE drawing_policies
          SET category = ?, beneficiary_name = ?, cadence = ?, limit_pesewas = ?,
              active = ?, notes = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      input.category, input.beneficiaryName.trim(), input.cadence, input.limitPesewas,
      input.active === false ? 0 : 1, input.notes?.trim() || null, now, input.workerId, input.id,
    );
    return { policyId: input.id };
  }

  const id = `dp-${uuidv4()}`;
  db.prepare(
    `INSERT INTO drawing_policies (
       id, category, beneficiary_name, cadence, limit_pesewas, active, notes,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.category, input.beneficiaryName.trim(), input.cadence, input.limitPesewas,
    input.active === false ? 0 : 1, input.notes?.trim() || null,
    input.workerId, input.workerId, input.deviceId,
  );
  return { policyId: id };
}

export function getDrawingReport(
  db: DB,
  input: { period: 'DAILY' | 'WEEKLY' | 'MONTHLY'; fromDate: string; toDate: string; locationId?: string | null },
): DrawingReportRow[] {
  const expr =
    input.period === 'DAILY'
      ? "substr(created_at, 1, 10)"
      : input.period === 'MONTHLY'
        ? "substr(created_at, 1, 7)"
        : "strftime('%Y-W%W', created_at)";
  const params: unknown[] = [`${input.fromDate}T00:00:00.000Z`, `${input.toDate}T23:59:59.999Z`];
  const locSql = input.locationId ? 'AND location_id = ?' : '';
  if (input.locationId) params.push(input.locationId);
  return db.prepare(
    `SELECT ${expr} AS periodKey, category, beneficiary_name AS beneficiaryName,
            COALESCE(SUM(amount_pesewas), 0) AS totalPesewas,
            COUNT(*) AS count
       FROM owner_drawings
      WHERE created_at >= ? AND created_at <= ? ${locSql}
      GROUP BY periodKey, category, beneficiary_name
      ORDER BY periodKey DESC, totalPesewas DESC`,
  ).all(...params) as DrawingReportRow[];
}
