// Worker administration: add, deactivate, terminate, change PIN, reset PIN.
// Role-gated; see ROLE_RULES.

import type { Database as DB } from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { normalizePhone } from '../../shared/lib/phone.js';
import {
  PIN_BCRYPT_ROUNDS,
  DEFAULT_CONSUMPTION_ALLOWANCE_UNITS,
} from '../../shared/lib/constants.js';
import { clearPinAttempts } from './workers.js';

const ADMIN_ROLES = new Set(['OWNER', 'FOUNDER']);
const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

function requireActorRole(db: DB, actorId: string, allowed: Set<string>): string {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!allowed.has(w.role)) {
    throw new Error(`actor role ${w.role} not permitted (need one of: ${[...allowed].join(', ')})`);
  }
  return w.role;
}

export interface AddWorkerInput {
  fullName: string;
  phone: string;
  role: 'OWNER' | 'FOUNDER' | 'SUPERVISOR' | 'COUNTER' | 'DRIVER' | 'STOCKMASTER';
  pin: string;
  baseSalaryPesewas?: number;
  consumptionAllowanceUnits?: number;
  hiredAt?: string; // YYYY-MM-DD
  notes?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export function addWorker(db: DB, input: AddWorkerInput): { workerId: string } {
  requireActorRole(db, input.actorWorkerId, ADMIN_ROLES);
  if (!input.fullName.trim()) throw new Error('fullName required');
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error(`invalid phone '${input.phone}'`);
  if (!/^\d{4,6}$/.test(input.pin)) throw new Error('PIN must be 4–6 digits');
  if (input.role === 'SYSTEM' as unknown) throw new Error('cannot create SYSTEM workers');

  const dup = db
    .prepare(
      `SELECT id FROM workers WHERE phone = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(phone) as { id: string } | undefined;
  if (dup) throw new Error(`a worker with phone ${phone} already exists`);

  const workerId = `w-${uuidv4()}`;
  const pinHash = bcrypt.hashSync(input.pin, PIN_BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  const hiredAt = input.hiredAt ?? now.slice(0, 10);

  db.prepare(
    `INSERT INTO workers (
      id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, notes, created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    workerId,
    input.fullName.trim(),
    phone,
    input.role,
    pinHash,
    input.baseSalaryPesewas ?? 0,
    input.consumptionAllowanceUnits ?? DEFAULT_CONSUMPTION_ALLOWANCE_UNITS,
    hiredAt,
    input.notes ?? null,
    input.actorWorkerId,
    input.actorWorkerId,
    input.deviceId,
  );

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'WORKER_ADDED',
    entityType: 'workers',
    entityId: workerId,
    afterValue: {
      fullName: input.fullName,
      phone,
      role: input.role,
      hiredAt,
    },
    deviceId: input.deviceId,
  });

  return { workerId };
}

export function deactivateWorker(
  db: DB,
  workerId: string,
  actorWorkerId: string,
  deviceId: string,
): void {
  requireActorRole(db, actorWorkerId, ADMIN_ROLES);
  if (workerId === actorWorkerId) throw new Error('cannot deactivate yourself');
  if (workerId === 'sys-system') throw new Error('cannot deactivate SYSTEM');

  const w = db
    .prepare('SELECT id, active FROM workers WHERE id = ?')
    .get(workerId) as { id: string; active: number } | undefined;
  if (!w) throw new Error(`worker ${workerId} not found`);
  if (w.active === 0) throw new Error('worker already inactive');

  db.prepare(
    'UPDATE workers SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(new Date().toISOString(), actorWorkerId, workerId);

  logAudit(db, {
    workerId: actorWorkerId,
    action: 'WORKER_DEACTIVATED',
    entityType: 'workers',
    entityId: workerId,
    deviceId,
  });
}

export function reactivateWorker(
  db: DB,
  workerId: string,
  actorWorkerId: string,
  deviceId: string,
): void {
  requireActorRole(db, actorWorkerId, ADMIN_ROLES);
  const w = db
    .prepare('SELECT active, terminated_at FROM workers WHERE id = ?')
    .get(workerId) as { active: number; terminated_at: string | null } | undefined;
  if (!w) throw new Error(`worker ${workerId} not found`);
  if (w.terminated_at) throw new Error('cannot reactivate terminated worker — they have left');
  if (w.active === 1) throw new Error('worker already active');

  db.prepare(
    'UPDATE workers SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(new Date().toISOString(), actorWorkerId, workerId);

  logAudit(db, {
    workerId: actorWorkerId,
    action: 'WORKER_REACTIVATED',
    entityType: 'workers',
    entityId: workerId,
    deviceId,
  });
}

export function terminateWorker(
  db: DB,
  workerId: string,
  reason: string,
  actorWorkerId: string,
  deviceId: string,
): void {
  requireActorRole(db, actorWorkerId, ADMIN_ROLES);
  if (!reason.trim()) throw new Error('termination reason required');
  if (workerId === actorWorkerId) throw new Error('cannot terminate yourself');
  if (workerId === 'sys-system') throw new Error('cannot terminate SYSTEM');

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workers
        SET terminated_at = ?, termination_reason = ?, active = 0,
            updated_at = ?, updated_by = ?
        WHERE id = ? AND terminated_at IS NULL`,
  ).run(today, reason, now, actorWorkerId, workerId);

  logAudit(db, {
    workerId: actorWorkerId,
    action: 'WORKER_TERMINATED',
    entityType: 'workers',
    entityId: workerId,
    afterValue: { terminatedAt: today, reason },
    deviceId,
  });
}

export function changePin(
  db: DB,
  workerId: string,
  oldPin: string,
  newPin: string,
  deviceId: string,
): void {
  if (!/^\d{4,6}$/.test(newPin)) throw new Error('new PIN must be 4–6 digits');

  const w = db
    .prepare('SELECT pin_hash, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(workerId) as
    | { pin_hash: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('worker not found or inactive');
  }
  if (!bcrypt.compareSync(oldPin, w.pin_hash)) {
    throw new Error('old PIN does not match');
  }
  const newHash = bcrypt.hashSync(newPin, PIN_BCRYPT_ROUNDS);
  db.prepare(
    'UPDATE workers SET pin_hash = ?, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(newHash, new Date().toISOString(), workerId, workerId);

  logAudit(db, {
    workerId,
    action: 'PIN_CHANGED',
    entityType: 'workers',
    entityId: workerId,
    deviceId,
  });
}

export function resetPin(
  db: DB,
  workerId: string,
  newPin: string,
  actorWorkerId: string,
  deviceId: string,
): void {
  requireActorRole(db, actorWorkerId, SUPERVISOR_ROLES);
  if (!/^\d{4,6}$/.test(newPin)) throw new Error('new PIN must be 4–6 digits');
  if (workerId === 'sys-system') throw new Error('cannot reset SYSTEM PIN');

  const newHash = bcrypt.hashSync(newPin, PIN_BCRYPT_ROUNDS);
  db.prepare(
    'UPDATE workers SET pin_hash = ?, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(newHash, new Date().toISOString(), actorWorkerId, workerId);

  // Clear any active lockouts across all devices for this worker.
  db.prepare(
    `UPDATE pin_attempts SET attempt_count = 0, locked_until = NULL, updated_at = ?
       WHERE worker_id = ?`,
  ).run(new Date().toISOString(), workerId);
  // also reset our local cache, in case this device had attempts
  clearPinAttempts(db, workerId, deviceId);

  logAudit(db, {
    workerId: actorWorkerId,
    action: 'PIN_RESET',
    entityType: 'workers',
    entityId: workerId,
    deviceId,
  });
}

export interface AdminWorker {
  id: string;
  fullName: string;
  phone: string;
  role: string;
  active: boolean;
  hiredAt: string;
  terminatedAt: string | null;
  terminationReason: string | null;
  consumptionAllowanceUnits: number;
  baseSalaryPesewas: number;
}

export function listWorkersForAdmin(db: DB): AdminWorker[] {
  const rows = db
    .prepare(
      `SELECT id, full_name AS fullName, phone, role, active,
              hired_at AS hiredAt, terminated_at AS terminatedAt,
              termination_reason AS terminationReason,
              consumption_allowance_units AS consumptionAllowanceUnits,
              base_salary_pesewas AS baseSalaryPesewas
         FROM workers
         WHERE deleted_at IS NULL AND role != 'SYSTEM'
         ORDER BY active DESC, full_name ASC`,
    )
    .all() as Array<{
      id: string; fullName: string; phone: string; role: string; active: number;
      hiredAt: string; terminatedAt: string | null; terminationReason: string | null;
      consumptionAllowanceUnits: number; baseSalaryPesewas: number;
    }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}
