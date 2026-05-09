// Audit log read API. Append-only at the write boundary; this module is the
// only sanctioned read surface beyond ad-hoc SQL.
//
// OWNER/FOUNDER read this for forensics ("who voided that sale", "when did
// the supervisor reset PINs"). Line workers should not see it.

import type { Database as DB } from 'better-sqlite3';

const VIEWER_ROLES = new Set(['OWNER', 'FOUNDER']);

function requireViewer(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!VIEWER_ROLES.has(w.role)) {
    throw new Error(`audit log is OWNER/FOUNDER only — your role is ${w.role}`);
  }
}

export interface AuditEntry {
  id: string;
  workerId: string;
  workerName: string;
  workerRole: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue: unknown | null;
  afterValue: unknown | null;
  deviceId: string;
  notes: string | null;
  createdAt: string;
}

export interface AuditFilters {
  workerId?: string | null;
  action?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Inclusive YYYY-MM-DD. */
  fromDate?: string | null;
  /** Inclusive YYYY-MM-DD. */
  toDate?: string | null;
  /** Free text search across notes + JSON values. */
  search?: string | null;
  limit?: number;
  offset?: number;
}

export function listAuditEntries(
  db: DB,
  actorId: string,
  filters: AuditFilters,
): { entries: AuditEntry[]; totalCount: number } {
  requireViewer(db, actorId);

  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.workerId) {
    where.push('a.worker_id = ?');
    params.push(filters.workerId);
  }
  if (filters.action) {
    where.push('a.action = ?');
    params.push(filters.action);
  }
  if (filters.entityType) {
    where.push('a.entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    where.push('a.entity_id = ?');
    params.push(filters.entityId);
  }
  if (filters.fromDate) {
    // ISO timestamps sort as strings; YYYY-MM-DD lexically <= YYYY-MM-DDT...
    where.push('a.created_at >= ?');
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    // To make `toDate` inclusive of that whole day, append T23:59:59.999Z.
    where.push('a.created_at <= ?');
    params.push(filters.toDate + 'T23:59:59.999Z');
  }
  if (filters.search && filters.search.trim()) {
    where.push('(a.notes LIKE ? OR a.before_value LIKE ? OR a.after_value LIKE ?)');
    const pattern = `%${filters.search.trim()}%`;
    params.push(pattern, pattern, pattern);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log a ${whereClause}`)
    .get(...params) as { n: number };

  const limit = Math.min(Math.max(1, filters.limit ?? 200), 1000);
  const offset = Math.max(0, filters.offset ?? 0);

  const rows = db
    .prepare(
      `SELECT a.id, a.worker_id AS workerId,
              w.full_name AS workerName, w.role AS workerRole,
              a.action, a.entity_type AS entityType, a.entity_id AS entityId,
              a.before_value AS beforeValueRaw,
              a.after_value AS afterValueRaw,
              a.device_id AS deviceId, a.notes,
              a.created_at AS createdAt
         FROM audit_log a
         LEFT JOIN workers w ON w.id = a.worker_id
         ${whereClause}
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<
      Omit<AuditEntry, 'beforeValue' | 'afterValue'> & {
        beforeValueRaw: string | null;
        afterValueRaw: string | null;
      }
    >;

  const entries: AuditEntry[] = rows.map((r) => ({
    id: r.id,
    workerId: r.workerId,
    workerName: r.workerName ?? '(unknown)',
    workerRole: r.workerRole ?? '',
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    beforeValue: r.beforeValueRaw ? safeJSON(r.beforeValueRaw) : null,
    afterValue: r.afterValueRaw ? safeJSON(r.afterValueRaw) : null,
    deviceId: r.deviceId,
    notes: r.notes,
    createdAt: r.createdAt,
  }));

  return { entries, totalCount: total.n };
}

export function listAuditDistinctActions(db: DB, actorId: string): string[] {
  requireViewer(db, actorId);
  const rows = db
    .prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action ASC`)
    .all() as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

export function listAuditDistinctEntityTypes(db: DB, actorId: string): string[] {
  requireViewer(db, actorId);
  const rows = db
    .prepare(`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type ASC`)
    .all() as Array<{ entity_type: string }>;
  return rows.map((r) => r.entity_type);
}

function safeJSON(s: string): unknown {
  try { return JSON.parse(s); }
  catch { return s; }
}
