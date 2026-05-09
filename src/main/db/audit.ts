// Audit log writes. The ONLY function allowed to write to audit_log.
// Append-only at the application boundary.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

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

/** Append a row to audit_log. Never UPDATE, never DELETE. */
export function logAudit(db: DB, input: LogAuditInput): string {
  const id = `aud-${uuidv4()}`;
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
    input.deviceId,
    input.notes ?? null,
  );
  return id;
}
