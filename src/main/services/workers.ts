// workers service: login candidates + PIN verification with rate-limiting.
// PINs are bcrypt-hashed (12 rounds — see PIN_BCRYPT_ROUNDS).

import type { Database as DB } from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
  PIN_LOCKOUT_MINUTES,
  PIN_MAX_ATTEMPTS,
} from '../../shared/lib/constants.js';
import { logAudit } from '../db/audit.js';

export interface LoginCandidate {
  id: string;
  fullName: string;
  role: string;
}

/** Active workers eligible to log in, excluding SYSTEM and inactive/deleted. */
export function listLoginCandidates(db: DB): LoginCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, full_name AS fullName, role
         FROM workers
         WHERE active = 1
           AND deleted_at IS NULL
           AND terminated_at IS NULL
           AND role != 'SYSTEM'
         ORDER BY full_name ASC`,
    )
    .all() as LoginCandidate[];
  return rows;
}

export type VerifyPinResult =
  | { ok: true; workerId: string; fullName: string; role: string }
  | { ok: false; reason: 'INVALID_PIN'; attemptsRemaining: number }
  | { ok: false; reason: 'LOCKED_OUT'; lockedUntil: string }
  | { ok: false; reason: 'UNKNOWN_WORKER' }
  | { ok: false; reason: 'SYSTEM_ROLE_REJECTED' };

/**
 * Verify a worker's PIN. Rate-limits per (worker_id, device_id):
 *  - PIN_MAX_ATTEMPTS wrong PINs in a row => locked for PIN_LOCKOUT_MINUTES
 *  - Successful login resets attempts to zero
 *  - SYSTEM role is rejected outright
 *
 * Each call writes audit_log: WORKER_LOGIN_SUCCESS, WORKER_LOGIN_FAILED, or
 * WORKER_LOCKED_OUT. Audit happens regardless of outcome.
 */
export function verifyPin(
  db: DB,
  workerId: string,
  pin: string,
  deviceId: string,
): VerifyPinResult {
  const worker = db
    .prepare(
      `SELECT id, full_name, role, pin_hash, active, deleted_at, terminated_at
         FROM workers
         WHERE id = ?`,
    )
    .get(workerId) as
    | {
        id: string;
        full_name: string;
        role: string;
        pin_hash: string;
        active: number;
        deleted_at: string | null;
        terminated_at: string | null;
      }
    | undefined;

  if (
    !worker ||
    worker.active !== 1 ||
    worker.deleted_at !== null ||
    worker.terminated_at !== null
  ) {
    // Audit even unknown attempts — they may be probing.
    logAudit(db, {
      workerId: 'sys-system',
      action: 'WORKER_LOGIN_FAILED',
      entityType: 'workers',
      entityId: workerId,
      deviceId,
      notes: 'unknown or inactive worker',
    });
    return { ok: false, reason: 'UNKNOWN_WORKER' };
  }

  if (worker.role === 'SYSTEM') {
    logAudit(db, {
      workerId: 'sys-system',
      action: 'WORKER_LOGIN_FAILED',
      entityType: 'workers',
      entityId: workerId,
      deviceId,
      notes: 'SYSTEM role login rejected',
    });
    return { ok: false, reason: 'SYSTEM_ROLE_REJECTED' };
  }

  // Lookup or create the rate-limit row for this (worker, device).
  const attemptsRow = db
    .prepare(
      `SELECT id, attempt_count, locked_until
         FROM pin_attempts
         WHERE worker_id = ? AND device_id = ?`,
    )
    .get(workerId, deviceId) as
    | { id: string; attempt_count: number; locked_until: string | null }
    | undefined;

  const now = new Date();
  const nowIso = now.toISOString();

  // If currently locked, refuse and audit.
  if (attemptsRow?.locked_until && attemptsRow.locked_until > nowIso) {
    logAudit(db, {
      workerId: 'sys-system',
      action: 'WORKER_LOGIN_FAILED',
      entityType: 'workers',
      entityId: workerId,
      deviceId,
      notes: `locked until ${attemptsRow.locked_until}`,
    });
    return { ok: false, reason: 'LOCKED_OUT', lockedUntil: attemptsRow.locked_until };
  }

  // Lock has expired: clear it before checking the PIN.
  if (attemptsRow?.locked_until && attemptsRow.locked_until <= nowIso) {
    db.prepare(
      `UPDATE pin_attempts
          SET attempt_count = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?`,
    ).run(nowIso, attemptsRow.id);
  }

  // Now do the actual PIN check.
  const pinOk = bcrypt.compareSync(pin, worker.pin_hash);

  if (pinOk) {
    if (attemptsRow) {
      db.prepare(
        `UPDATE pin_attempts
            SET attempt_count = 0, locked_until = NULL, last_attempt_at = ?, updated_at = ?
            WHERE id = ?`,
      ).run(nowIso, nowIso, attemptsRow.id);
    }
    logAudit(db, {
      workerId,
      action: 'WORKER_LOGIN_SUCCESS',
      entityType: 'workers',
      entityId: workerId,
      deviceId,
    });
    return {
      ok: true,
      workerId: worker.id,
      fullName: worker.full_name,
      role: worker.role,
    };
  }

  // Wrong PIN: increment + maybe lock.
  const newCount = (attemptsRow?.attempt_count ?? 0) + 1;
  const willLock = newCount >= PIN_MAX_ATTEMPTS;
  const lockedUntil = willLock
    ? new Date(now.getTime() + PIN_LOCKOUT_MINUTES * 60_000).toISOString()
    : null;

  if (attemptsRow) {
    db.prepare(
      `UPDATE pin_attempts
          SET attempt_count = ?, locked_until = ?, last_attempt_at = ?, updated_at = ?
          WHERE id = ?`,
    ).run(newCount, lockedUntil, nowIso, nowIso, attemptsRow.id);
  } else {
    db.prepare(
      `INSERT INTO pin_attempts (id, worker_id, device_id, attempt_count, locked_until, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`pa-${uuidv4()}`, workerId, deviceId, newCount, lockedUntil, nowIso);
  }

  logAudit(db, {
    workerId: 'sys-system',
    action: willLock ? 'WORKER_LOCKED_OUT' : 'WORKER_LOGIN_FAILED',
    entityType: 'workers',
    entityId: workerId,
    deviceId,
    notes: `attempt ${newCount}${willLock ? ` — locked until ${lockedUntil}` : ''}`,
  });

  if (willLock && lockedUntil) {
    return { ok: false, reason: 'LOCKED_OUT', lockedUntil };
  }
  return {
    ok: false,
    reason: 'INVALID_PIN',
    attemptsRemaining: PIN_MAX_ATTEMPTS - newCount,
  };
}

/** For tests + supervisor "reset PIN attempts" tooling. */
export function clearPinAttempts(
  db: DB,
  workerId: string,
  deviceId: string,
): void {
  db.prepare(
    `UPDATE pin_attempts
        SET attempt_count = 0, locked_until = NULL, updated_at = ?
        WHERE worker_id = ? AND device_id = ?`,
  ).run(new Date().toISOString(), workerId, deviceId);
}
