// Five-minute, device-bound capability for report reads.
//
// These tokens are intentionally process-memory only. They are not login
// tokens and never survive a renderer/host restart. Report reads validate but
// do not extend the idle deadline; only explicit user-activity touches do.

import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';
import { verifyPin } from './workers.js';

export type ReportAccessScope = 'OPERATIONAL' | 'OWNER';
const REPORT_IDLE_MS = 5 * 60 * 1000;
const REPORT_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

interface ReportAccessEntry {
  workerId: string;
  deviceId: string;
  role: string;
  scopes: ReportAccessScope[];
  lastActivityAt: number;
}

const reportTokens = new Map<string, ReportAccessEntry>();

function expiry(entry: ReportAccessEntry): number {
  return entry.lastActivityAt + REPORT_IDLE_MS;
}

function lookup(token: string, now: number): ReportAccessEntry | null {
  const entry = reportTokens.get(token);
  if (!entry) return null;
  // Keep the expired entry until the client sends its IDLE lock so the
  // security audit can record why the capability ended.
  if (expiry(entry) <= now) return null;
  return entry;
}

export function unlockReportAccess(db: DB, input: {
  workerId: string;
  pin: string;
  deviceId: string;
  now?: number;
}): { accessToken: string; scopes: ReportAccessScope[]; idleExpiresAt: string } {
  const auth = verifyPin(db, input.workerId, input.pin, input.deviceId);
  if (!auth.ok) {
    throw new Error(
      auth.reason === 'LOCKED_OUT'
        ? `reports locked out until ${auth.lockedUntil}`
        : `report PIN check failed (${auth.reason})`,
    );
  }
  if (!REPORT_ROLES.has(auth.role)) {
    throw new Error(`reports require SUPERVISOR, OWNER, or FOUNDER — your role is ${auth.role}`);
  }
  const now = input.now ?? Date.now();
  const scopes: ReportAccessScope[] = auth.role === 'OWNER' || auth.role === 'FOUNDER'
    ? ['OPERATIONAL', 'OWNER']
    : ['OPERATIONAL'];
  const accessToken = randomUUID();
  reportTokens.set(accessToken, {
    workerId: auth.workerId,
    deviceId: input.deviceId,
    role: auth.role,
    scopes,
    lastActivityAt: now,
  });
  logAudit(db, {
    workerId: auth.workerId,
    action: 'REPORT_ACCESS_UNLOCKED',
    entityType: 'reports',
    entityId: accessToken,
    afterValue: { scopes, idleMinutes: 5 },
    deviceId: input.deviceId,
  });
  return { accessToken, scopes, idleExpiresAt: new Date(now + REPORT_IDLE_MS).toISOString() };
}

export function requireReportAccess(input: {
  accessToken: string;
  workerId: string;
  deviceId: string;
  scope?: ReportAccessScope;
  now?: number;
  db?: DB;
}): ReportAccessEntry {
  const entry = lookup(input.accessToken, input.now ?? Date.now());
  if (!entry || entry.workerId !== input.workerId || entry.deviceId !== input.deviceId) {
    throw new Error('REPORT_ACCESS_LOCKED');
  }
  const scope = input.scope ?? 'OPERATIONAL';
  const live = input.db?.prepare(
    `SELECT role, active, deleted_at AS deletedAt, terminated_at AS terminatedAt
       FROM workers WHERE id = ?`,
  ).get(entry.workerId) as { role: string; active: number; deletedAt: string | null; terminatedAt: string | null } | undefined;
  if (input.db && (!live || live.active !== 1 || live.deletedAt || live.terminatedAt)) {
    reportTokens.delete(input.accessToken);
    throw new Error('REPORT_ACCESS_LOCKED');
  }
  const liveScopes: ReportAccessScope[] = live
    ? live.role === 'OWNER' || live.role === 'FOUNDER' ? ['OPERATIONAL', 'OWNER']
      : live.role === 'SUPERVISOR' ? ['OPERATIONAL'] : []
    : entry.scopes;
  if (live) entry.scopes = liveScopes;
  if (!liveScopes.includes(scope)) {
    throw new Error(scope === 'OWNER'
      ? 'Owner reports require OWNER or FOUNDER'
      : 'Report access is not permitted for this worker');
  }
  return entry;
}

export function touchReportAccess(input: {
  accessToken: string;
  workerId: string;
  deviceId: string;
  now?: number;
  db?: DB;
}): { idleExpiresAt: string } {
  const now = input.now ?? Date.now();
  const entry = requireReportAccess({ ...input, now });
  entry.lastActivityAt = now;
  return { idleExpiresAt: new Date(now + REPORT_IDLE_MS).toISOString() };
}

export function reportAccessStatus(input: {
  accessToken: string;
  workerId: string;
  deviceId: string;
  now?: number;
  db?: DB;
}): { unlocked: boolean; scopes: ReportAccessScope[]; idleExpiresAt: string | null } {
  const now = input.now ?? Date.now();
  const entry = lookup(input.accessToken, now);
  if (!entry || entry.workerId !== input.workerId || entry.deviceId !== input.deviceId) {
    return { unlocked: false, scopes: [], idleExpiresAt: null };
  }
  if (input.db) {
    try { requireReportAccess({ ...input, now, scope: 'OPERATIONAL' }); }
    catch { return { unlocked: false, scopes: [], idleExpiresAt: null }; }
  }
  return {
    unlocked: true,
    scopes: [...entry.scopes],
    idleExpiresAt: new Date(expiry(entry)).toISOString(),
  };
}

export function lockReportAccess(db: DB, input: {
  accessToken: string;
  workerId: string;
  deviceId: string;
  reason: 'MANUAL' | 'LOGOUT' | 'WORKER_CHANGE' | 'IDLE';
}): void {
  const entry = reportTokens.get(input.accessToken);
  if (!entry || entry.workerId !== input.workerId || entry.deviceId !== input.deviceId) return;
  reportTokens.delete(input.accessToken);
  logAudit(db, {
    workerId: input.workerId,
    action: 'REPORT_ACCESS_LOCKED',
    entityType: 'reports',
    entityId: input.accessToken,
    afterValue: { reason: input.reason },
    deviceId: input.deviceId,
  });
}

export function revokeReportAccessForSession(
  db: DB,
  workerId: string,
  deviceId?: string,
  reason: 'LOGOUT' | 'WORKER_CHANGE' = 'LOGOUT',
): void {
  for (const [token, entry] of reportTokens) {
    if (entry.workerId === workerId && (!deviceId || entry.deviceId === deviceId)) {
      lockReportAccess(db, {
        accessToken: token,
        workerId,
        deviceId: entry.deviceId,
        reason,
      });
    }
  }
}

/** Test-only seam: process restart semantics without exporting the map. */
export function _clearReportAccessTokens(): void {
  reportTokens.clear();
}
