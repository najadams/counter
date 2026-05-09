// First-run setup. Detects an empty/SYSTEM-only workers table and seeds the
// first OWNER without requiring an actor (since there is no human actor yet).
//
// All other paths through the system require an actorWorkerId. This is the
// one privileged path that bootstraps the very first human account.

import type { Database as DB } from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { generateRecoveryCode } from './recovery.js';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { normalizePhone } from '../../shared/lib/phone.js';
import {
  PIN_BCRYPT_ROUNDS,
  DEFAULT_CONSUMPTION_ALLOWANCE_UNITS,
} from '../../shared/lib/constants.js';

/** True if there are no human (non-SYSTEM) workers yet. */
export function needsOwnerSetup(db: DB): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM workers
        WHERE role != 'SYSTEM' AND deleted_at IS NULL`,
    )
    .get() as { n: number };
  return row.n === 0;
}

export interface CreateFirstOwnerInput {
  fullName: string;
  phone: string;
  pin: string;
  deviceId: string;
}

export function createFirstOwner(
  db: DB,
  input: CreateFirstOwnerInput,
): { workerId: string; recoveryCode: string } {
  // Re-check inside the same call to close the race window.
  if (!needsOwnerSetup(db)) {
    throw new Error('owner setup already complete — sign in instead');
  }

  if (!input.fullName.trim()) throw new Error('full name required');
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error(`invalid phone '${input.phone}'`);
  if (!/^\d{4,6}$/.test(input.pin)) throw new Error('PIN must be 4–6 digits');

  const workerId = `w-${uuidv4()}`;
  const pinHash = bcrypt.hashSync(input.pin, PIN_BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // SYSTEM acts as the audit-trail actor for this single bootstrap event.
  const SYSTEM_ID = 'sys-system';

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workers (
        id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, notes, created_by, updated_by, device_id
      ) VALUES (?, ?, ?, 'OWNER', ?, 0, ?, 1, ?, NULL, ?, ?, ?)`,
    ).run(
      workerId,
      input.fullName.trim(),
      phone,
      pinHash,
      DEFAULT_CONSUMPTION_ALLOWANCE_UNITS,
      today,
      SYSTEM_ID,
      SYSTEM_ID,
      input.deviceId,
    );

    logAudit(db, {
      workerId: SYSTEM_ID,
      action: 'OWNER_BOOTSTRAPPED',
      entityType: 'workers',
      entityId: workerId,
      afterValue: {
        fullName: input.fullName.trim(),
        phone,
        role: 'OWNER',
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  // Generate the OWNER recovery code AFTER the transaction succeeds. This
  // is the only time the plaintext code is visible — the SetupScreen shows
  // it on a "save this code" panel.
  const { code } = generateRecoveryCode(db, workerId, 'SETUP', input.deviceId);
  return { workerId, recoveryCode: code };
}
