import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { postTaxPaymentIfActive } from './ledger.js';

const TAX_PAYMENT_ROLES = new Set(['OWNER', 'FOUNDER', 'SUPERVISOR']);

export interface TaxPaymentRow {
  id: string;
  taxPeriodFrom: string;
  taxPeriodTo: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference: string | null;
  paidAt: string;
  notes: string | null;
  workerName: string;
  shiftId: string | null;
}

export interface RecordTaxPaymentInput {
  actorWorkerId: string;
  locationId: string;
  shiftId?: string | null;
  taxPeriodFrom: string;
  taxPeriodTo: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference?: string | null;
  paidAt?: string | null;
  notes?: string | null;
  deviceId: string;
}

function assertDateOnly(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
}

function requireTaxPaymentActor(db: DB, actorWorkerId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorWorkerId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('tax payment: actor not active');
  }
  if (!TAX_PAYMENT_ROLES.has(w.role)) {
    throw new Error(`tax payment: role ${w.role} not permitted`);
  }
}

export function listTaxPaymentsForPeriod(
  db: DB,
  input: { locationId?: string | null; fromDate: string; toDate: string },
): TaxPaymentRow[] {
  assertDateOnly('fromDate', input.fromDate);
  assertDateOnly('toDate', input.toDate);
  const params: unknown[] = [input.toDate, input.fromDate];
  const locationSql = input.locationId ? 'AND tp.location_id = ?' : '';
  if (input.locationId) params.push(input.locationId);
  return db.prepare(
    `SELECT tp.id,
            tp.tax_period_from AS taxPeriodFrom,
            tp.tax_period_to AS taxPeriodTo,
            tp.amount_pesewas AS amountPesewas,
            tp.payment_method AS paymentMethod,
            tp.payment_reference AS paymentReference,
            tp.paid_at AS paidAt,
            tp.notes,
            w.full_name AS workerName,
            tp.shift_id AS shiftId
       FROM tax_payments tp
       JOIN workers w ON w.id = tp.created_by
      WHERE tp.tax_period_from <= ?
        AND tp.tax_period_to >= ?
        ${locationSql}
      ORDER BY tp.paid_at DESC, tp.created_at DESC`,
  ).all(...params) as TaxPaymentRow[];
}

export function recordTaxPayment(db: DB, input: RecordTaxPaymentInput): { paymentId: string } {
  requireTaxPaymentActor(db, input.actorWorkerId);
  assertDateOnly('taxPeriodFrom', input.taxPeriodFrom);
  assertDateOnly('taxPeriodTo', input.taxPeriodTo);
  if (input.taxPeriodTo < input.taxPeriodFrom) throw new Error('taxPeriodTo must be on or after taxPeriodFrom');
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('amountPesewas must be a positive integer');
  }

  const method = db
    .prepare('SELECT code, requires_reference, active FROM payment_methods WHERE code = ?')
    .get(input.paymentMethod) as { code: string; requires_reference: number; active: number } | undefined;
  if (!method || method.active !== 1) throw new Error(`payment method ${input.paymentMethod} is not active`);
  if (input.paymentMethod === 'CREDIT') throw new Error('tax payment cannot use CREDIT');
  const reference = input.paymentReference?.trim() || null;
  if (method.requires_reference === 1 && !reference) {
    throw new Error(`${input.paymentMethod} requires a payment reference`);
  }

  let shiftId = input.shiftId ?? null;
  if (input.paymentMethod === 'CASH') {
    if (!shiftId) throw new Error('cash tax payments require an open shift');
    const shift = db.prepare(
      `SELECT id, location_id, closed_at FROM shifts WHERE id = ?`,
    ).get(shiftId) as { id: string; location_id: string; closed_at: string | null } | undefined;
    if (!shift || shift.closed_at) throw new Error('cash tax payment shift is not open');
    if (shift.location_id !== input.locationId) throw new Error('cash tax payment shift location mismatch');
  } else {
    shiftId = null;
  }

  const id = `taxpay-${uuidv4()}`;
  const paidAt = input.paidAt?.trim() || new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tax_payments (
         id, location_id, shift_id, tax_period_from, tax_period_to,
         amount_pesewas, payment_method, payment_reference, paid_at, notes,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.locationId,
      shiftId,
      input.taxPeriodFrom,
      input.taxPeriodTo,
      input.amountPesewas,
      input.paymentMethod,
      reference,
      paidAt,
      input.notes?.trim() || null,
      input.actorWorkerId,
      input.actorWorkerId,
      input.deviceId,
    );

    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'TAX_PAYMENT_RECORDED',
      entityType: 'tax_payments',
      entityId: id,
      afterValue: {
        taxPeriodFrom: input.taxPeriodFrom,
        taxPeriodTo: input.taxPeriodTo,
        amountPesewas: input.amountPesewas,
        paymentMethod: input.paymentMethod,
        paymentReference: reference,
        paidAt,
        shiftId,
      },
      deviceId: input.deviceId,
    });
    postTaxPaymentIfActive(db, id, input.actorWorkerId, input.deviceId);
  })();

  return { paymentId: id };
}
