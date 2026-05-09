// Period close (day lock).
//
// sealDay() marks a (location, business_date) as no-more-changes. Other
// services (voidSale, breakage report, etc.) call isDateSealed() before
// touching anything dated to that day.
//
// reopenDay() is OWNER-only and audit-logged with a reason. After a reopen,
// a follow-up sealDay creates a fresh period_closes row — the original
// sealed → reopened pair stays for audit.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';

const SEAL_ROLES = new Set(['OWNER', 'FOUNDER']);

function requireOwner(db: DB, actorId: string): string {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!SEAL_ROLES.has(w.role)) {
    throw new Error(`day-lock requires OWNER or FOUNDER — your role is ${w.role}`);
  }
  return w.role;
}

function assertDate(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`invalid date '${d}', expected YYYY-MM-DD`);
  }
}

/** True if this (location, date) has an active period_closes row. */
export function isDateSealed(db: DB, locationId: string, businessDate: string): boolean {
  assertDate(businessDate);
  const r = db
    .prepare(
      `SELECT 1 FROM period_closes
        WHERE location_id = ? AND business_date = ? AND reopened_at IS NULL
        LIMIT 1`,
    )
    .get(locationId, businessDate);
  return !!r;
}

export interface PeriodCloseRow {
  id: string;
  locationId: string;
  businessDate: string;
  sealedAt: string;
  sealedBy: string;
  sealedByName: string;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenedByName: string | null;
  reopenedReason: string | null;
}

export function getActiveClose(db: DB, locationId: string, businessDate: string): PeriodCloseRow | null {
  assertDate(businessDate);
  const row = db.prepare(
    `SELECT pc.id, pc.location_id AS locationId, pc.business_date AS businessDate,
            pc.sealed_at AS sealedAt, pc.sealed_by AS sealedBy,
            sw.full_name AS sealedByName,
            pc.reopened_at AS reopenedAt, pc.reopened_by AS reopenedBy,
            rw.full_name AS reopenedByName, pc.reopened_reason AS reopenedReason
       FROM period_closes pc
       JOIN workers sw ON sw.id = pc.sealed_by
       LEFT JOIN workers rw ON rw.id = pc.reopened_by
      WHERE pc.location_id = ? AND pc.business_date = ? AND pc.reopened_at IS NULL
      LIMIT 1`,
  ).get(locationId, businessDate) as PeriodCloseRow | undefined;
  return row ?? null;
}

export function listClosesForLocation(db: DB, locationId: string, limit = 60): PeriodCloseRow[] {
  return db.prepare(
    `SELECT pc.id, pc.location_id AS locationId, pc.business_date AS businessDate,
            pc.sealed_at AS sealedAt, pc.sealed_by AS sealedBy,
            sw.full_name AS sealedByName,
            pc.reopened_at AS reopenedAt, pc.reopened_by AS reopenedBy,
            rw.full_name AS reopenedByName, pc.reopened_reason AS reopenedReason
       FROM period_closes pc
       JOIN workers sw ON sw.id = pc.sealed_by
       LEFT JOIN workers rw ON rw.id = pc.reopened_by
      WHERE pc.location_id = ?
      ORDER BY pc.business_date DESC, pc.sealed_at DESC
      LIMIT ?`,
  ).all(locationId, limit) as PeriodCloseRow[];
}

export interface SealDayInput {
  locationId: string;
  businessDate: string;
  actorWorkerId: string;
  deviceId: string;
}

export function sealDay(db: DB, input: SealDayInput): { closeId: string } {
  requireOwner(db, input.actorWorkerId);
  assertDate(input.businessDate);

  if (isDateSealed(db, input.locationId, input.businessDate)) {
    throw new Error(
      `period ${input.businessDate} at ${input.locationId} is already sealed.`,
    );
  }

  // Refuse to seal a future date — there's nothing to lock yet.
  const today = new Date().toISOString().slice(0, 10);
  if (input.businessDate > today) {
    throw new Error(`cannot seal a future date (${input.businessDate} > today ${today})`);
  }

  // Refuse to seal if there's still an open shift on that date at this location.
  // An open shift means the cashier hasn't done the blind cash count yet —
  // sealing would lock data that's still being captured.
  const openShifts = db.prepare(
    `SELECT COUNT(*) AS n FROM shifts
       WHERE location_id = ? AND date(opened_at) <= ?
         AND closed_at IS NULL`,
  ).get(input.locationId, input.businessDate) as { n: number };
  if (openShifts.n > 0) {
    throw new Error(
      `cannot seal ${input.businessDate}: ${openShifts.n} open shift(s) at this location. ` +
      `Close all shifts before sealing the day.`,
    );
  }

  const id = `pc-${uuidv4()}`;
  db.prepare(
    `INSERT INTO period_closes (id, location_id, business_date, sealed_by, device_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.locationId, input.businessDate, input.actorWorkerId, input.deviceId);

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PERIOD_SEALED',
    entityType: 'period_closes',
    entityId: id,
    afterValue: { locationId: input.locationId, businessDate: input.businessDate },
    deviceId: input.deviceId,
  });

  return { closeId: id };
}

export interface ReopenDayInput {
  locationId: string;
  businessDate: string;
  reason: string;
  actorWorkerId: string;
  deviceId: string;
}

export function reopenDay(db: DB, input: ReopenDayInput): { closeId: string } {
  requireOwner(db, input.actorWorkerId);
  assertDate(input.businessDate);
  if (!input.reason.trim()) throw new Error('reopen reason required');

  const active = db.prepare(
    `SELECT id FROM period_closes
      WHERE location_id = ? AND business_date = ? AND reopened_at IS NULL
      LIMIT 1`,
  ).get(input.locationId, input.businessDate) as { id: string } | undefined;
  if (!active) {
    throw new Error(`no active period close for ${input.businessDate} at ${input.locationId}`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE period_closes
        SET reopened_at = ?, reopened_by = ?, reopened_reason = ?
        WHERE id = ?`,
  ).run(now, input.actorWorkerId, input.reason.trim(), active.id);

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'PERIOD_REOPENED',
    entityType: 'period_closes',
    entityId: active.id,
    afterValue: {
      locationId: input.locationId,
      businessDate: input.businessDate,
      reason: input.reason.trim(),
    },
    deviceId: input.deviceId,
  });

  return { closeId: active.id };
}

/** Service-level guard: throw if the (location, date) is sealed. Pass this
 *  the original sale's location + business date before voiding/editing. */
export function assertNotSealed(
  db: DB,
  locationId: string,
  businessDate: string,
  what = 'this action',
): void {
  if (isDateSealed(db, locationId, businessDate)) {
    throw new Error(
      `${what} touches ${businessDate} which is sealed. ` +
      `An OWNER must reopen the day first (Settings → Period close).`,
    );
  }
}
