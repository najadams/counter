import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { computeAndCloseShift, openShift, submitClosingCount } from '../src/main/services/shifts';
import { reconcileCustomerBalance } from '../src/main/services/customerCredit';
import {
  addVarianceCaseEvidence,
  getVarianceCase,
  getVarianceCaseSettings,
  listVarianceCases,
  maybeOpenFinancialAccountVarianceCase,
  maybeOpenStocktakeVarianceCases,
  openVarianceCase,
  updateVarianceCase,
  updateVarianceCaseSettings,
} from '../src/main/services/varianceCases';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const COUNTER = 'dev-counter-1';
const SENIOR = 'dev-supervisor-1';
const LOCATION = 'loc-main-counter';
const DEVICE = 'variance-test-device';
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => db.close());

describe('variance investigations', () => {
  it('opens a till case only when the configured materiality threshold is reached', () => {
    const first = openShift(db, { workerId: COUNTER, locationId: LOCATION, shiftType: 'COUNTER', openingCashPesewas: 5_000, deviceId: DEVICE });
    submitClosingCount(db, first.shiftId, 4_200, COUNTER, DEVICE);
    computeAndCloseShift(db, first.shiftId, COUNTER, DEVICE);
    expect((db.prepare('SELECT COUNT(*) AS n FROM variance_cases').get() as { n: number }).n).toBe(0);

    const second = openShift(db, { workerId: COUNTER, locationId: LOCATION, shiftType: 'COUNTER', openingCashPesewas: 5_000, deviceId: DEVICE });
    submitClosingCount(db, second.shiftId, 3_800, COUNTER, DEVICE);
    const closed = computeAndCloseShift(db, second.shiftId, COUNTER, DEVICE);
    expect(closed.variancePesewas).toBe(-1_200);
    const row = db.prepare(`SELECT case_type, amount_pesewas, expected_pesewas, observed_pesewas,
      subject_worker_id, source_id FROM variance_cases`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ case_type: 'TILL_CASH', amount_pesewas: -1_200, expected_pesewas: 5_000, observed_pesewas: 3_800, subject_worker_id: COUNTER, source_id: second.shiftId });
  });

  it('creates account and stocktake cases idempotently using their source records', () => {
    const account = db.prepare(`SELECT id, name FROM financial_accounts WHERE kind = 'MOMO' LIMIT 1`).get() as { id: string; name: string };
    const a = maybeOpenFinancialAccountVarianceCase(db, {
      reconciliationId: 'recon-1', locationId: LOCATION, financialAccountId: account.id,
      accountName: account.name, expectedPesewas: 20_000, observedPesewas: 18_500,
      variancePesewas: -1_500, actorWorkerId: SENIOR, deviceId: DEVICE,
    });
    const duplicate = maybeOpenFinancialAccountVarianceCase(db, {
      reconciliationId: 'recon-1', locationId: LOCATION, financialAccountId: account.id,
      accountName: account.name, expectedPesewas: 20_000, observedPesewas: 18_500,
      variancePesewas: -1_500, actorWorkerId: SENIOR, deviceId: DEVICE,
    });
    expect(a?.created).toBe(true); expect(duplicate).toMatchObject({ caseId: a?.caseId, created: false });

    db.prepare(`INSERT INTO stocktake_events (id, location_id, status, started_by, completed_at,
      supervisor_approval_id, created_by, updated_by, device_id)
      VALUES ('st-case', ?, 'COMPLETED', ?, '2026-08-02T00:00:00.000Z', ?, ?, ?, ?)`)
      .run(LOCATION, COUNTER, SENIOR, COUNTER, COUNTER, DEVICE);
    const cases = maybeOpenStocktakeVarianceCases(db, {
      eventId: 'st-case', locationId: LOCATION, expectedStockValuePesewas: 1_000_000,
      lossPesewas: 12_000, foundPesewas: 9_000, actorWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(cases).toHaveLength(1);
    expect(db.prepare("SELECT amount_pesewas AS amount FROM variance_cases WHERE case_type = 'STOCK_SHORTAGE'").get()).toMatchObject({ amount: -12_000 });
  });

  it('turns customer cache drift into a case while healing the cache', () => {
    db.prepare(`INSERT INTO customers (id, display_name, phone, customer_type, current_balance_pesewas, created_by, updated_by, device_id)
      VALUES ('cust-drift', 'Drift Customer', '+233244009999', 'WALK_IN_REGULAR', 2500, ?, ?, ?)`).run(COUNTER, COUNTER, DEVICE);
    const result = reconcileCustomerBalance(db, 'cust-drift', { actorWorkerId: SENIOR, deviceId: DEVICE, sourceId: 'manual-drift-1' });
    expect(result).toEqual({ previousCached: 2_500, newCached: 0, driftPesewas: 2_500 });
    expect(db.prepare("SELECT case_type, customer_id, amount_pesewas FROM variance_cases WHERE source_id = 'manual-drift-1'").get()).toMatchObject({ case_type: 'CUSTOMER_BALANCE', customer_id: 'cust-drift', amount_pesewas: 2_500 });
  });

  it('keeps an append-only timeline and enforces senior resolution and owner write-off', () => {
    const opened = openVarianceCase(db, { caseType: 'MANUAL', title: 'Unexplained till note', amountPesewas: -2_000, sourceType: 'TEST', sourceId: 'case-1', actorWorkerId: COUNTER, deviceId: DEVICE });
    expect(() => updateVarianceCase(db, { caseId: opened.caseId, status: 'INVESTIGATING', actorWorkerId: COUNTER, deviceId: DEVICE })).toThrow(/Supervisor/);
    addVarianceCaseEvidence(db, { caseId: opened.caseId, note: 'Cash count sheet checked', evidenceReference: 'COUNT-22', actorWorkerId: SENIOR, deviceId: DEVICE });
    updateVarianceCase(db, { caseId: opened.caseId, status: 'INVESTIGATING', assignedTo: SENIOR, actorWorkerId: SENIOR, deviceId: DEVICE });
    expect(() => updateVarianceCase(db, { caseId: opened.caseId, status: 'RESOLVED', actorWorkerId: SENIOR, deviceId: DEVICE })).toThrow(/Cause/);
    updateVarianceCase(db, { caseId: opened.caseId, status: 'RESOLVED', causeCode: 'COUNTING_ERROR', resolutionNote: 'Recount confirmed the correct till amount', actorWorkerId: SENIOR, deviceId: DEVICE });
    const detail = getVarianceCase(db, opened.caseId, SENIOR);
    expect(detail.case.status).toBe('RESOLVED');
    expect(detail.events.map((event) => event.eventType)).toEqual(expect.arrayContaining(['OPENED', 'EVIDENCE_ADDED', 'ASSIGNED', 'CAUSE_SET', 'RESOLVED']));
    expect(() => db.prepare('DELETE FROM variance_case_events WHERE case_id = ?').run(opened.caseId)).toThrow(/cannot be deleted/);
    expect(() => db.prepare('DELETE FROM variance_cases WHERE id = ?').run(opened.caseId)).toThrow(/cannot be deleted/);

    const residual = openVarianceCase(db, { caseType: 'MANUAL', title: 'Residual MoMo difference', amountPesewas: -5_000, sourceType: 'TEST', sourceId: 'case-2', actorWorkerId: SENIOR, deviceId: DEVICE });
    expect(() => updateVarianceCase(db, { caseId: residual.caseId, status: 'WRITTEN_OFF', causeCode: 'BANK_MOMO_TIMING', resolutionNote: 'Owner accepts residual', pin: '9999', actorWorkerId: SENIOR, deviceId: DEVICE })).toThrow(/owner or founder/);
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SENIOR);
    expect(updateVarianceCase(db, { caseId: residual.caseId, status: 'WRITTEN_OFF', causeCode: 'BANK_MOMO_TIMING', resolutionNote: 'Owner accepts residual', pin: '9999', actorWorkerId: SENIOR, deviceId: DEVICE }).status).toBe('WRITTEN_OFF');
  });

  it('lets an owner tune future thresholds with a fresh PIN and captures sync changes', () => {
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SENIOR);
    const updated = updateVarianceCaseSettings(db, {
      tillAmountThresholdPesewas: 2_000, tillThresholdBps: 75,
      stockAmountThresholdPesewas: 10_000, stockThresholdBps: 150,
      dueDays: 5, actorWorkerId: SENIOR, deviceId: DEVICE, pin: '9999',
    });
    expect(updated).toMatchObject({ tillAmountThresholdPesewas: 2_000, tillThresholdBps: 75, stockAmountThresholdPesewas: 10_000, stockThresholdBps: 150, dueDays: 5 });
    expect(getVarianceCaseSettings(db)).toEqual(updated);
    const operations = db.prepare(`SELECT table_name AS tableName, op FROM sync_outbox
      WHERE table_name LIKE 'variance_case%' ORDER BY seq`).all() as Array<{ tableName: string; op: string }>;
    expect(operations).toEqual(expect.arrayContaining([{ tableName: 'variance_case_settings', op: 'UPDATE' }]));
    expect(listVarianceCases(db, { actorWorkerId: SENIOR }).summary.openCount).toBe(0);
  });
});
