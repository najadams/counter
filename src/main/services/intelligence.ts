import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import type {
  IntelligenceBrief, IntelligenceCategory, IntelligenceGetItemResponse,
  IntelligenceHealth, IntelligenceItem, IntelligenceListRequest,
  IntelligenceListResponse, IntelligenceRefreshResponse, IntelligenceScope,
  IntelligenceSeverity, IntelligenceStage, IntelligenceStatus,
  IntelligenceTransitionRequest,
} from '../../shared/types/ipc.js';
import type { CompanyIntelligenceFeedResponse } from '../../shared/sync.js';
import { logAudit } from '../db/audit.js';
import { isLedgerActive, listFinancialAccounts } from './ledger.js';
import { getConcentrationReport, getDebtMaturity, runDownsideScenario } from './managementReports.js';

const SYSTEM_ID = 'sys-system';
const MODEL_VERSION = '1.0.0';
const SENIOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);
const OWNER_ROLES = new Set(['OWNER', 'FOUNDER']);
const ACTIVE_STATUSES: IntelligenceStatus[] = ['OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'SNOOZED'];
const TERMINAL_STATUSES: IntelligenceStatus[] = ['RESOLVED', 'DISMISSED', 'EXPIRED'];

type ModelFamily = 'FOUNDATION' | 'CONTROLS' | 'INVENTORY' | 'CREDIT' | 'PRICING' | 'FINANCE' | 'HQ';

export interface IntelligenceActor {
  workerId: string;
  role: string;
}

export interface IntelligenceCandidate {
  fingerprint: string;
  family: ModelFamily;
  locationId: string;
  scope?: IntelligenceScope;
  sourceShopId?: string | null;
  modelKey: string;
  category: IntelligenceCategory;
  audience: 'SUPERVISOR' | 'OWNER';
  severity: IntelligenceSeverity;
  controlOverride?: boolean;
  title: string;
  recommendation: string;
  cediImpactPesewas?: number | null;
  confidenceBps: number;
  dueAt?: string | null;
  validUntil?: string | null;
  sourceDataThrough: string;
  evidence: Array<{ label: string; value: string; detail?: string | null }>;
  rationale: Record<string, unknown>;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
}

interface IntelligenceRow {
  id: string; fingerprint: string; episode: number; locationId: string;
  scope: IntelligenceScope; sourceShopId: string | null; modelKey: string;
  modelVersion: string; category: IntelligenceCategory; audience: 'SUPERVISOR' | 'OWNER';
  severity: IntelligenceSeverity; status: IntelligenceStatus; controlOverride: number;
  title: string; recommendation: string; cediImpactPesewas: number | null;
  confidenceBps: number; dueAt: string | null; validUntil: string | null;
  sourceDataThrough: string; evidenceJson: string; rationaleJson: string;
  sourceEntityType: string | null; sourceEntityId: string | null;
  assignedTo: string | null; assignedToName: string | null; snoozedUntil: string | null;
  resolutionNote: string | null; dismissalReason: string | null;
  detectedAt: string; lastEvaluatedAt: string; closedAt: string | null;
}

const ITEM_SELECT = `SELECT i.id, i.fingerprint, i.episode,
  i.location_id AS locationId, i.scope, i.source_shop_id AS sourceShopId,
  i.model_key AS modelKey, i.model_version AS modelVersion, i.category,
  i.audience, i.severity, i.status, i.control_override AS controlOverride,
  i.title, i.recommendation, i.cedi_impact_pesewas AS cediImpactPesewas,
  i.confidence_bps AS confidenceBps, i.due_at AS dueAt,
  i.valid_until AS validUntil, i.source_data_through AS sourceDataThrough,
  i.evidence_json AS evidenceJson, i.rationale_json AS rationaleJson,
  i.source_entity_type AS sourceEntityType, i.source_entity_id AS sourceEntityId,
  i.assigned_to AS assignedTo, w.full_name AS assignedToName,
  i.snoozed_until AS snoozedUntil, i.resolution_note AS resolutionNote,
  i.dismissal_reason AS dismissalReason, i.detected_at AS detectedAt,
  i.last_evaluated_at AS lastEvaluatedAt, i.closed_at AS closedAt
 FROM intelligence_items i LEFT JOIN workers w ON w.id = i.assigned_to`;

function jsonArray<T>(value: string): T[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
}
function jsonObject(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function mapItem(row: IntelligenceRow, now = new Date().toISOString()): IntelligenceItem {
  return {
    ...row,
    controlOverride: row.controlOverride === 1,
    evidence: jsonArray(row.evidenceJson),
    rationale: jsonObject(row.rationaleJson),
    overdue: row.dueAt != null && row.dueAt < now && ACTIVE_STATUSES.includes(row.status),
  };
}

function roleFor(db: DB, workerId: string): string {
  const row = db.prepare(`SELECT role, active, deleted_at AS deletedAt, terminated_at AS terminatedAt
    FROM workers WHERE id = ?`).get(workerId) as
    | { role: string; active: number; deletedAt: string | null; terminatedAt: string | null }
    | undefined;
  if (!row || row.active !== 1 || row.deletedAt || row.terminatedAt) throw new Error('Active worker not found');
  return row.role;
}

function requireSenior(db: DB, actor: IntelligenceActor): string {
  const role = roleFor(db, actor.workerId);
  if (role !== actor.role || !SENIOR_ROLES.has(role)) throw new Error('Supervisor, owner, or founder access required');
  return role;
}

export function getIntelligenceStage(db: DB): IntelligenceStage {
  const env = process.env['COUNTER_INTELLIGENCE_STAGE']?.trim().toUpperCase();
  if (env && ['OFF', 'FOUNDATION', 'PREDICTIVE', 'HQ'].includes(env)) return env as IntelligenceStage;
  const row = db.prepare(`SELECT value FROM device_config WHERE key = 'intelligence_stage'`).get() as { value: string } | undefined;
  const value = row?.value?.toUpperCase();
  return value && ['OFF', 'FOUNDATION', 'PREDICTIVE', 'HQ'].includes(value)
    ? value as IntelligenceStage : 'FOUNDATION';
}

function stageAtLeast(stage: IntelligenceStage, minimum: IntelligenceStage): boolean {
  const rank: Record<IntelligenceStage, number> = { OFF: 0, FOUNDATION: 1, PREDICTIVE: 2, HQ: 3 };
  return rank[stage] >= rank[minimum];
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso); d.setUTCDate(d.getUTCDate() + days); return d.toISOString();
}
function dateOnly(iso: string): string { return iso.slice(0, 10); }
function daysBetween(older: string, newer: string): number {
  return Math.floor((new Date(newer).getTime() - new Date(older).getTime()) / 86_400_000);
}
function severityRank(value: IntelligenceSeverity): number {
  return ({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 })[value];
}
export function weightedDemandForecast(zeroFilledNewestFirst: number[]): number {
  const values = Array.from({ length: 84 }, (_unused, index) => zeroFilledNewestFirst[index] ?? 0);
  const avg = (days: number) => values.slice(0, days).reduce((sum, value) => sum + value, 0) / days;
  return 0.5 * avg(7) + 0.3 * avg(28) + 0.2 * avg(84);
}
export function roundCanonicalOrderQuantity(quantity: number, purchaseUnitFactor: number): number {
  const factor = Math.max(1, Math.trunc(purchaseUnitFactor));
  return Math.ceil(Math.max(0, quantity) / factor) * factor;
}
export function collectionPriorityScore(input: {
  overdueDays: number; outstandingToLimitBps: number; brokenPromises: number; daysSinceFollowup: number;
}): number {
  return Math.min(100,
    Math.min(40, Math.max(0, input.overdueDays) / 90 * 40)
      + Math.min(35, Math.max(0, input.outstandingToLimitBps) / 10_000 * 35)
      + Math.min(15, Math.max(0, input.brokenPromises) * 7.5)
      + Math.min(10, Math.max(0, input.daysSinceFollowup) / 30 * 10));
}
export function advisoryPriceFloor(landedCostPesewas: number, targetMarginRatio: number, minimumPricePesewas: number): number {
  const boundedMargin = Math.max(0, Math.min(0.95, targetMarginRatio));
  return Math.max(minimumPricePesewas, Math.ceil(landedCostPesewas / (1 - boundedMargin)));
}
export function compareIntelligencePriority(a: IntelligenceItem, b: IntelligenceItem, now = new Date().toISOString()): number {
  if (a.controlOverride !== b.controlOverride) return a.controlOverride ? -1 : 1;
  if (severityRank(a.severity) !== severityRank(b.severity)) return severityRank(b.severity) - severityRank(a.severity);
  const aOverdue = a.dueAt != null && a.dueAt < now;
  const bOverdue = b.dueAt != null && b.dueAt < now;
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  if ((a.cediImpactPesewas ?? 0) !== (b.cediImpactPesewas ?? 0)) return (b.cediImpactPesewas ?? 0) - (a.cediImpactPesewas ?? 0);
  if ((a.dueAt ?? '9999') !== (b.dueAt ?? '9999')) return (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999');
  if (a.confidenceBps !== b.confidenceBps) return b.confidenceBps - a.confidenceBps;
  return b.detectedAt.localeCompare(a.detectedAt);
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}
function moneyEvidence(pesewas: number): string { return `GHS ${(pesewas / 100).toFixed(2)}`; }

function appendEvent(db: DB, input: {
  itemId: string; eventType: string; actorWorkerId: string; deviceId: string;
  fromStatus?: string | null; toStatus?: string | null; note?: string | null;
}): void {
  db.prepare(`INSERT INTO intelligence_item_events (
    id, item_id, event_type, from_status, to_status, note, actor_worker_id, device_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `iie-${uuidv4()}`, input.itemId, input.eventType, input.fromStatus ?? null,
    input.toStatus ?? null, input.note?.trim() || null, input.actorWorkerId, input.deviceId,
  );
}

function wakeSnoozed(db: DB, deviceId: string, now: string): void {
  const rows = db.prepare(`SELECT id FROM intelligence_items
    WHERE status = 'SNOOZED' AND snoozed_until <= ?`).all(now) as Array<{ id: string }>;
  for (const row of rows) {
    db.prepare(`UPDATE intelligence_items SET status = 'OPEN', snoozed_until = NULL,
      updated_at = ?, updated_by = ?, device_id = ? WHERE id = ?`)
      .run(now, SYSTEM_ID, deviceId, row.id);
    appendEvent(db, { itemId: row.id, eventType: 'REOPENED', actorWorkerId: SYSTEM_ID,
      deviceId, fromStatus: 'SNOOZED', toStatus: 'OPEN', note: 'Snooze period ended.' });
  }
}

function expirePastValidity(db: DB, deviceId: string, now: string): void {
  const rows = db.prepare(`SELECT id, status FROM intelligence_items
    WHERE status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED')
      AND valid_until IS NOT NULL AND valid_until < ?`).all(now) as Array<{ id: string; status: IntelligenceStatus }>;
  for (const row of rows) {
    db.prepare(`UPDATE intelligence_items SET status = 'EXPIRED', condition_cleared_at = ?, closed_at = ?,
      updated_at = ?, updated_by = ?, device_id = ? WHERE id = ?`)
      .run(now, now, now, SYSTEM_ID, deviceId, row.id);
    appendEvent(db, { itemId: row.id, eventType: 'EXPIRED', actorWorkerId: SYSTEM_ID,
      deviceId, fromStatus: row.status, toStatus: 'EXPIRED', note: 'Advice validity window ended before refresh.' });
  }
}

function roleClause(role: string): string {
  return OWNER_ROLES.has(role) ? '' : ` AND i.audience = 'SUPERVISOR'`;
}

const PRIORITY_ORDER = `ORDER BY i.control_override DESC,
  CASE i.severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,
  CASE WHEN i.due_at IS NOT NULL AND i.due_at < ? THEN 1 ELSE 0 END DESC,
  COALESCE(i.cedi_impact_pesewas, 0) DESC,
  COALESCE(i.due_at, '9999-12-31T23:59:59.999Z') ASC,
  i.confidence_bps DESC, i.detected_at DESC`;

export function getIntelligenceBrief(
  db: DB, actor: IntelligenceActor, deviceId: string, locationId = DEFAULT_LOCATION_ID,
  scope?: IntelligenceScope,
): IntelligenceBrief {
  const role = requireSenior(db, actor);
  const now = new Date().toISOString();
  wakeSnoozed(db, deviceId, now);
  expirePastValidity(db, deviceId, now);
  const clause = roleClause(role);
  const scopeClause = scope ? ' AND i.scope = ?' : '';
  const scopeParams: unknown[] = scope ? [scope] : [];
  const rows = db.prepare(`${ITEM_SELECT} WHERE i.location_id = ?
    AND i.status IN ('OPEN','ACKNOWLEDGED','ASSIGNED') ${clause} ${scopeClause}
    ${PRIORITY_ORDER} LIMIT 3`).all(locationId, ...scopeParams, now) as IntelligenceRow[];
  const summary = db.prepare(`SELECT
      COUNT(*) AS openCount,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) AS criticalCount,
      SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) AS highCount,
      COALESCE(SUM(cedi_impact_pesewas), 0) AS totalExposurePesewas,
      MAX(source_data_through) AS sourceDataThrough
    FROM intelligence_items i WHERE location_id = ?
      AND status IN ('OPEN','ACKNOWLEDGED','ASSIGNED') ${clause} ${scopeClause}`)
    .get(locationId, ...scopeParams) as { openCount: number; criticalCount: number; highCount: number; totalExposurePesewas: number; sourceDataThrough: string | null };
  const run = db.prepare(`SELECT completed_at AS completedAt FROM intelligence_runs
    WHERE location_id = ? AND status = 'SUCCESS' ORDER BY completed_at DESC LIMIT 1`)
    .get(locationId) as { completedAt: string | null } | undefined;
  return {
    stage: getIntelligenceStage(db), generatedAt: now, lastRefreshAt: run?.completedAt ?? null,
    sourceDataThrough: summary.sourceDataThrough,
    stale: !run?.completedAt || daysBetween(run.completedAt, now) >= 2,
    criticalCount: summary.criticalCount ?? 0, highCount: summary.highCount ?? 0,
    openCount: summary.openCount ?? 0, totalExposurePesewas: summary.totalExposurePesewas ?? 0,
    items: rows.map((row) => mapItem(row, now)),
  };
}

export function listIntelligenceItems(
  db: DB, actor: IntelligenceActor, deviceId: string, input: IntelligenceListRequest = {},
  locationId = DEFAULT_LOCATION_ID,
): IntelligenceListResponse {
  const role = requireSenior(db, actor);
  const now = new Date().toISOString();
  wakeSnoozed(db, deviceId, now);
  expirePastValidity(db, deviceId, now);
  const where = ['i.location_id = ?'];
  const params: unknown[] = [locationId];
  if (!OWNER_ROLES.has(role)) where.push(`i.audience = 'SUPERVISOR'`);
  if (input.view === 'HISTORY') where.push(`i.status IN ('RESOLVED','DISMISSED','EXPIRED')`);
  else if (input.view === 'WATCHING') where.push(`i.status IN ('ACKNOWLEDGED','ASSIGNED','SNOOZED')`);
  else where.push(`i.status IN ('OPEN','ACKNOWLEDGED','ASSIGNED')`);
  if (input.category) { where.push('i.category = ?'); params.push(input.category); }
  if (input.severity) { where.push('i.severity = ?'); params.push(input.severity); }
  if (input.status) { where.push('i.status = ?'); params.push(input.status); }
  if (input.assignee === 'ME') { where.push('i.assigned_to = ?'); params.push(actor.workerId); }
  else if (input.assignee === 'UNASSIGNED') where.push('i.assigned_to IS NULL');
  else if (input.assignee) { where.push('i.assigned_to = ?'); params.push(input.assignee); }
  if (input.scope) { where.push('i.scope = ?'); params.push(input.scope); }
  if (input.shopId) { where.push('i.source_shop_id = ?'); params.push(input.shopId); }
  const count = db.prepare(`SELECT COUNT(*) AS n FROM intelligence_items i WHERE ${where.join(' AND ')}`)
    .get(...params) as { n: number };
  const rows = db.prepare(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ${PRIORITY_ORDER} LIMIT ?`)
    .all(...params, now, Math.min(Math.max(input.limit ?? 200, 1), 500)) as IntelligenceRow[];
  return { items: rows.map((row) => mapItem(row, now)), total: count.n };
}

export function getIntelligenceItem(
  db: DB, actor: IntelligenceActor, itemId: string, locationId = DEFAULT_LOCATION_ID,
): IntelligenceGetItemResponse {
  const role = requireSenior(db, actor);
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(itemId) as IntelligenceRow | undefined;
  if (!row || row.locationId !== locationId
      || (!OWNER_ROLES.has(role) && row.audience !== 'SUPERVISOR')) throw new Error('Intelligence item not found');
  const events = db.prepare(`SELECT e.id, e.event_type AS eventType, e.from_status AS fromStatus,
      e.to_status AS toStatus, e.note, w.full_name AS actorName, e.occurred_at AS occurredAt
    FROM intelligence_item_events e JOIN workers w ON w.id = e.actor_worker_id
    WHERE e.item_id = ? ORDER BY e.occurred_at, e.rowid`).all(itemId) as IntelligenceGetItemResponse['events'];
  return { item: mapItem(row), events };
}

export function transitionIntelligenceItem(
  db: DB, actor: IntelligenceActor, deviceId: string, input: IntelligenceTransitionRequest,
  locationId = DEFAULT_LOCATION_ID,
): IntelligenceItem {
  const role = requireSenior(db, actor);
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(input.itemId) as IntelligenceRow | undefined;
  if (!row || row.locationId !== locationId
      || (!OWNER_ROLES.has(role) && row.audience !== 'SUPERVISOR')) throw new Error('Intelligence item not found');
  if (TERMINAL_STATUSES.includes(row.status)) throw new Error('This intelligence item is already closed');
  const now = new Date().toISOString();
  let status: IntelligenceStatus;
  let assignedTo = row.assignedTo;
  let snoozedUntil: string | null = null;
  let resolutionNote: string | null = row.resolutionNote;
  let dismissalReason: string | null = row.dismissalReason;
  let eventType: string;
  const note = input.note?.trim() || null;
  switch (input.action) {
    case 'ACKNOWLEDGE': status = 'ACKNOWLEDGED'; eventType = 'ACKNOWLEDGED'; break;
    case 'ASSIGN': {
      if (!input.assignedTo) throw new Error('Pick a worker to assign');
      const assigneeRole = roleFor(db, input.assignedTo);
      if (!SENIOR_ROLES.has(assigneeRole)) throw new Error('Intelligence items can only be assigned to senior workers');
      assignedTo = input.assignedTo; status = 'ASSIGNED'; eventType = 'ASSIGNED'; break;
    }
    case 'SNOOZE': {
      if (![1, 3, 7].includes(input.snoozeDays ?? 0)) throw new Error('Snooze must be 1, 3, or 7 days');
      status = 'SNOOZED'; eventType = 'SNOOZED'; snoozedUntil = addDays(now, input.snoozeDays!); break;
    }
    case 'DISMISS': {
      if (!note || note.length < 3) throw new Error('Dismissal reason must be at least 3 characters');
      status = 'DISMISSED'; eventType = 'DISMISSED'; dismissalReason = note; break;
    }
    case 'RESOLVE': {
      if (!note || note.length < 3) throw new Error('Resolution note must be at least 3 characters');
      status = 'RESOLVED'; eventType = 'RESOLVED'; resolutionNote = note; break;
    }
  }
  db.transaction(() => {
    db.prepare(`UPDATE intelligence_items SET status = ?, assigned_to = ?, snoozed_until = ?,
      resolution_note = ?, dismissal_reason = ?, closed_at = ?, updated_at = ?, updated_by = ?, device_id = ?
      WHERE id = ?`).run(status, assignedTo, snoozedUntil, resolutionNote, dismissalReason,
        TERMINAL_STATUSES.includes(status) ? now : null, now, actor.workerId, deviceId, row.id);
    appendEvent(db, { itemId: row.id, eventType, actorWorkerId: actor.workerId, deviceId,
      fromStatus: row.status, toStatus: status, note });
    logAudit(db, { workerId: actor.workerId, action: `INTELLIGENCE_${eventType}`,
      entityType: 'intelligence_items', entityId: row.id,
      beforeValue: { status: row.status, assignedTo: row.assignedTo },
      afterValue: { status, assignedTo, snoozedUntil, note }, deviceId });
  })();
  return getIntelligenceItem(db, actor, row.id).item;
}

export function getIntelligenceHealth(db: DB, actor: IntelligenceActor): IntelligenceHealth {
  requireSenior(db, actor);
  const success = db.prepare(`SELECT completed_at AS at FROM intelligence_runs WHERE status = 'SUCCESS'
    ORDER BY completed_at DESC LIMIT 1`).get() as { at: string | null } | undefined;
  const failed = db.prepare(`SELECT completed_at AS at, error FROM intelligence_runs WHERE status = 'FAILED'
    ORDER BY completed_at DESC LIMIT 1`).get() as { at: string | null; error: string | null } | undefined;
  const running = !!db.prepare(`SELECT 1 FROM intelligence_runs WHERE status = 'RUNNING'
    AND started_at >= datetime('now','-10 minutes') LIMIT 1`).get();
  return { stage: getIntelligenceStage(db), lastSuccessfulRunAt: success?.at ?? null,
    lastFailedRunAt: failed?.at ?? null, lastError: failed?.error ?? null, running };
}

function controlCandidates(db: DB, locationId: string, now: string): IntelligenceCandidate[] {
  const out: IntelligenceCandidate[] = [];
  const variance = db.prepare(`SELECT vc.id, vc.case_type AS caseType, vc.severity, vc.title,
      vc.amount_pesewas AS amount, vc.expected_pesewas AS expected,
      vc.observed_pesewas AS observed, vc.due_at AS dueAt, vc.detected_at AS detectedAt,
      w.full_name AS subjectName
    FROM variance_cases vc LEFT JOIN workers w ON w.id = vc.subject_worker_id
    WHERE vc.location_id = ? AND vc.status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE')`)
    .all(locationId) as Array<{ id: string; caseType: string; severity: string; title: string; amount: number; expected: number | null; observed: number | null; dueAt: string; detectedAt: string; subjectName: string | null }>;
  for (const row of variance) out.push({
    fingerprint: `variance:${row.id}`, family: 'CONTROLS', locationId, modelKey: 'variance-case',
    category: 'CONTROL', audience: 'SUPERVISOR', severity: row.severity === 'DANGER' ? 'CRITICAL' : 'HIGH',
    controlOverride: true, title: row.subjectName ? `${row.title} — ${row.subjectName}` : row.title,
    recommendation: 'Review the linked variance case, gather evidence, record the cause, and resolve the difference.',
    cediImpactPesewas: Math.abs(row.amount), confidenceBps: 10000, dueAt: row.dueAt,
    sourceDataThrough: row.detectedAt,
    evidence: [
      { label: 'Difference', value: moneyEvidence(row.amount) },
      ...(row.expected == null ? [] : [{ label: 'Expected', value: moneyEvidence(row.expected) }]),
      ...(row.observed == null ? [] : [{ label: 'Observed', value: moneyEvidence(row.observed) }]),
    ],
    rationale: { exactReconciliationDifference: true, caseType: row.caseType },
    sourceEntityType: 'variance_cases', sourceEntityId: row.id,
  });

  const pendingVoids = db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(s.total_pesewas), 0) AS exposure, MIN(vr.requested_at) AS oldestAt
    FROM sale_void_requests vr JOIN sales s ON s.id = vr.sale_id
    WHERE vr.location_id = ? AND vr.status = 'PENDING'`).get(locationId) as
    { count: number; exposure: number; oldestAt: string | null };
  if (pendingVoids.count > 0 && pendingVoids.oldestAt) out.push({
    fingerprint: 'pending-void-approvals', family: 'CONTROLS', locationId,
    modelKey: 'pending-void-approvals', category: 'CONTROL', audience: 'SUPERVISOR',
    severity: pendingVoids.count >= 5 ? 'HIGH' : 'MEDIUM', controlOverride: true,
    title: `${pendingVoids.count} sale void request${pendingVoids.count === 1 ? '' : 's'} need review`,
    recommendation: 'Review each request against its original receipt and recorded reason. Approval remains a separate deliberate action.',
    cediImpactPesewas: pendingVoids.exposure, confidenceBps: 10000,
    dueAt: addDays(pendingVoids.oldestAt, 1), sourceDataThrough: pendingVoids.oldestAt,
    evidence: [{ label: 'Pending requests', value: String(pendingVoids.count) }, { label: 'Sales value under review', value: moneyEvidence(pendingVoids.exposure) }],
    rationale: { exactPendingCount: true }, sourceEntityType: 'sale_void_requests', sourceEntityId: null,
  });

  const pendingReceipts = db.prepare(`SELECT COUNT(DISTINCT rr.id) AS count,
      COALESCE(SUM(lines.value), 0) + COALESCE(SUM(rr.transport_cost_pesewas), 0)
        + COALESCE(SUM(rr.loading_cost_pesewas), 0) AS exposure,
      MIN(rr.requested_at) AS oldestAt
    FROM stock_receipt_requests rr LEFT JOIN (
      SELECT request_id, SUM(quantity * unit_cost_pesewas) AS value
      FROM stock_receipt_request_lines GROUP BY request_id
    ) lines ON lines.request_id = rr.id
    WHERE rr.location_id = ? AND rr.status = 'PENDING'`).get(locationId) as
    { count: number; exposure: number; oldestAt: string | null };
  if (pendingReceipts.count > 0 && pendingReceipts.oldestAt) out.push({
    fingerprint: 'pending-stock-receipt-approvals', family: 'CONTROLS', locationId,
    modelKey: 'pending-stock-receipt-approvals', category: 'CONTROL', audience: 'SUPERVISOR',
    severity: pendingReceipts.count >= 5 ? 'HIGH' : 'MEDIUM', controlOverride: true,
    title: `${pendingReceipts.count} stock receipt request${pendingReceipts.count === 1 ? '' : 's'} need review`,
    recommendation: 'Review quantities, costs, supplier evidence, and any cost swing. Approval remains a separate deliberate action.',
    cediImpactPesewas: Math.max(0, pendingReceipts.exposure), confidenceBps: 10000,
    dueAt: addDays(pendingReceipts.oldestAt, 1), sourceDataThrough: pendingReceipts.oldestAt,
    evidence: [{ label: 'Pending requests', value: String(pendingReceipts.count) }, { label: 'Stock value awaiting review', value: moneyEvidence(pendingReceipts.exposure) }],
    rationale: { exactPendingCount: true }, sourceEntityType: 'stock_receipt_requests', sourceEntityId: null,
  });

  const negative = db.prepare(`SELECT p.id, p.sku, p.name,
      SUM(sm.quantity) AS onHand, -SUM(sm.quantity) * p.cost_price_pesewas AS impact
    FROM products p JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
    WHERE p.active = 1 AND p.deleted_at IS NULL GROUP BY p.id HAVING SUM(sm.quantity) < 0`)
    .all(locationId) as Array<{ id: string; sku: string; name: string; onHand: number; impact: number }>;
  for (const row of negative) out.push({
    fingerprint: `negative-stock:${row.id}`, family: 'CONTROLS', locationId, modelKey: 'negative-stock',
    category: 'CONTROL', audience: 'SUPERVISOR', severity: row.impact >= 10_000 ? 'CRITICAL' : 'HIGH',
    controlOverride: true, title: `${row.name} has negative recorded stock`,
    recommendation: 'Review recent receipts and sales, then perform a physical count. This is a record mismatch, not proof of wrongdoing.',
    cediImpactPesewas: row.impact, confidenceBps: 10000, dueAt: addDays(now, 1), sourceDataThrough: now,
    evidence: [{ label: 'SKU', value: row.sku }, { label: 'On hand', value: String(row.onHand) }, { label: 'Value at cost', value: moneyEvidence(row.impact) }],
    rationale: { exactLedgerBalance: true }, sourceEntityType: 'products', sourceEntityId: row.id,
  });

  const underpriced = db.prepare(`SELECT p.id AS productId, p.name, p.sku,
      COUNT(*) AS lineCount,
      SUM((sl.list_price_pesewas - sl.unit_price_pesewas) * sl.quantity) AS impact,
      MAX(s.created_at) AS lastAt
    FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN products p ON p.id = sl.product_id
    WHERE s.location_id = ? AND s.voided = 0 AND s.supersedes_sale_id IS NULL
      AND sl.list_price_pesewas IS NOT NULL AND sl.unit_price_pesewas < sl.list_price_pesewas
      AND s.created_at >= datetime(?, '-28 days') GROUP BY p.id`)
    .all(locationId, now) as Array<{ productId: string; name: string; sku: string; lineCount: number; impact: number; lastAt: string }>;
  for (const row of underpriced) out.push({
    fingerprint: `underpriced:${row.productId}`, family: 'CONTROLS', locationId, modelKey: 'underpriced-lines',
    category: 'CONTROL', audience: 'OWNER', severity: row.impact >= 10_000 ? 'CRITICAL' : 'HIGH',
    controlOverride: true, title: `${row.name} was rung below its recorded list price`,
    recommendation: 'Review the affected receipts and confirm whether the catalog price floor was bypassed or the product price was stale.',
    cediImpactPesewas: row.impact, confidenceBps: 10000, dueAt: addDays(now, 1), sourceDataThrough: row.lastAt,
    evidence: [{ label: 'SKU', value: row.sku }, { label: 'Affected lines', value: String(row.lineCount) }, { label: 'Revenue shortfall', value: moneyEvidence(row.impact) }],
    rationale: { exactPriceSnapshotDifference: true }, sourceEntityType: 'products', sourceEntityId: row.productId,
  });

  const repeatedVoids = db.prepare(`WITH affected AS (
      SELECT DISTINCT s.id AS saleId, date(s.voided_at) AS businessDate,
        s.voided_by AS workerId, s.total_pesewas AS saleTotal, s.voided_at AS voidedAt,
        p.id AS productId, p.name AS productName
      FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id JOIN products p ON p.id = sl.product_id
      WHERE s.location_id = ? AND s.voided = 1 AND s.voided_at >= datetime(?, '-28 days')
    ) SELECT a.businessDate, a.workerId, w.full_name AS workerName, a.productId,
      a.productName, COUNT(*) AS voidCount, SUM(a.saleTotal) AS impact, MAX(a.voidedAt) AS lastAt
    FROM affected a JOIN workers w ON w.id = a.workerId
    GROUP BY a.businessDate, a.workerId, a.productId HAVING COUNT(*) >= 3`)
    .all(locationId, now) as Array<{ businessDate: string; workerId: string; workerName: string; productId: string; productName: string; voidCount: number; impact: number; lastAt: string }>;
  for (const row of repeatedVoids) out.push({
    fingerprint: `repeat-void:${row.businessDate}:${row.workerId}:${row.productId}`,
    family: 'CONTROLS', locationId, modelKey: 'repeated-sku-voids', category: 'CONTROL',
    audience: 'SUPERVISOR', severity: row.voidCount >= 5 || row.impact >= 10_000 ? 'CRITICAL' : 'HIGH',
    controlOverride: true, title: `Unusual repeated void pattern requires review`,
    recommendation: `Review ${row.workerName}'s affected receipts and ask for the operational reason. Treat this as a pattern to explain, not proof of misconduct.`,
    cediImpactPesewas: Math.max(0, row.impact), confidenceBps: 9800, dueAt: addDays(now, 1), sourceDataThrough: row.lastAt,
    evidence: [{ label: 'Worker', value: row.workerName }, { label: 'Product', value: row.productName }, { label: 'Same-day voids', value: String(row.voidCount) }, { label: 'Voided value', value: moneyEvidence(row.impact) }],
    rationale: { threshold: 3, normalizedClaim: false }, sourceEntityType: 'workers', sourceEntityId: row.workerId,
  });

  const repeatedShortages = db.prepare(`SELECT vc.subject_worker_id AS workerId,
      w.full_name AS workerName, COUNT(*) AS shortageCount,
      SUM(ABS(vc.amount_pesewas)) AS impact, MAX(vc.detected_at) AS lastAt
    FROM variance_cases vc JOIN workers w ON w.id = vc.subject_worker_id
    WHERE vc.location_id = ? AND vc.case_type = 'TILL_CASH'
      AND vc.amount_pesewas < 0 AND vc.detected_at >= datetime(?, '-28 days')
    GROUP BY vc.subject_worker_id HAVING COUNT(*) >= 3`)
    .all(locationId, now) as Array<{ workerId: string; workerName: string; shortageCount: number; impact: number; lastAt: string }>;
  for (const row of repeatedShortages) out.push({
    fingerprint: `repeated-till-shortage:${row.workerId}`, family: 'CONTROLS', locationId,
    modelKey: 'repeated-till-shortages', category: 'CONTROL', audience: 'SUPERVISOR',
    severity: row.shortageCount >= 5 || row.impact >= 10_000 ? 'CRITICAL' : 'HIGH', controlOverride: true,
    title: 'Repeated till shortage pattern requires review',
    recommendation: `Review ${row.workerName}'s shift counts and recorded explanations. The pattern is not a finding of guilt.`,
    cediImpactPesewas: row.impact, confidenceBps: 10000, dueAt: addDays(now, 1), sourceDataThrough: row.lastAt,
    evidence: [{ label: 'Worker', value: row.workerName }, { label: 'Short shifts', value: String(row.shortageCount) }, { label: 'Total shortage', value: moneyEvidence(row.impact) }],
    rationale: { exactCaseCount: true, windowDays: 28, tripwire: 3 }, sourceEntityType: 'workers', sourceEntityId: row.workerId,
  });

  const discounts = db.prepare(`SELECT s.worker_id AS workerId, w.full_name AS workerName,
      COUNT(*) AS saleCount, SUM(s.discount_pesewas) AS impact, MAX(s.created_at) AS lastAt
    FROM sales s JOIN workers w ON w.id = s.worker_id
    WHERE s.location_id = ? AND s.voided = 0 AND s.discount_pesewas > 0
      AND s.created_at >= datetime(?, '-28 days')
    GROUP BY s.worker_id HAVING COUNT(*) >= 3 AND SUM(s.discount_pesewas) >= 5000`)
    .all(locationId, now) as Array<{ workerId: string; workerName: string; saleCount: number; impact: number; lastAt: string }>;
  for (const row of discounts) out.push({
    fingerprint: `material-discounts:${row.workerId}`, family: 'CONTROLS', locationId,
    modelKey: 'material-discounts', category: 'CONTROL', audience: 'SUPERVISOR',
    severity: row.impact >= 20_000 ? 'HIGH' : 'MEDIUM', controlOverride: true,
    title: 'Material discount pattern requires review',
    recommendation: `Review a sample of ${row.workerName}'s discounted receipts and confirm the recorded reasons and approvals.`,
    cediImpactPesewas: row.impact, confidenceBps: 10000, dueAt: addDays(now, 2), sourceDataThrough: row.lastAt,
    evidence: [{ label: 'Worker', value: row.workerName }, { label: 'Discounted sales', value: String(row.saleCount) }, { label: 'Discount value', value: moneyEvidence(row.impact) }],
    rationale: { exactDiscountTotal: true, minimumSales: 3, materialityPesewas: 5000, windowDays: 28 },
    sourceEntityType: 'workers', sourceEntityId: row.workerId,
  });

  const corrections = db.prepare(`SELECT replacement.worker_id AS workerId,
      w.full_name AS workerName, COUNT(*) AS correctionCount,
      SUM(ABS(replacement.total_pesewas - original.total_pesewas)) AS impact,
      MAX(replacement.created_at) AS lastAt
    FROM sales replacement JOIN sales original ON original.id = replacement.supersedes_sale_id
      JOIN workers w ON w.id = replacement.worker_id
    WHERE replacement.location_id = ? AND replacement.created_at >= datetime(?, '-28 days')
    GROUP BY replacement.worker_id HAVING COUNT(*) >= 3`)
    .all(locationId, now) as Array<{ workerId: string; workerName: string; correctionCount: number; impact: number; lastAt: string }>;
  for (const row of corrections) out.push({
    fingerprint: `post-sale-edits:${row.workerId}`, family: 'CONTROLS', locationId,
    modelKey: 'post-sale-corrections', category: 'CONTROL', audience: 'SUPERVISOR',
    severity: row.correctionCount >= 5 || row.impact >= 10_000 ? 'HIGH' : 'MEDIUM', controlOverride: true,
    title: 'Unusual post-sale correction pattern requires review',
    recommendation: `Review ${row.workerName}'s corrected receipts and confirm the operational reasons. Corrections remain linked to their originals.`,
    cediImpactPesewas: row.impact, confidenceBps: 10000, dueAt: addDays(now, 2), sourceDataThrough: row.lastAt,
    evidence: [{ label: 'Worker', value: row.workerName }, { label: 'Corrections', value: String(row.correctionCount) }, { label: 'Absolute value changed', value: moneyEvidence(row.impact) }],
    rationale: { exactLinkedCorrections: true, tripwire: 3, windowDays: 28 },
    sourceEntityType: 'workers', sourceEntityId: row.workerId,
  });

  for (const account of listFinancialAccounts(db, locationId)) {
    const allowedDays = account.kind === 'TILL' ? 1 : 7;
    const ageDays = account.lastReconciledAt ? daysBetween(account.lastReconciledAt, now) : null;
    if ((ageDays ?? allowedDays + 1) <= allowedDays || Math.abs(account.balancePesewas) < 1000) continue;
    out.push({
      fingerprint: `stale-reconciliation:${account.id}`, family: 'CONTROLS', locationId,
      modelKey: 'stale-financial-reconciliation', category: 'CONTROL', audience: 'SUPERVISOR',
      severity: account.kind === 'TILL' && (ageDays == null || ageDays >= 3) ? 'HIGH' : 'MEDIUM', controlOverride: true,
      title: `${account.name} reconciliation is stale`,
      recommendation: 'Reconcile the recorded account against the physical till or provider statement before relying on its balance.',
      cediImpactPesewas: Math.abs(account.balancePesewas), confidenceBps: 10000, dueAt: now, sourceDataThrough: account.lastReconciledAt ?? now,
      evidence: [{ label: 'Account', value: account.name }, { label: 'Recorded balance', value: moneyEvidence(account.balancePesewas) }, { label: 'Last reconciled', value: account.lastReconciledAt ?? 'Never' }, { label: 'Expected frequency', value: `${allowedDays} day(s)` }],
      rationale: { exactReconciliationAge: true, allowedDays, ageDays }, sourceEntityType: 'financial_accounts', sourceEntityId: account.id,
    });
  }
  return out;
}

function normalizedWorkerCandidates(db: DB, locationId: string, now: string): IntelligenceCandidate[] {
  const queryWindow = (fromDays: number, toDays: number) => db.prepare(`SELECT w.id AS workerId, w.full_name AS workerName,
      COUNT(DISTINCT s.id) AS attempts,
      COUNT(DISTINCT CASE WHEN s.voided = 1 THEN s.id END) AS voids,
      COUNT(DISTINCT CASE WHEN sh.closed_at IS NOT NULL THEN s.shift_id END) AS shifts,
      COALESCE(SUM(CASE WHEN s.voided = 0 THEN s.total_pesewas ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN s.voided = 0 THEN s.discount_pesewas ELSE 0 END), 0) AS discounts
    FROM workers w JOIN sales s ON s.worker_id = w.id JOIN shifts sh ON sh.id = s.shift_id
    WHERE s.location_id = ? AND s.created_at >= datetime(?, ?)
      AND s.created_at < datetime(?, ?)
      AND w.role = 'COUNTER' GROUP BY w.id HAVING attempts >= 30 AND shifts >= 3`)
    .all(locationId, now, `-${fromDays} days`, now, `-${toDays} days`) as Array<{ workerId: string; workerName: string; attempts: number; voids: number; shifts: number; revenue: number; discounts: number }>;
  const rows = queryWindow(28, 0);
  const priorByWorker = new Map(queryWindow(56, 28).map((row) => [row.workerId, row]));
  const out: IntelligenceCandidate[] = [];
  for (const row of rows) {
    const rate = Math.round(row.voids * 10_000 / Math.max(1, row.attempts));
    const peers = rows.filter((peer) => peer.workerId !== row.workerId);
    const peerRates = peers.map((peer) => Math.round(peer.voids * 10_000 / Math.max(1, peer.attempts)));
    const prior = priorByWorker.get(row.workerId);
    const usingPeers = peers.length >= 3;
    if (!usingPeers && !prior) continue;
    const baselineRates = usingPeers ? peerRates : [Math.round(prior!.voids * 10_000 / Math.max(1, prior!.attempts))];
    const med = median(baselineRates);
    const mad = usingPeers ? median(baselineRates.map((value) => Math.abs(value - med))) : 0;
    const threshold = usingPeers
      ? Math.max(med * 2, med + 3 * Math.max(1, mad), 300)
      : Math.max(med * 2, med + 300, 300);
    if (row.voids < 3 || rate <= threshold) continue;
    out.push({
      fingerprint: `worker-void-rate:${row.workerId}`, family: 'CONTROLS', locationId,
      modelKey: 'normalized-worker-void-rate', category: 'CONTROL', audience: 'SUPERVISOR',
      severity: rate >= threshold * 1.5 ? 'HIGH' : 'MEDIUM', controlOverride: true,
      title: `Unusual void rate requires review`,
      recommendation: `Review a sample of ${row.workerName}'s voided receipts and compare explanations with shift records.`,
      cediImpactPesewas: null, confidenceBps: usingPeers ? Math.min(9500, 7500 + peers.length * 400) : 6000, dueAt: addDays(now, 2), sourceDataThrough: now,
      evidence: [{ label: 'Worker', value: row.workerName }, { label: 'Void rate', value: `${(rate / 100).toFixed(1)}%` }, { label: usingPeers ? 'Peer median' : 'Preceding 28-day rate', value: `${(med / 100).toFixed(1)}%` }, { label: 'Transactions', value: String(row.attempts) }, { label: 'Closed shifts', value: String(row.shifts) }],
      rationale: { windowDays: 28, comparisonBasis: usingPeers ? 'three-or-more qualifying peers' : 'worker preceding 28 days', peerCount: peers.length, medianBps: med, madBps: mad, thresholdBps: threshold },
      sourceEntityType: 'workers', sourceEntityId: row.workerId,
    });
  }
  return out;
}

function inventoryCandidates(db: DB, locationId: string, now: string): IntelligenceCandidate[] {
  const products = db.prepare(`SELECT p.id, p.sku, p.name, p.cost_price_pesewas AS cost,
      p.walk_in_price_pesewas AS price, p.reorder_threshold AS reorderThreshold,
      p.default_lead_time_days AS defaultLeadDays,
      p.created_at AS createdAt,
      COALESCE(pu.conversion_factor, 1) AS purchaseFactor,
      COALESCE(SUM(sm.quantity), 0) AS onHand
    FROM products p
    LEFT JOIN product_units pu ON pu.id = p.primary_purchase_unit_id
    LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
    WHERE p.active = 1 AND p.deleted_at IS NULL GROUP BY p.id`)
    .all(locationId) as Array<{ id: string; sku: string; name: string; cost: number; price: number; reorderThreshold: number; defaultLeadDays: number; createdAt: string; purchaseFactor: number; onHand: number }>;
  const demandRows = db.prepare(`SELECT product_id AS productId, date(created_at) AS day,
      -SUM(quantity) AS units FROM stock_movements
    WHERE location_id = ? AND reason_code IN ('SALE_WALK_IN','SALE_ROUTE','SALE_CREDIT')
      AND created_at >= datetime(?, '-84 days') GROUP BY product_id, date(created_at)`)
    .all(locationId, now) as Array<{ productId: string; day: string; units: number }>;
  const byProduct = new Map<string, Map<string, number>>();
  for (const row of demandRows) {
    if (!byProduct.has(row.productId)) byProduct.set(row.productId, new Map());
    byProduct.get(row.productId)!.set(row.day, row.units);
  }
  const leadRows = db.prepare(`SELECT pol.product_id AS productId,
      CAST(julianday(po.received_at) - julianday(po.ordered_at) AS INTEGER) AS days
    FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
    WHERE po.location_id = ? AND po.ordered_at IS NOT NULL AND po.received_at IS NOT NULL
      AND po.received_at >= datetime(?, '-365 days') ORDER BY po.received_at DESC`)
    .all(locationId, now) as Array<{ productId: string; days: number }>;
  const leads = new Map<string, number[]>();
  for (const row of leadRows) {
    const list = leads.get(row.productId) ?? [];
    if (list.length < 6 && row.days >= 0) list.push(row.days);
    leads.set(row.productId, list);
  }
  const today = new Date(`${dateOnly(now)}T00:00:00.000Z`);
  const dayKey = (ago: number) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - ago); return dateOnly(d.toISOString()); };
  const out: IntelligenceCandidate[] = [];
  for (const p of products) {
    const map = byProduct.get(p.id) ?? new Map<string, number>();
    const values = Array.from({ length: 84 }, (_, index) => map.get(dayKey(index)) ?? 0);
    const historyDays = Math.max(0, Math.min(84, daysBetween(p.createdAt, now) + 1));
    const weighted = historyDays >= 14 ? weightedDemandForecast(values) : 0;
    const dayOfWeekFactors = Array<number>(7).fill(1);
    if (historyDays >= 56 && weighted > 0) {
      const overall = values.slice(0, 56).reduce((sum, value) => sum + value, 0) / 56;
      for (let dow = 0; dow < 7; dow++) {
        const dowValues = values.slice(0, 56).filter((_value, index) => {
          const date = new Date(today); date.setUTCDate(date.getUTCDate() - index);
          return date.getUTCDay() === dow;
        });
        const dowAverage = dowValues.reduce((sum, value) => sum + value, 0) / Math.max(1, dowValues.length);
        dayOfWeekFactors[dow] = overall > 0 ? Math.max(0.25, Math.min(2.5, dowAverage / overall)) : 1;
      }
    }
    const leadDays = Math.max(1, Math.round(median(leads.get(p.id) ?? []) || p.defaultLeadDays || 7));
    const forecastDemand = (days: number): number => Array.from({ length: days }, (_unused, index) => {
      const future = new Date(today); future.setUTCDate(future.getUTCDate() + index + 1);
      return weighted * dayOfWeekFactors[future.getUTCDay()]!;
    }).reduce((sum, value) => sum + value, 0);
    const deviation = standardDeviation(values.slice(0, Math.min(historyDays >= 56 ? 56 : 28, Math.max(1, historyDays))));
    const safetyStock = 1.65 * deviation * Math.sqrt(leadDays);
    const leadDemand = forecastDemand(leadDays);
    const reorderPoint = Math.ceil(leadDemand + safetyStock);
    const threshold = historyDays >= 14 ? reorderPoint : p.reorderThreshold;
    const margin = Math.max(0, p.price - p.cost);
    const confidence = historyDays >= 56 ? 9000 : historyDays >= 28 ? 7800 : historyDays >= 14 ? 6500 : 4000;
    if (p.onHand <= threshold && threshold > 0) {
      const target = Math.ceil(forecastDemand(leadDays + 7) + safetyStock);
      const rawQty = Math.max(1, target - p.onHand);
      const factor = Math.max(1, p.purchaseFactor);
      const suggested = roundCanonicalOrderQuantity(rawQty, factor);
      let accumulated = 0; let stockoutDays: number | null = null;
      if (weighted > 0) for (let day = 1; day <= 180; day++) {
        accumulated = forecastDemand(day);
        if (accumulated >= p.onHand) { stockoutDays = day; break; }
      }
      const stockoutAt = stockoutDays == null ? null : addDays(now, stockoutDays);
      const forecastPerDay = leadDays > 0 ? leadDemand / leadDays : weighted;
      const impact = Math.round(Math.max(0, forecastDemand(7) - p.onHand) * margin);
      out.push({
        fingerprint: `inventory-low:${p.id}`, family: 'INVENTORY', locationId, modelKey: 'demand-stockout',
        category: 'INVENTORY', audience: 'SUPERVISOR',
        severity: p.onHand <= 0 || (stockoutDays != null && stockoutDays <= leadDays) ? 'HIGH' : 'MEDIUM',
        title: `${p.name} may run out before replenishment`,
        recommendation: `Consider ordering ${suggested} canonical units (${suggested / factor} primary purchase unit(s)) after checking the supplier and shelf.`,
        cediImpactPesewas: impact, confidenceBps: confidence, dueAt: stockoutAt ?? addDays(now, 2),
        sourceDataThrough: now,
        evidence: [{ label: 'On hand', value: String(p.onHand) }, { label: 'Forecast/day', value: forecastPerDay.toFixed(1) }, { label: 'Lead time', value: `${leadDays} days` }, { label: 'Reorder point', value: String(threshold) }, ...(stockoutAt ? [{ label: 'Estimated stockout', value: dateOnly(stockoutAt) }] : [])],
        rationale: { weightedWindows: { days7: 0.5, days28: 0.3, days84: 0.2 }, historyDays, dayOfWeekAdjusted: historyDays >= 56, safetyZ: 1.65, fallbackThreshold: historyDays < 14 },
        sourceEntityType: 'products', sourceEntityId: p.id,
      });
    } else if (weighted > 0 && p.onHand / weighted > 60 && p.onHand * p.cost >= 5_000) {
      const cover = Math.round(p.onHand / weighted);
      out.push({
        fingerprint: `inventory-excess:${p.id}`, family: 'INVENTORY', locationId, modelKey: 'excess-stock',
        category: 'INVENTORY', audience: 'OWNER', severity: cover > 120 ? 'MEDIUM' : 'LOW',
        title: `${p.name} is tying up cash`,
        recommendation: 'Review future orders and consider a controlled promotion or supplier discussion before buying more.',
        cediImpactPesewas: p.onHand * p.cost, confidenceBps: confidence, sourceDataThrough: now,
        evidence: [{ label: 'Days of supply', value: `${cover} days` }, { label: 'Stock at cost', value: moneyEvidence(p.onHand * p.cost) }],
        rationale: { excessCoverThresholdDays: 60, forecastDailyUnits: weighted, dayOfWeekAdjusted: historyDays >= 56 },
        sourceEntityType: 'products', sourceEntityId: p.id,
      });
    }
  }
  return out;
}

function creditCandidates(db: DB, locationId: string, now: string): IntelligenceCandidate[] {
  const rows = db.prepare(`SELECT c.id, c.display_name AS name, c.current_balance_pesewas AS balance,
      c.credit_limit_pesewas AS creditLimit,
      MIN(CASE WHEN s.is_credit = 1 AND s.voided = 0 THEN s.credit_due_date END) AS oldestDue,
      (SELECT COUNT(*) FROM customer_payment_promises cpp WHERE cpp.customer_id = c.id AND cpp.status = 'BROKEN') AS brokenPromises,
      (SELECT MAX(created_at) FROM customer_debt_followups f WHERE f.customer_id = c.id) AS lastFollowup,
      COUNT(DISTINCT CASE WHEN s.voided = 0 THEN s.id END) AS purchaseCount,
      MIN(CASE WHEN s.voided = 0 THEN s.created_at END) AS firstPurchase,
      MAX(CASE WHEN s.voided = 0 THEN s.created_at END) AS lastPurchase,
      COALESCE(SUM(CASE WHEN s.voided = 0 THEN s.total_pesewas ELSE 0 END), 0) AS lifetimeValue
    FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
    WHERE c.deleted_at IS NULL GROUP BY c.id`)
    .all() as Array<{ id: string; name: string; balance: number; creditLimit: number; oldestDue: string | null; brokenPromises: number; lastFollowup: string | null; purchaseCount: number; firstPurchase: string | null; lastPurchase: string | null; lifetimeValue: number }>;
  const grandValue = rows.reduce((sum, row) => sum + row.lifetimeValue, 0);
  let cumulative = 0;
  const ranked = [...rows].sort((a, b) => b.lifetimeValue - a.lifetimeValue);
  const out: IntelligenceCandidate[] = [];
  for (const row of rows) {
    if (row.balance > 0) {
      const overdueDays = row.oldestDue ? Math.max(0, daysBetween(`${row.oldestDue}T00:00:00.000Z`, now)) : 0;
      const ratioBps = row.creditLimit > 0 ? Math.min(20_000, Math.round(row.balance * 10_000 / row.creditLimit)) : 10_000;
      const sinceFollowup = row.lastFollowup ? Math.max(0, daysBetween(row.lastFollowup, now)) : 30;
      const score = collectionPriorityScore({ overdueDays, outstandingToLimitBps: ratioBps,
        brokenPromises: row.brokenPromises, daysSinceFollowup: sinceFollowup });
      if (overdueDays > 0 || ratioBps >= 10_000 || row.brokenPromises > 0) out.push({
        fingerprint: `credit-collection:${row.id}`, family: 'CREDIT', locationId, modelKey: 'collection-priority',
        category: 'CREDIT', audience: 'SUPERVISOR', severity: score >= 70 ? 'HIGH' : score >= 45 ? 'MEDIUM' : 'LOW',
        title: `${row.name} needs a credit follow-up`,
        recommendation: 'Review the customer statement and follow-up history, then contact the customer and record the outcome.',
        cediImpactPesewas: row.balance, confidenceBps: row.oldestDue ? 9000 : 6500,
        dueAt: overdueDays > 0 ? now : addDays(now, 3), sourceDataThrough: now,
        evidence: [{ label: 'Outstanding', value: moneyEvidence(row.balance) }, { label: 'Days overdue', value: String(overdueDays) }, { label: 'Limit used', value: `${(ratioBps / 100).toFixed(0)}%` }, { label: 'Broken promises', value: String(row.brokenPromises) }],
        rationale: { score: Math.round(score), weights: { overdueAge: 40, limitRatio: 35, brokenPromises: 15, followupAge: 10 } },
        sourceEntityType: 'customers', sourceEntityId: row.id,
      });
      if (ratioBps >= 11_000 || row.brokenPromises >= 2) out.push({
        fingerprint: `credit-policy-review:${row.id}`, family: 'CREDIT', locationId,
        modelKey: 'credit-policy-review', category: 'CREDIT', audience: 'OWNER',
        severity: ratioBps >= 15_000 || row.brokenPromises >= 3 ? 'HIGH' : 'MEDIUM',
        title: `${row.name}'s credit terms require review`,
        recommendation: 'Review the customer history, limit, and payment terms before extending more credit. Counter will not change the limit or block the customer automatically.',
        cediImpactPesewas: row.balance, confidenceBps: 8500, dueAt: addDays(now, 2), sourceDataThrough: now,
        evidence: [{ label: 'Outstanding', value: moneyEvidence(row.balance) }, { label: 'Limit used', value: `${(ratioBps / 100).toFixed(0)}%` }, { label: 'Broken promises', value: String(row.brokenPromises) }],
        rationale: { limitReviewThresholdBps: 11000, brokenPromiseTripwire: 2 },
        sourceEntityType: 'customers', sourceEntityId: row.id,
      });
    }
  }
  for (const row of ranked) {
    const prior = cumulative; cumulative += row.lifetimeValue;
    const abc = grandValue <= 0 ? 'C' : prior < grandValue * 0.8 ? 'A' : prior < grandValue * 0.95 ? 'B' : 'C';
    if (abc === 'C' || row.purchaseCount < 3 || !row.firstPurchase || !row.lastPurchase) continue;
    const interval = Math.max(1, daysBetween(row.firstPurchase, row.lastPurchase) / (row.purchaseCount - 1));
    const inactive = daysBetween(row.lastPurchase, now);
    if (inactive < 14 || inactive <= interval * 1.5) continue;
    out.push({
      fingerprint: `customer-winback:${row.id}`, family: 'CREDIT', locationId, modelKey: 'customer-winback',
      category: 'CUSTOMER', audience: 'OWNER', severity: abc === 'A' ? 'MEDIUM' : 'LOW',
      title: `${row.name} is buying less often than usual`,
      recommendation: 'Review recent purchases and decide whether a personal check-in is worthwhile.',
      cediImpactPesewas: null, confidenceBps: Math.min(9000, 5500 + row.purchaseCount * 300), sourceDataThrough: now,
      evidence: [{ label: 'Customer class', value: abc }, { label: 'Inactive', value: `${inactive} days` }, { label: 'Usual interval', value: `${Math.round(interval)} days` }, { label: 'Lifetime value', value: moneyEvidence(row.lifetimeValue) }],
      rationale: { purchaseCount: row.purchaseCount, inactivityMultiplier: inactive / interval },
      sourceEntityType: 'customers', sourceEntityId: row.id,
    });
  }
  return out;
}

function priceResponseEstimate(db: DB, productId: string): {
  eligible: boolean; elasticity: number | null; periodCount: number;
} {
  const periods = db.prepare(`SELECT sl.unit_price_pesewas AS price,
      SUM(sl.quantity) AS units, MIN(s.created_at) AS firstAt, MAX(s.created_at) AS lastAt,
      julianday(MAX(s.created_at)) - julianday(MIN(s.created_at)) + 1 AS durationDays
    FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
    WHERE sl.product_id = ? AND s.voided = 0 AND s.channel = 'WALK_IN'
    GROUP BY sl.unit_price_pesewas
    HAVING SUM(sl.quantity) >= 20 AND durationDays >= 14
    ORDER BY sl.unit_price_pesewas`)
    .all(productId) as Array<{ price: number; units: number; firstAt: string; lastAt: string; durationDays: number }>;
  if (periods.length < 3) return { eligible: false, elasticity: null, periodCount: periods.length };
  const points = periods.filter((row) => row.price > 0 && row.units > 0)
    .map((row) => ({ x: Math.log(row.price), y: Math.log(row.units / row.durationDays) }));
  if (points.length < 3) return { eligible: false, elasticity: null, periodCount: points.length };
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator <= 0) return { eligible: true, elasticity: null, periodCount: points.length };
  const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  return { eligible: true, elasticity: Math.max(-10, Math.min(10, slope)), periodCount: points.length };
}

function pricingCandidates(db: DB, locationId: string, now: string): IntelligenceCandidate[] {
  const rows = db.prepare(`WITH latest_landed AS (
      SELECT sil.product_id AS productId,
        CAST(sil.landed_line_total_pesewas AS REAL) / NULLIF(sil.canonical_quantity, 0) AS landedUnit,
        si.invoice_date AS invoiceDate,
        ROW_NUMBER() OVER (PARTITION BY sil.product_id ORDER BY si.invoice_date DESC, sil.id DESC) AS rn
      FROM supplier_invoice_lines sil JOIN supplier_invoices si ON si.id = sil.supplier_invoice_id
      WHERE si.status != 'VOID'
    ), previous_landed AS (
      SELECT sil.product_id AS productId,
        CAST(sil.landed_line_total_pesewas AS REAL) / NULLIF(sil.canonical_quantity, 0) AS landedUnit,
        ROW_NUMBER() OVER (PARTITION BY sil.product_id ORDER BY si.invoice_date DESC, sil.id DESC) AS rn
      FROM supplier_invoice_lines sil JOIN supplier_invoices si ON si.id = sil.supplier_invoice_id
      WHERE si.status != 'VOID'
    )
    SELECT p.id, p.sku, p.name, p.category, p.walk_in_price_pesewas AS price,
      p.minimum_price_pesewas AS minimumPrice, p.competitor_price_pesewas AS competitorPrice,
      p.competitor_checked_at AS competitorCheckedAt,
      CAST(COALESCE(ll.landedUnit, p.cost_price_pesewas) AS INTEGER) AS landedCost,
      CAST(COALESCE(pl.landedUnit, p.cost_price_pesewas) AS INTEGER) AS previousCost,
      ll.invoiceDate
    FROM products p LEFT JOIN latest_landed ll ON ll.productId = p.id AND ll.rn = 1
      LEFT JOIN previous_landed pl ON pl.productId = p.id AND pl.rn = 2
    WHERE p.active = 1 AND p.deleted_at IS NULL`)
    .all() as Array<{ id: string; sku: string; name: string; category: string; price: number; minimumPrice: number; competitorPrice: number | null; competitorCheckedAt: string | null; landedCost: number; previousCost: number; invoiceDate: string | null }>;
  const margins = new Map<string, number[]>();
  const salesMargins = db.prepare(`SELECT p.category,
      CAST(SUM(sl.line_total_pesewas - sl.line_cogs_pesewas) AS REAL) / NULLIF(SUM(sl.line_total_pesewas), 0) AS ratio
    FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN products p ON p.id = sl.product_id
    WHERE s.location_id = ? AND s.voided = 0 AND s.created_at >= datetime(?, '-90 days')
    GROUP BY p.id HAVING SUM(sl.line_total_pesewas) > 0`)
    .all(locationId, now) as Array<{ category: string; ratio: number }>;
  for (const row of salesMargins) { const list = margins.get(row.category) ?? []; if (row.ratio > 0) list.push(row.ratio); margins.set(row.category, list); }
  const out: IntelligenceCandidate[] = [];
  for (const row of rows) {
    const marginBps = row.price > 0 ? Math.round((row.price - row.landedCost) * 10_000 / row.price) : -10_000;
    const costChangeBps = row.previousCost > 0 ? Math.round((row.landedCost - row.previousCost) * 10_000 / row.previousCost) : 0;
    if (costChangeBps < 500 || (marginBps >= 1000 && row.price >= row.minimumPrice)) continue;
    const categoryTarget = Math.max(0.1, Math.min(0.5, median(margins.get(row.category) ?? [0.1])));
    const suggestedFloor = advisoryPriceFloor(row.landedCost, categoryTarget, row.minimumPrice);
    const competitorFresh = row.competitorPrice != null && row.competitorCheckedAt != null
      && daysBetween(row.competitorCheckedAt, now) <= 30;
    const response = priceResponseEstimate(db, row.id);
    out.push({
      fingerprint: `pricing-cost-shock:${row.id}`, family: 'PRICING', locationId, modelKey: 'landed-cost-margin',
      category: 'PRICING', audience: 'OWNER', severity: marginBps < 0 ? 'HIGH' : 'MEDIUM',
      title: `${row.name} margin has been squeezed by cost`,
      recommendation: `Review a walk-in price of at least ${moneyEvidence(suggestedFloor)} or renegotiate the supplier cost. No price will be changed automatically.`,
      cediImpactPesewas: null, confidenceBps: row.invoiceDate ? 8500 : 6000, sourceDataThrough: row.invoiceDate ?? now,
      evidence: [{ label: 'Landed cost', value: moneyEvidence(row.landedCost) }, { label: 'Current price', value: moneyEvidence(row.price) }, { label: 'Current margin', value: `${(marginBps / 100).toFixed(1)}%` }, { label: 'Cost change', value: `${(costChangeBps / 100).toFixed(1)}%` }, ...(competitorFresh ? [{ label: 'Fresh manual competitor price', value: moneyEvidence(row.competitorPrice!) }] : []), ...(response.elasticity == null ? [{ label: 'Price response', value: 'Not estimated', detail: 'Requires 3 price periods, each at least 14 days and 20 canonical units.' }] : [{ label: 'Historical price response', value: `${response.elasticity.toFixed(2)}% unit change per 1% price change`, detail: 'Observational estimate; other demand changes may be responsible.' }])],
      rationale: { categoryTargetMarginBps: Math.round(categoryTarget * 10_000), competitorFresh, elasticityEstimated: response.elasticity != null, qualifyingPricePeriods: response.periodCount, elasticity: response.elasticity },
      sourceEntityType: 'products', sourceEntityId: row.id,
    });
  }
  return out;
}

function financeCandidates(db: DB, locationId: string, now: string): IntelligenceCandidate[] {
  const out: IntelligenceCandidate[] = [];
  const today = dateOnly(now);
  const activeLedger = isLedgerActive(db, locationId);
  const accounts = listFinancialAccounts(db, locationId);
  const cash = accounts.reduce((sum, account) => sum + Math.max(0, account.balancePesewas), 0);
  try {
    const maturity = getDebtMaturity(db, {
      actorWorkerId: SYSTEM_ID, deviceId: 'intelligence-engine', locationId,
      asOfDate: today, background: true,
    });
    const due30 = maturity.dueNext30DaysPesewas;
    const reconciledCash = maturity.availableReconciledCashPesewas;
    const coverage = maturity.cashCoverageBps;
    const nextDue = maturity.rows.find((row) => row.dueDate != null)?.dueDate ?? null;
    if (due30 > 0 && (coverage == null || coverage < 11_000)) {
      const quality = maturity.dataQuality.status;
      out.push({
        fingerprint: 'cash-obligation-coverage', family: 'FINANCE', locationId, modelKey: 'management-obligation-coverage',
        category: 'CASH', audience: 'OWNER', severity: maturity.dueNext7DaysPesewas > reconciledCash || (coverage != null && coverage < 8_000) ? 'HIGH' : 'MEDIUM',
        title: maturity.dueNext7DaysPesewas > reconciledCash ? 'An obligation due within seven days lacks recorded coverage' : 'Near-term obligations may exceed reconciled cash',
        recommendation: 'Review collections, drawings, planned purchases, and obligation due dates before committing more cash.',
        cediImpactPesewas: Math.max(0, due30 - reconciledCash),
        confidenceBps: activeLedger && quality === 'COMPLETE' ? 9000 : quality === 'PROVISIONAL' ? 6500 : 4500,
        dueAt: nextDue ? `${nextDue}T23:59:59.999Z` : addDays(now, 7), sourceDataThrough: now,
        evidence: [{ label: 'Due in 30 days', value: moneyEvidence(due30) }, { label: 'Due in 7 days', value: moneyEvidence(maturity.dueNext7DaysPesewas) }, { label: 'Reconciled cash', value: moneyEvidence(reconciledCash) }, { label: 'Coverage', value: coverage == null ? 'unknown' : `${(coverage / 100).toFixed(0)}%` }, { label: 'All recorded cash', value: moneyEvidence(cash) }, { label: 'Data quality', value: quality }],
        rationale: { coverageWarningBps: 11000, ledgerActive: activeLedger,
          dataQualityIssues: maturity.dataQuality.issues.map((issue) => issue.code), estimate: quality !== 'COMPLETE' },
        sourceEntityType: 'obligations', sourceEntityId: null,
      });
    }
  } catch {
    // Scenario and concentration checks below still run; the engine records
    // missing finance-family output as part of the run rather than blocking.
  }

  try {
    const scenario = runDownsideScenario(db, {
      actorWorkerId: SYSTEM_ID, deviceId: 'intelligence-engine', locationId,
      preset: 'MILD', horizonDays: 90, asOfDate: today, background: true,
    });
    if (scenario.projected.minimumCashPesewas < 0) {
      const quality = scenario.dataQuality.status;
      const confidence = quality === 'COMPLETE' ? 8500 : quality === 'PROVISIONAL' ? 6000 : 4000;
      out.push({
        fingerprint: 'cash-mild-downside-negative', family: 'FINANCE', locationId,
        modelKey: 'mild-downside-cash', category: 'CASH', audience: 'OWNER', severity: 'HIGH',
        title: 'Recorded cash turns negative in the 90-day mild downside estimate',
        recommendation: 'Review the scenario inputs, collections, obligations, drawings, and planned purchases. This is an advisory estimate, not a predicted failure date.',
        cediImpactPesewas: Math.abs(scenario.projected.minimumCashPesewas), confidenceBps: confidence,
        dueAt: addDays(now, 7), sourceDataThrough: now,
        evidence: [
          { label: 'Estimated minimum cash', value: moneyEvidence(scenario.projected.minimumCashPesewas) },
          { label: 'Estimated ending cash', value: moneyEvidence(scenario.projected.endingCashPesewas) },
          { label: 'Possible first negative period', value: scenario.projected.firstNegativeCashDate ?? 'Within the scenario horizon', detail: 'Estimate; timing depends on recorded data and scenario assumptions.' },
          { label: 'Ledger data quality', value: quality },
        ],
        rationale: { scenario: 'MILD', horizonDays: 90, estimate: true, dataQualityIssues: scenario.dataQuality.issues.map((issue) => issue.code) },
        sourceEntityType: 'saved_scenarios', sourceEntityId: null,
      });
    }
  } catch {
    // Missing or pre-cutover management data is already represented by the
    // downgraded obligation-coverage item. A scenario failure must not fail
    // the remaining daily evaluators.
  }

  try {
    const concentration = getConcentrationReport(db, {
      actorWorkerId: SYSTEM_ID, deviceId: 'intelligence-engine', locationId,
      fromDate: dateOnly(addDays(now, -89)), toDate: today, background: true,
    });
    for (const dimension of concentration.dimensions.filter((row) => row.risk !== 'OK')) {
      const top = dimension.exposures[0];
      if (!top) continue;
      const quality = concentration.dataQuality.status;
      out.push({
        fingerprint: `concentration:${dimension.dimension}`, family: 'FINANCE', locationId,
        modelKey: 'management-concentration', category: 'CONCENTRATION', audience: 'OWNER',
        severity: dimension.risk === 'DANGER' ? 'HIGH' : 'MEDIUM',
        title: `${dimension.dimension.toLowerCase().replace('_', ' ')} concentration is above its configured threshold`,
        recommendation: `Review the business's exposure to ${top.name} and consider practical diversification. No customer, supplier, product, category, or payment rail will be restricted automatically.`,
        cediImpactPesewas: top.amountPesewas,
        confidenceBps: quality === 'COMPLETE' ? 9000 : quality === 'PROVISIONAL' ? 6500 : 4500,
        sourceDataThrough: now,
        evidence: [{ label: 'Top dependency', value: top.name }, { label: dimension.metric.toLowerCase().replace('_', ' '), value: moneyEvidence(top.amountPesewas) }, { label: 'Share', value: `${(dimension.topOneBps / 100).toFixed(1)}%` }, { label: 'Warning threshold', value: `${(dimension.warningBps / 100).toFixed(1)}%` }, { label: 'Data quality', value: quality }],
        rationale: { dimension: dimension.dimension, topOneBps: dimension.topOneBps,
          warningBps: dimension.warningBps, dangerBps: dimension.dangerBps,
          hhi: dimension.hhi, changeBps: dimension.changeBps, windowDays: 90 },
      });
    }
  } catch {
    // Other finance items still surface with downgraded confidence if the
    // management concentration report cannot be produced from current data.
  }
  return out;
}

function persistCandidates(db: DB, candidates: IntelligenceCandidate[], family: ModelFamily, actorWorkerId: string, deviceId: string, locationId: string, now: string): { generated: number; updated: number; resolved: number } {
  let generated = 0; let updated = 0; let resolved = 0;
  const seen = new Set(candidates.map((candidate) => candidate.fingerprint));
  const active = db.prepare(`SELECT id, fingerprint, severity, status FROM intelligence_items
    WHERE location_id = ? AND json_extract(rationale_json, '$.family') = ?
      AND status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED')`)
    .all(locationId, family) as Array<{ id: string; fingerprint: string; severity: IntelligenceSeverity; status: IntelligenceStatus }>;
  for (const old of active) {
    if (seen.has(old.fingerprint)) continue;
    db.prepare(`UPDATE intelligence_items SET status = 'RESOLVED', resolution_note = ?,
      condition_cleared_at = ?, closed_at = ?, last_evaluated_at = ?, updated_at = ?, updated_by = ?, device_id = ?
      WHERE id = ?`).run('Underlying condition cleared on refresh.', now, now, now, now, actorWorkerId, deviceId, old.id);
    appendEvent(db, { itemId: old.id, eventType: 'AUTO_RESOLVED', actorWorkerId, deviceId,
      fromStatus: old.status, toStatus: 'RESOLVED', note: 'Underlying condition cleared on refresh.' });
    resolved++;
  }
  const terminalUncleared = db.prepare(`SELECT id, fingerprint, severity, status, episode FROM intelligence_items
    WHERE location_id = ? AND json_extract(rationale_json, '$.family') = ?
      AND status IN ('RESOLVED','DISMISSED','EXPIRED') AND condition_cleared_at IS NULL`)
    .all(locationId, family) as Array<{
      id: string;
      fingerprint: string;
      severity: IntelligenceSeverity;
      status: IntelligenceStatus;
      episode: number;
    }>;
  for (const old of terminalUncleared) {
    if (!seen.has(old.fingerprint)) {
      db.prepare(`UPDATE intelligence_items SET condition_cleared_at = ?, last_evaluated_at = ?,
        updated_at = ?, updated_by = ?, device_id = ? WHERE id = ?`)
        .run(now, now, now, actorWorkerId, deviceId, old.id);
      appendEvent(db, { itemId: old.id, eventType: 'UPDATED', actorWorkerId, deviceId,
        fromStatus: old.status, toStatus: old.status,
        note: 'Underlying condition cleared; a later recurrence may create a new episode.' });
    }
  }
  for (const candidate of candidates) {
    const existing = db.prepare(`SELECT id, severity, status FROM intelligence_items
      WHERE location_id = ? AND scope = ? AND fingerprint = ?
        AND status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED') LIMIT 1`)
      .get(candidate.locationId, candidate.scope ?? 'LOCAL', candidate.fingerprint) as { id: string; severity: IntelligenceSeverity; status: IntelligenceStatus } | undefined;
    const rationale = JSON.stringify({ ...candidate.rationale, family });
    if (existing) {
      db.prepare(`UPDATE intelligence_items SET model_version = ?, category = ?, audience = ?, severity = ?,
        control_override = ?, title = ?, recommendation = ?, cedi_impact_pesewas = ?, confidence_bps = ?,
        due_at = ?, valid_until = ?, source_data_through = ?, evidence_json = ?, rationale_json = ?,
        source_entity_type = ?, source_entity_id = ?, last_evaluated_at = ?, updated_at = ?,
        updated_by = ?, device_id = ? WHERE id = ?`).run(
          MODEL_VERSION, candidate.category, candidate.audience, candidate.severity,
          candidate.controlOverride ? 1 : 0, candidate.title, candidate.recommendation,
          candidate.cediImpactPesewas ?? null, candidate.confidenceBps, candidate.dueAt ?? null,
          candidate.validUntil ?? addDays(now, 2), candidate.sourceDataThrough,
          JSON.stringify(candidate.evidence), rationale, candidate.sourceEntityType ?? null,
          candidate.sourceEntityId ?? null, now, now, actorWorkerId, deviceId, existing.id,
        );
      appendEvent(db, { itemId: existing.id, eventType: 'UPDATED', actorWorkerId, deviceId,
        fromStatus: existing.status, toStatus: existing.status,
        note: severityRank(candidate.severity) > severityRank(existing.severity) ? 'Severity increased.' : 'Evidence refreshed.' });
      updated++;
      continue;
    }
    const terminal = db.prepare(`SELECT id, severity, episode, condition_cleared_at AS conditionClearedAt
      FROM intelligence_items WHERE location_id = ? AND scope = ? AND fingerprint = ?
      ORDER BY episode DESC LIMIT 1`).get(candidate.locationId, candidate.scope ?? 'LOCAL', candidate.fingerprint) as
      | { id: string; severity: IntelligenceSeverity; episode: number; conditionClearedAt: string | null }
      | undefined;
    if (terminal && !terminal.conditionClearedAt && severityRank(candidate.severity) <= severityRank(terminal.severity)) continue;
    const id = `ii-${uuidv4()}`;
    db.prepare(`INSERT INTO intelligence_items (
      id, fingerprint, episode, location_id, scope, source_shop_id, model_key, model_version,
      category, audience, severity, status, control_override, title, recommendation,
      cedi_impact_pesewas, confidence_bps, due_at, valid_until, source_data_through,
      evidence_json, rationale_json, source_entity_type, source_entity_id,
      detected_at, last_evaluated_at, created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, candidate.fingerprint, (terminal?.episode ?? 0) + 1, candidate.locationId,
        candidate.scope ?? 'LOCAL', candidate.sourceShopId ?? null, candidate.modelKey, MODEL_VERSION,
        candidate.category, candidate.audience, candidate.severity, candidate.controlOverride ? 1 : 0,
        candidate.title, candidate.recommendation, candidate.cediImpactPesewas ?? null,
        candidate.confidenceBps, candidate.dueAt ?? null, candidate.validUntil ?? addDays(now, 2),
        candidate.sourceDataThrough, JSON.stringify(candidate.evidence), rationale,
        candidate.sourceEntityType ?? null, candidate.sourceEntityId ?? null,
        now, now, actorWorkerId, actorWorkerId, deviceId);
    appendEvent(db, { itemId: id, eventType: terminal ? 'REOPENED' : 'GENERATED', actorWorkerId, deviceId,
      toStatus: 'OPEN', note: terminal ? 'Condition recurred after clearing.' : 'Condition detected.' });
    generated++;
  }
  return { generated, updated, resolved };
}

/** Merge the tenant-scoped HQ feed into the local advisory queue. The central
 * item is deliberately translated into a new COMPANY-scoped episode: branch
 * acknowledgement does not overwrite HQ acknowledgement, and vice versa. */
export function applyCompanyIntelligenceFeed(
  db: DB, feed: CompanyIntelligenceFeedResponse, deviceId: string,
  locationId = DEFAULT_LOCATION_ID,
): { generated: number; updated: number; resolved: number } {
  const now = new Date().toISOString();
  const candidates: IntelligenceCandidate[] = feed.items.map((item) => ({
    fingerprint: item.fingerprint,
    family: 'HQ',
    locationId,
    scope: 'COMPANY',
    sourceShopId: item.sourceShopId,
    modelKey: item.modelKey,
    category: item.category,
    audience: 'OWNER',
    severity: item.severity,
    controlOverride: item.controlOverride,
    title: item.title,
    recommendation: item.recommendation,
    cediImpactPesewas: item.cediImpactPesewas,
    confidenceBps: item.confidenceBps,
    dueAt: item.dueAt,
    validUntil: item.validUntil,
    sourceDataThrough: item.sourceDataThrough,
    evidence: item.evidence,
    rationale: {
      ...item.rationale,
      sourceModelVersion: item.modelVersion,
      sourceShopName: item.sourceShopName,
      companyFeedGeneratedAt: feed.generatedAt,
    },
    sourceEntityType: item.sourceEntityType,
    sourceEntityId: item.sourceEntityId,
  }));
  return db.transaction(() => persistCandidates(
    db, candidates, 'HQ', SYSTEM_ID, deviceId, locationId, now,
  ))();
}

export function refreshIntelligence(db: DB, input: {
  actorWorkerId?: string; deviceId: string; locationId?: string;
  trigger: 'BOOT' | 'LOGIN' | 'DAILY' | 'EVENT' | 'MANUAL' | 'HQ_PULL';
  exactOnly?: boolean;
}): IntelligenceRefreshResponse {
  const stage = getIntelligenceStage(db);
  if (stage === 'OFF') return { skipped: true, generatedCount: 0, updatedCount: 0, resolvedCount: 0, durationMs: 0 };
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const actorWorkerId = input.actorWorkerId ?? SYSTEM_ID;
  const now = new Date().toISOString();
  if (!input.exactOnly && input.trigger !== 'MANUAL') {
    const last = db.prepare(`SELECT completed_at AS at FROM intelligence_runs
      WHERE location_id = ? AND status = 'SUCCESS' AND model_family = 'ALL'
      ORDER BY completed_at DESC LIMIT 1`).get(locationId) as { at: string | null } | undefined;
    if (last?.at && dateOnly(last.at) === dateOnly(now)) {
      return { skipped: true, generatedCount: 0, updatedCount: 0, resolvedCount: 0, durationMs: 0 };
    }
  }
  const staleRun = db.prepare(`SELECT 1 FROM intelligence_runs WHERE location_id = ? AND status = 'RUNNING'
    AND started_at >= datetime(?, '-10 minutes') LIMIT 1`).get(locationId, now);
  if (staleRun) return { skipped: true, generatedCount: 0, updatedCount: 0, resolvedCount: 0, durationMs: 0 };
  const runId = `ir-${uuidv4()}`;
  const startMs = Date.now();
  db.prepare(`INSERT INTO intelligence_runs (id, location_id, model_family, model_version,
    trigger_type, status, started_at, device_id) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)`)
    .run(runId, locationId, input.exactOnly ? 'FOUNDATION' : 'ALL', MODEL_VERSION, input.trigger, now, input.deviceId);
  try {
    const exactControls = controlCandidates(db, locationId, now);
    const groups: Array<{ family: ModelFamily; candidates: IntelligenceCandidate[] }> = [];
    if (!input.exactOnly && stageAtLeast(stage, 'PREDICTIVE')) groups.push(
      { family: 'CONTROLS', candidates: [...exactControls, ...normalizedWorkerCandidates(db, locationId, now)] },
      { family: 'INVENTORY', candidates: inventoryCandidates(db, locationId, now) },
      { family: 'CREDIT', candidates: creditCandidates(db, locationId, now) },
      { family: 'PRICING', candidates: pricingCandidates(db, locationId, now) },
      { family: 'FINANCE', candidates: financeCandidates(db, locationId, now) },
    ); else groups.push({ family: 'CONTROLS', candidates: exactControls });
    let generated = 0; let updated = 0; let resolved = 0;
    db.transaction(() => {
      wakeSnoozed(db, input.deviceId, now);
      expirePastValidity(db, input.deviceId, now);
      for (const group of groups) {
        const result = persistCandidates(db, group.candidates, group.family, actorWorkerId, input.deviceId, locationId, now);
        generated += result.generated; updated += result.updated; resolved += result.resolved;
      }
    })();
    const duration = Date.now() - startMs;
    db.prepare(`UPDATE intelligence_runs SET status = 'SUCCESS', completed_at = ?, source_data_through = ?,
      generated_count = ?, updated_count = ?, resolved_count = ?, duration_ms = ? WHERE id = ?`)
      .run(new Date().toISOString(), now, generated, updated, resolved, duration, runId);
    return { skipped: false, generatedCount: generated, updatedCount: updated, resolvedCount: resolved, durationMs: duration };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startMs;
    db.prepare(`UPDATE intelligence_runs SET status = 'FAILED', completed_at = ?, duration_ms = ?, error = ? WHERE id = ?`)
      .run(new Date().toISOString(), duration, message.slice(0, 1000), runId);
    throw error;
  }
}
