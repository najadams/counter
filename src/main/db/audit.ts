// Audit log writes. The ONLY function allowed to write to audit_log.
// Append-only at the application boundary.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { currentDeviceId } from '../ipc/session.js';

export interface LogAuditInput {
  workerId: string;
  action: string;             // e.g. 'SALE_COMPLETED', 'BREAKAGE_REPORTED'
  entityType: string;         // table name
  entityId: string;
  beforeValue?: unknown;      // serialized to JSON
  afterValue?: unknown;
  deviceId: string;
  notes?: string;
}

/** Append a row to audit_log. Never UPDATE, never DELETE.
 *
 *  Device attribution: on the HTTP transport the action runs inside a request
 *  scope carrying the remote device id, which wins over the caller-supplied
 *  (host) deviceId — so a sale rung from a phone audits as that phone. On the
 *  desktop IPC path there is no scope, so input.deviceId (the host) is used. */
export function logAudit(db: DB, input: LogAuditInput): string {
  const id = `aud-${uuidv4()}`;
  const deviceId = currentDeviceId(input.deviceId);
  db.prepare(
    `INSERT INTO audit_log
      (id, worker_id, action, entity_type, entity_id, before_value, after_value, device_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workerId,
    input.action,
    input.entityType,
    input.entityId,
    input.beforeValue === undefined ? null : JSON.stringify(input.beforeValue),
    input.afterValue === undefined ? null : JSON.stringify(input.afterValue),
    deviceId,
    input.notes ?? null,
  );
  return id;
}
