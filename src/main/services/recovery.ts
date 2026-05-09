// OWNER PIN recovery via one-time code.
//
// At first-run setup, the wizard generates a 16-char alphanumeric recovery
// code (bcrypt-hashed), shows it once on screen, and stores the hash on the
// OWNER's worker row. The user is supposed to write it down somewhere safe
// (locked drawer, photo on personal phone, etc.).
//
// If the OWNER forgets the PIN, the LoginScreen "Forgot PIN" link asks for
// the code. On match, the OWNER picks a new PIN. The old code is consumed
// and a NEW recovery code is generated and shown — write it down again.
//
// An existing OWNER can also regenerate at will from Settings → Workers.
// Use case: lost the original paper, want a fresh code; or the spouse who
// kept it left and you want to invalidate.
//
// Audit: every generate + consume is logged with worker_id and trigger.

import type { Database as DB } from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { logAudit } from '../db/audit.js';
import { PIN_BCRYPT_ROUNDS } from '../../shared/lib/constants.js';

// 32 chars, no easily-confused (0/O, 1/I/L). Bigger search space, fewer
// transcription mistakes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 16;

function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  // Format XXXX-XXXX-XXXX-XXXX for readability
  return [out.slice(0, 4), out.slice(4, 8), out.slice(8, 12), out.slice(12, 16)].join('-');
}

/** Strip the formatting dashes + lowercase the alphabet so the user can
 *  type the code with or without hyphens, and case doesn't matter. */
function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

const OWNER_ROLES = new Set(['OWNER', 'FOUNDER']);

function requireOwner(db: DB, workerId: string): { role: string; fullName: string } {
  const w = db.prepare(
    'SELECT role, active, deleted_at, terminated_at, full_name FROM workers WHERE id = ?',
  ).get(workerId) as {
    role: string; active: number; deleted_at: string | null;
    terminated_at: string | null; full_name: string;
  } | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('worker not found or inactive');
  }
  if (!OWNER_ROLES.has(w.role)) {
    throw new Error(`recovery codes are OWNER/FOUNDER only — your role is ${w.role}`);
  }
  return { role: w.role, fullName: w.full_name };
}

/**
 * Generate a fresh recovery code for an OWNER and store the hash. Returns
 * the plaintext code; this is the only time it's visible. Any prior code
 * is overwritten (one active code per OWNER).
 *
 * @param actorWorkerId — who's triggering this. For first-run setup this
 *   equals workerId (self-service); for regenerate, also self-service. An
 *   OWNER cannot regenerate ANOTHER OWNER's code — they'd have to use that
 *   OWNER's session.
 */
export function generateRecoveryCode(
  db: DB,
  workerId: string,
  trigger: 'SETUP' | 'REGENERATE' | 'POST_RESET',
  deviceId: string,
): { code: string } {
  requireOwner(db, workerId);

  const code = generateCode();
  const hash = bcrypt.hashSync(normalizeCode(code), PIN_BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workers SET recovery_code_hash = ?, recovery_code_set_at = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
  ).run(hash, now, now, workerId, workerId);

  logAudit(db, {
    workerId,
    action: 'RECOVERY_CODE_GENERATED',
    entityType: 'workers',
    entityId: workerId,
    afterValue: { trigger },
    deviceId,
  });

  return { code };
}

/**
 * Verify a code against an OWNER's stored hash. Used by the LoginScreen
 * "Forgot PIN" flow. Returns ok = true and lets the caller proceed to
 * setting a new PIN. Does NOT consume the code — that happens in
 * resetOwnerPinWithCode below.
 */
export function verifyRecoveryCode(
  db: DB, workerId: string, code: string,
): { ok: boolean; reason?: 'NO_CODE_SET' | 'WRONG_CODE' | 'NOT_OWNER' } {
  let role: string;
  try {
    role = requireOwner(db, workerId).role;
    void role;
  } catch {
    return { ok: false, reason: 'NOT_OWNER' };
  }
  const w = db.prepare(
    'SELECT recovery_code_hash FROM workers WHERE id = ?',
  ).get(workerId) as { recovery_code_hash: string | null } | undefined;
  if (!w || !w.recovery_code_hash) return { ok: false, reason: 'NO_CODE_SET' };
  const ok = bcrypt.compareSync(normalizeCode(code), w.recovery_code_hash);
  return ok ? { ok: true } : { ok: false, reason: 'WRONG_CODE' };
}

/**
 * Reset the OWNER's PIN given a valid recovery code, then generate a fresh
 * recovery code and return it. The old code is consumed on success; the
 * new code is what the OWNER should write down going forward.
 *
 * Pin attempt counters / lockouts are cleared as part of the reset.
 */
export function resetOwnerPinWithCode(
  db: DB, workerId: string, code: string, newPin: string, deviceId: string,
): { newRecoveryCode: string } {
  if (!/^\d{4,6}$/.test(newPin)) throw new Error('new PIN must be 4–6 digits');

  const v = verifyRecoveryCode(db, workerId, code);
  if (!v.ok) {
    throw new Error(
      v.reason === 'NO_CODE_SET'
        ? 'No recovery code is set on this account. Contact another OWNER.'
        : v.reason === 'NOT_OWNER'
        ? 'Recovery is OWNER/FOUNDER only.'
        : 'That recovery code is wrong.',
    );
  }

  const newPinHash = bcrypt.hashSync(newPin, PIN_BCRYPT_ROUNDS);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE workers SET pin_hash = ?, recovery_code_hash = NULL, recovery_code_set_at = NULL,
                          updated_at = ?, updated_by = ?
         WHERE id = ?`,
    ).run(newPinHash, now, workerId, workerId);
    db.prepare(
      `UPDATE pin_attempts SET attempt_count = 0, locked_until = NULL, updated_at = ?
         WHERE worker_id = ?`,
    ).run(now, workerId);
    logAudit(db, {
      workerId,
      action: 'RECOVERY_CODE_CONSUMED',
      entityType: 'workers',
      entityId: workerId,
      afterValue: { trigger: 'PIN_RESET' },
      deviceId,
    });
  });
  tx();

  // Issue a fresh code so they're not left without one.
  return { newRecoveryCode: generateRecoveryCode(db, workerId, 'POST_RESET', deviceId).code };
}

/** Lightweight read for the LoginScreen — does this worker have a recovery
 *  code set? Used to show or hide the "Forgot PIN" link. */
export function hasRecoveryCode(db: DB, workerId: string): boolean {
  const w = db.prepare(
    'SELECT recovery_code_hash FROM workers WHERE id = ?',
  ).get(workerId) as { recovery_code_hash: string | null } | undefined;
  return !!w?.recovery_code_hash;
}

/** List active OWNERs for the LoginScreen "Forgot PIN" flow. */
export function listOwnersForRecovery(db: DB): Array<{ id: string; fullName: string; hasCode: boolean }> {
  const rows = db.prepare(
    `SELECT id, full_name AS fullName, (recovery_code_hash IS NOT NULL) AS hasCode
       FROM workers
      WHERE role IN ('OWNER', 'FOUNDER')
        AND active = 1 AND deleted_at IS NULL AND terminated_at IS NULL
      ORDER BY full_name ASC`,
  ).all() as Array<{ id: string; fullName: string; hasCode: number | boolean }>;
  return rows.map((r) => ({ ...r, hasCode: !!r.hasCode }));
}
