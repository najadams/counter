import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { verifyPin } from './workers.js';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';

export type VarianceCaseType = 'TILL_CASH' | 'FINANCIAL_ACCOUNT' | 'STOCK_SHORTAGE' | 'STOCK_FOUND' | 'CUSTOMER_BALANCE' | 'MANUAL';
export type VarianceCaseStatus = 'OPEN' | 'INVESTIGATING' | 'AWAITING_EVIDENCE' | 'RESOLVED' | 'WRITTEN_OFF';
export type VarianceCauseCode = 'WRONG_CHANGE' | 'MISSED_SALE' | 'WRONG_PAYMENT_RAIL' | 'UNRECORDED_EXPENSE' | 'UNRECORDED_CASH_DROP' | 'COUNTING_ERROR' | 'BREAKAGE' | 'EXPIRY' | 'THEFT' | 'BANK_MOMO_TIMING' | 'CUSTOMER_ALLOCATION' | 'SYSTEM_DATA_ERROR' | 'OTHER';

const SENIOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);
const OWNER_ROLES = new Set(['OWNER', 'FOUNDER']);
const OPEN_STATUSES = new Set<VarianceCaseStatus>(['OPEN', 'INVESTIGATING', 'AWAITING_EVIDENCE']);

export interface VarianceCaseSettings {
  locationId: string;
  tillAmountThresholdPesewas: number;
  tillThresholdBps: number;
  stockAmountThresholdPesewas: number;
  stockThresholdBps: number;
  dueDays: number;
}

export interface VarianceCaseRow {
  id: string;
  locationId: string;
  caseType: VarianceCaseType;
  status: VarianceCaseStatus;
  severity: 'WARNING' | 'DANGER';
  title: string;
  detectedAt: string;
  dueAt: string;
  amountPesewas: number;
  expectedPesewas: number | null;
  observedPesewas: number | null;
  thresholdPesewas: number;
  sourceType: string;
  sourceId: string;
  assignedTo: string | null;
  assignedToName: string | null;
  subjectName: string | null;
  causeCode: VarianceCauseCode | null;
  rootCauseNotes: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  adjustmentJournalEntryId: string | null;
  createdByName: string;
  overdue: boolean;
}

function workerRole(db: DB, workerId: string): string {
  const row = db.prepare(`SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?`).get(workerId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!row || row.active !== 1 || row.deleted_at || row.terminated_at) throw new Error('Active worker not found');
  return row.role;
}

export function requireVarianceSenior(db: DB, workerId: string): string {
  const role = workerRole(db, workerId);
  if (!SENIOR_ROLES.has(role)) throw new Error('Supervisor, owner, or founder access required');
  return role;
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function getVarianceCaseSettings(db: DB, locationId = DEFAULT_LOCATION_ID): VarianceCaseSettings {
  const row = db.prepare(`SELECT location_id AS locationId,
      till_amount_threshold_pesewas AS tillAmountThresholdPesewas,
      till_threshold_bps AS tillThresholdBps,
      stock_amount_threshold_pesewas AS stockAmountThresholdPesewas,
      stock_threshold_bps AS stockThresholdBps, due_days AS dueDays
    FROM variance_case_settings WHERE location_id = ?`).get(locationId) as VarianceCaseSettings | undefined;
  if (!row) throw new Error(`Variance settings not found for location ${locationId}`);
  return row;
}

function appendEvent(db: DB, input: {
  caseId: string; eventType: string; actorWorkerId: string; deviceId: string;
  fromStatus?: string | null; toStatus?: string | null; note?: string | null;
  causeCode?: string | null; evidenceReference?: string | null; evidenceUrl?: string | null;
}): void {
  db.prepare(`INSERT INTO variance_case_events (
    id, case_id, event_type, from_status, to_status, note, cause_code,
    evidence_reference, evidence_url, actor_worker_id, device_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `vce-${uuidv4()}`, input.caseId, input.eventType, input.fromStatus ?? null,
    input.toStatus ?? null, input.note?.trim() || null, input.causeCode ?? null,
    input.evidenceReference?.trim() || null, input.evidenceUrl?.trim() || null,
    input.actorWorkerId, input.deviceId,
  );
}

export function openVarianceCase(db: DB, input: {
  locationId?: string; caseType: VarianceCaseType; title: string;
  amountPesewas: number; expectedPesewas?: number | null; observedPesewas?: number | null;
  thresholdPesewas?: number; sourceType: string; sourceId: string;
  subjectWorkerId?: string | null; financialAccountId?: string | null;
  stocktakeEventId?: string | null; customerId?: string | null;
  adjustmentJournalEntryId?: string | null; actorWorkerId: string; deviceId: string;
  detectedAt?: string;
}): { caseId: string; created: boolean } {
  if (!Number.isInteger(input.amountPesewas)) throw new Error('Variance amount must be integer pesewas');
  const title = input.title.trim();
  if (title.length < 3 || title.length > 160) throw new Error('Variance title must be 3–160 characters');
  const existing = db.prepare(`SELECT id FROM variance_cases WHERE case_type = ? AND source_type = ? AND source_id = ?`)
    .get(input.caseType, input.sourceType, input.sourceId) as { id: string } | undefined;
  if (existing) return { caseId: existing.id, created: false };
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const settings = getVarianceCaseSettings(db, locationId);
  const now = input.detectedAt ?? new Date().toISOString();
  const threshold = input.thresholdPesewas ?? 0;
  const caseId = `vc-${uuidv4()}`;
  const severity = Math.abs(input.amountPesewas) >= Math.max(threshold * 2, 10_000) ? 'DANGER' : 'WARNING';
  db.prepare(`INSERT INTO variance_cases (
      id, location_id, case_type, severity, title, detected_at, due_at,
      amount_pesewas, expected_pesewas, observed_pesewas, threshold_pesewas,
      source_type, source_id, subject_worker_id, financial_account_id,
      stocktake_event_id, customer_id, adjustment_journal_entry_id,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(caseId, locationId, input.caseType, severity, title, now, addDays(now, settings.dueDays),
      input.amountPesewas, input.expectedPesewas ?? null, input.observedPesewas ?? null,
      threshold, input.sourceType, input.sourceId, input.subjectWorkerId ?? null,
      input.financialAccountId ?? null, input.stocktakeEventId ?? null,
      input.customerId ?? null, input.adjustmentJournalEntryId ?? null,
      input.actorWorkerId, input.actorWorkerId, input.deviceId);
  appendEvent(db, { caseId, eventType: 'OPENED', actorWorkerId: input.actorWorkerId, deviceId: input.deviceId, toStatus: 'OPEN' });
  logAudit(db, {
    workerId: input.actorWorkerId, action: 'VARIANCE_CASE_OPENED', entityType: 'variance_cases', entityId: caseId,
    afterValue: { caseType: input.caseType, amountPesewas: input.amountPesewas, sourceType: input.sourceType, sourceId: input.sourceId },
    deviceId: input.deviceId,
  });
  return { caseId, created: true };
}

export function maybeOpenTillVarianceCase(db: DB, input: {
  shiftId: string; locationId: string; shiftWorkerId: string; expectedPesewas: number;
  countedPesewas: number; variancePesewas: number; actorWorkerId: string; deviceId: string; detectedAt?: string;
}): { caseId: string; created: boolean } | null {
  if (input.variancePesewas === 0) return null;
  const settings = getVarianceCaseSettings(db, input.locationId);
  const percentageThreshold = Math.ceil(Math.abs(input.expectedPesewas) * settings.tillThresholdBps / 10_000);
  const threshold = Math.max(settings.tillAmountThresholdPesewas, percentageThreshold);
  if (Math.abs(input.variancePesewas) < threshold) return null;
  return openVarianceCase(db, {
    locationId: input.locationId, caseType: 'TILL_CASH', title: `Till close variance`,
    amountPesewas: input.variancePesewas, expectedPesewas: input.expectedPesewas,
    observedPesewas: input.countedPesewas, thresholdPesewas: threshold,
    sourceType: 'SHIFT', sourceId: input.shiftId, subjectWorkerId: input.shiftWorkerId,
    actorWorkerId: input.actorWorkerId, deviceId: input.deviceId, detectedAt: input.detectedAt,
  });
}

export function maybeOpenFinancialAccountVarianceCase(db: DB, input: {
  reconciliationId: string; locationId: string; financialAccountId: string; accountName: string;
  expectedPesewas: number; observedPesewas: number; variancePesewas: number;
  adjustmentJournalEntryId?: string | null; actorWorkerId: string; deviceId: string; detectedAt?: string;
}): { caseId: string; created: boolean } | null {
  if (input.variancePesewas === 0) return null;
  return openVarianceCase(db, {
    locationId: input.locationId, caseType: 'FINANCIAL_ACCOUNT', title: `${input.accountName} reconciliation variance`,
    amountPesewas: input.variancePesewas, expectedPesewas: input.expectedPesewas,
    observedPesewas: input.observedPesewas, sourceType: 'ACCOUNT_RECONCILIATION',
    sourceId: input.reconciliationId, financialAccountId: input.financialAccountId,
    adjustmentJournalEntryId: input.adjustmentJournalEntryId, actorWorkerId: input.actorWorkerId,
    deviceId: input.deviceId, detectedAt: input.detectedAt,
  });
}

export function maybeOpenStocktakeVarianceCases(db: DB, input: {
  eventId: string; locationId: string; expectedStockValuePesewas: number;
  lossPesewas: number; foundPesewas: number; actorWorkerId: string; deviceId: string; detectedAt?: string;
}): Array<{ caseId: string; created: boolean }> {
  const settings = getVarianceCaseSettings(db, input.locationId);
  const threshold = Math.max(settings.stockAmountThresholdPesewas,
    Math.ceil(Math.abs(input.expectedStockValuePesewas) * settings.stockThresholdBps / 10_000));
  const result: Array<{ caseId: string; created: boolean }> = [];
  if (input.lossPesewas >= threshold && input.lossPesewas !== 0) result.push(openVarianceCase(db, {
    locationId: input.locationId, caseType: 'STOCK_SHORTAGE', title: 'Stocktake shortage',
    amountPesewas: -input.lossPesewas, expectedPesewas: input.expectedStockValuePesewas,
    thresholdPesewas: threshold, sourceType: 'STOCKTAKE', sourceId: `${input.eventId}:LOSS`,
    stocktakeEventId: input.eventId, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId,
    detectedAt: input.detectedAt,
  }));
  if (input.foundPesewas >= threshold && input.foundPesewas !== 0) result.push(openVarianceCase(db, {
    locationId: input.locationId, caseType: 'STOCK_FOUND', title: 'Stocktake found stock',
    amountPesewas: input.foundPesewas, expectedPesewas: input.expectedStockValuePesewas,
    thresholdPesewas: threshold, sourceType: 'STOCKTAKE', sourceId: `${input.eventId}:FOUND`,
    stocktakeEventId: input.eventId, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId,
    detectedAt: input.detectedAt,
  }));
  return result;
}

export function maybeOpenCustomerBalanceVarianceCase(db: DB, input: {
  customerId: string; previousPesewas: number; correctedPesewas: number; driftPesewas: number;
  actorWorkerId: string; deviceId: string; sourceId?: string; detectedAt?: string;
}): { caseId: string; created: boolean } | null {
  if (input.driftPesewas === 0) return null;
  const customer = db.prepare(`SELECT display_name AS name FROM customers WHERE id = ?`).get(input.customerId) as { name: string } | undefined;
  return openVarianceCase(db, {
    caseType: 'CUSTOMER_BALANCE', title: `${customer?.name ?? 'Customer'} balance drift`,
    amountPesewas: input.driftPesewas, expectedPesewas: input.correctedPesewas,
    observedPesewas: input.previousPesewas, sourceType: 'CUSTOMER_RECONCILIATION',
    sourceId: input.sourceId ?? `${input.customerId}:${input.detectedAt ?? new Date().toISOString()}`,
    customerId: input.customerId, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId,
    detectedAt: input.detectedAt,
  });
}

export function createManualVarianceCase(db: DB, input: {
  title: string; amountPesewas: number; note: string; actorWorkerId: string; deviceId: string;
  locationId?: string;
}): { caseId: string; created: boolean } {
  const note = input.note.trim();
  if (note.length < 3 || note.length > 500) throw new Error('Report details must be 3–500 characters');
  const sourceId = `manual-${uuidv4()}`;
  const opened = openVarianceCase(db, { ...input, caseType: 'MANUAL', sourceType: 'MANUAL_REPORT', sourceId });
  appendEvent(db, { caseId: opened.caseId, eventType: 'NOTE_ADDED', note, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId });
  return opened;
}

const CASE_SELECT = `SELECT vc.id, vc.location_id AS locationId, vc.case_type AS caseType,
  vc.status, vc.severity, vc.title, vc.detected_at AS detectedAt, vc.due_at AS dueAt,
  vc.amount_pesewas AS amountPesewas, vc.expected_pesewas AS expectedPesewas,
  vc.observed_pesewas AS observedPesewas, vc.threshold_pesewas AS thresholdPesewas,
  vc.source_type AS sourceType, vc.source_id AS sourceId, vc.assigned_to AS assignedTo,
  assignee.full_name AS assignedToName,
  COALESCE(subject.full_name, fa.name, c.display_name) AS subjectName,
  vc.cause_code AS causeCode, vc.root_cause_notes AS rootCauseNotes,
  vc.resolution_note AS resolutionNote, vc.resolved_at AS resolvedAt,
  resolver.full_name AS resolvedByName,
  vc.adjustment_journal_entry_id AS adjustmentJournalEntryId,
  creator.full_name AS createdByName,
  CASE WHEN vc.status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE') AND vc.due_at < ? THEN 1 ELSE 0 END AS overdue
 FROM variance_cases vc
 JOIN workers creator ON creator.id = vc.created_by
 LEFT JOIN workers assignee ON assignee.id = vc.assigned_to
 LEFT JOIN workers subject ON subject.id = vc.subject_worker_id
 LEFT JOIN workers resolver ON resolver.id = vc.resolved_by
 LEFT JOIN financial_accounts fa ON fa.id = vc.financial_account_id
 LEFT JOIN customers c ON c.id = vc.customer_id`;

function mapCase(row: Omit<VarianceCaseRow, 'overdue'> & { overdue: number }): VarianceCaseRow {
  return { ...row, overdue: row.overdue === 1 };
}

export function listVarianceCases(db: DB, input: {
  actorWorkerId: string; status?: 'OPEN' | 'HISTORY' | 'ALL'; limit?: number;
}): { cases: VarianceCaseRow[]; summary: { openCount: number; overdueCount: number; unresolvedPesewas: number } } {
  requireVarianceSenior(db, input.actorWorkerId);
  const now = new Date().toISOString();
  const clause = input.status === 'HISTORY'
    ? `WHERE vc.status IN ('RESOLVED','WRITTEN_OFF')`
    : input.status === 'ALL' ? '' : `WHERE vc.status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE')`;
  const rows = db.prepare(`${CASE_SELECT} ${clause} ORDER BY
      CASE WHEN vc.status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE') THEN 0 ELSE 1 END,
      vc.due_at, vc.detected_at DESC LIMIT ?`).all(now, Math.min(Math.max(input.limit ?? 200, 1), 500)) as Array<any>;
  const summary = db.prepare(`SELECT
      SUM(CASE WHEN status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE') THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE') AND due_at < ? THEN 1 ELSE 0 END) AS overdueCount,
      COALESCE(SUM(CASE WHEN status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE') THEN ABS(amount_pesewas) ELSE 0 END), 0) AS unresolvedPesewas
    FROM variance_cases`).get(now) as { openCount: number | null; overdueCount: number | null; unresolvedPesewas: number };
  return { cases: rows.map(mapCase), summary: { openCount: summary.openCount ?? 0, overdueCount: summary.overdueCount ?? 0, unresolvedPesewas: summary.unresolvedPesewas } };
}

export function getVarianceCase(db: DB, caseId: string, actorWorkerId: string): {
  case: VarianceCaseRow; events: Array<Record<string, unknown>>;
} {
  requireVarianceSenior(db, actorWorkerId);
  const row = db.prepare(`${CASE_SELECT} WHERE vc.id = ?`).get(new Date().toISOString(), caseId) as any;
  if (!row) throw new Error('Variance case not found');
  const events = db.prepare(`SELECT vce.id, vce.event_type AS eventType, vce.from_status AS fromStatus,
      vce.to_status AS toStatus, vce.note, vce.cause_code AS causeCode,
      vce.evidence_reference AS evidenceReference, vce.evidence_url AS evidenceUrl,
      vce.occurred_at AS occurredAt, w.full_name AS actorName
    FROM variance_case_events vce JOIN workers w ON w.id = vce.actor_worker_id
    WHERE vce.case_id = ? ORDER BY vce.occurred_at, vce.id`).all(caseId) as Array<Record<string, unknown>>;
  return { case: mapCase(row), events };
}

export function updateVarianceCase(db: DB, input: {
  caseId: string; actorWorkerId: string; deviceId: string; status?: VarianceCaseStatus;
  assignedTo?: string | null; causeCode?: VarianceCauseCode | null;
  rootCauseNotes?: string | null; resolutionNote?: string | null; pin?: string | null;
}): VarianceCaseRow {
  const role = requireVarianceSenior(db, input.actorWorkerId);
  const current = db.prepare(`SELECT * FROM variance_cases WHERE id = ?`).get(input.caseId) as any;
  if (!current) throw new Error('Variance case not found');
  const target = input.status ?? current.status as VarianceCaseStatus;
  if (target === 'WRITTEN_OFF') {
    if (!OWNER_ROLES.has(role)) throw new Error('Only an owner or founder can write off a variance');
    const auth = verifyPin(db, input.actorWorkerId, input.pin ?? '', input.deviceId);
    if (!auth.ok) throw new Error(auth.reason === 'LOCKED_OUT' ? `PIN locked until ${auth.lockedUntil}` : 'Fresh owner PIN verification failed');
  }
  if ((current.status === 'RESOLVED' || current.status === 'WRITTEN_OFF') && OPEN_STATUSES.has(target)) {
    if (!OWNER_ROLES.has(role)) throw new Error('Only an owner or founder can reopen a closed variance case');
    if ((input.resolutionNote?.trim().length ?? 0) < 3) throw new Error('A reopen reason is required');
  } else if ((current.status === 'RESOLVED' || current.status === 'WRITTEN_OFF') && target === current.status) {
    throw new Error('Closed variance cases cannot be edited; reopen the case first');
  }
  const cause = input.causeCode === undefined ? current.cause_code : input.causeCode;
  const rootNotes = input.rootCauseNotes === undefined ? current.root_cause_notes : input.rootCauseNotes?.trim() || null;
  const resolution = input.resolutionNote === undefined ? current.resolution_note : input.resolutionNote?.trim() || null;
  if ((target === 'RESOLVED' || target === 'WRITTEN_OFF') && (!cause || (resolution?.length ?? 0) < 3)) {
    throw new Error('Cause and a resolution note are required to close a variance case');
  }
  if (input.assignedTo) workerRole(db, input.assignedTo);
  const now = new Date().toISOString();
  const reopening = (current.status === 'RESOLVED' || current.status === 'WRITTEN_OFF') && OPEN_STATUSES.has(target);
  db.transaction(() => {
    db.prepare(`UPDATE variance_cases SET status = ?, assigned_to = ?, cause_code = ?,
        root_cause_notes = ?, resolution_note = ?, resolved_at = ?, resolved_by = ?,
        updated_at = ?, updated_by = ? WHERE id = ?`).run(
      target, input.assignedTo === undefined ? current.assigned_to : input.assignedTo,
      cause, rootNotes, reopening ? null : resolution,
      target === 'RESOLVED' || target === 'WRITTEN_OFF' ? now : null,
      target === 'RESOLVED' || target === 'WRITTEN_OFF' ? input.actorWorkerId : null,
      now, input.actorWorkerId, input.caseId,
    );
    if (input.assignedTo !== undefined && input.assignedTo !== current.assigned_to) appendEvent(db, {
      caseId: input.caseId, eventType: 'ASSIGNED', note: input.assignedTo ? 'Case assigned' : 'Assignment cleared', actorWorkerId: input.actorWorkerId, deviceId: input.deviceId,
    });
    if (cause !== current.cause_code || rootNotes !== current.root_cause_notes) appendEvent(db, {
      caseId: input.caseId, eventType: 'CAUSE_SET', causeCode: cause, note: rootNotes, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId,
    });
    if (target !== current.status) appendEvent(db, {
      caseId: input.caseId,
      eventType: reopening ? 'REOPENED' : target === 'RESOLVED' ? 'RESOLVED' : target === 'WRITTEN_OFF' ? 'WRITTEN_OFF' : 'STATUS_CHANGED',
      fromStatus: current.status, toStatus: target, note: input.resolutionNote,
      causeCode: cause, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId,
    });
    logAudit(db, {
      workerId: input.actorWorkerId, action: target === 'WRITTEN_OFF' ? 'VARIANCE_CASE_WRITTEN_OFF' : reopening ? 'VARIANCE_CASE_REOPENED' : 'VARIANCE_CASE_UPDATED',
      entityType: 'variance_cases', entityId: input.caseId,
      beforeValue: { status: current.status, assignedTo: current.assigned_to, causeCode: current.cause_code },
      afterValue: { status: target, assignedTo: input.assignedTo, causeCode: cause, resolutionNote: resolution }, deviceId: input.deviceId,
    });
  })();
  return getVarianceCase(db, input.caseId, input.actorWorkerId).case;
}

export function addVarianceCaseEvidence(db: DB, input: {
  caseId: string; actorWorkerId: string; deviceId: string; note?: string | null;
  evidenceReference?: string | null; evidenceUrl?: string | null;
}): void {
  requireVarianceSenior(db, input.actorWorkerId);
  const note = input.note?.trim() || null;
  const reference = input.evidenceReference?.trim() || null;
  const url = input.evidenceUrl?.trim() || null;
  if (!note && !reference && !url) throw new Error('Add a note, evidence reference, or evidence URL');
  const row = db.prepare(`SELECT status FROM variance_cases WHERE id = ?`).get(input.caseId) as { status: VarianceCaseStatus } | undefined;
  if (!row) throw new Error('Variance case not found');
  if (!OPEN_STATUSES.has(row.status)) throw new Error('Closed variance cases cannot receive new evidence');
  appendEvent(db, { caseId: input.caseId, eventType: reference || url ? 'EVIDENCE_ADDED' : 'NOTE_ADDED', note, evidenceReference: reference, evidenceUrl: url, actorWorkerId: input.actorWorkerId, deviceId: input.deviceId });
  logAudit(db, { workerId: input.actorWorkerId, action: 'VARIANCE_CASE_EVIDENCE_ADDED', entityType: 'variance_cases', entityId: input.caseId, afterValue: { hasNote: !!note, evidenceReference: reference, evidenceUrl: url }, deviceId: input.deviceId });
}

export function varianceCasePendingCount(db: DB, actorWorkerId: string): { openCount: number; overdueCount: number; unresolvedPesewas: number } {
  return listVarianceCases(db, { actorWorkerId, status: 'OPEN', limit: 1 }).summary;
}

export function updateVarianceCaseSettings(db: DB, input: {
  locationId?: string; tillAmountThresholdPesewas: number; tillThresholdBps: number;
  stockAmountThresholdPesewas: number; stockThresholdBps: number; dueDays: number;
  actorWorkerId: string; deviceId: string; pin: string;
}): VarianceCaseSettings {
  const role = workerRole(db, input.actorWorkerId);
  if (!OWNER_ROLES.has(role)) throw new Error('Only an owner or founder can change variance thresholds');
  const auth = verifyPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!auth.ok) throw new Error(auth.reason === 'LOCKED_OUT' ? `PIN locked until ${auth.lockedUntil}` : 'Fresh owner PIN verification failed');
  const values = [input.tillAmountThresholdPesewas, input.tillThresholdBps, input.stockAmountThresholdPesewas, input.stockThresholdBps, input.dueDays];
  if (!values.every(Number.isInteger) || input.tillAmountThresholdPesewas < 0 || input.stockAmountThresholdPesewas < 0 || input.tillThresholdBps < 0 || input.tillThresholdBps > 10_000 || input.stockThresholdBps < 0 || input.stockThresholdBps > 10_000 || input.dueDays < 1 || input.dueDays > 90) throw new Error('Invalid variance threshold settings');
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  db.prepare(`UPDATE variance_case_settings SET till_amount_threshold_pesewas = ?,
      till_threshold_bps = ?, stock_amount_threshold_pesewas = ?, stock_threshold_bps = ?,
      due_days = ?, updated_at = ?, updated_by = ?, device_id = ? WHERE location_id = ?`).run(
    input.tillAmountThresholdPesewas, input.tillThresholdBps, input.stockAmountThresholdPesewas,
    input.stockThresholdBps, input.dueDays, new Date().toISOString(), input.actorWorkerId,
    input.deviceId, locationId,
  );
  logAudit(db, { workerId: input.actorWorkerId, action: 'VARIANCE_CASE_SETTINGS_UPDATED', entityType: 'variance_case_settings', entityId: locationId, afterValue: values, deviceId: input.deviceId });
  return getVarianceCaseSettings(db, locationId);
}
