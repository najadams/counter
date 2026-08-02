import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { getConcentrationReport } from '../src/main/services/managementReports';

const enabled = process.env.RUN_MANAGEMENT_PERFORMANCE === '1';
const describePerformance = enabled ? describe : describe.skip;

describePerformance('owner management pack 100,000-sale performance', () => {
  const db = new Database(':memory:');
  const locationId = 'loc-main-counter';
  const ownerId = 'dev-supervisor-1';
  const cashierId = 'dev-counter-1';
  const deviceId = 'management-performance';
  const date = new Date().toISOString().slice(0, 10);
  let loadMs = 0;

  beforeAll(() => {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = MEMORY');
    db.pragma('synchronous = OFF');
    runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations'));
    runSeed(db, { includeDevFixtures: true });
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(ownerId);
    const shiftId = openShift(db, {
      workerId: cashierId, locationId, shiftType: 'COUNTER',
      openingCashPesewas: 0, deviceId,
    }).shiftId;
    const productId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
    const started = performance.now();
    db.exec(`
      WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000
      )
      INSERT INTO sales (
        id, shift_id, worker_id, location_id, customer_id, channel,
        subtotal_pesewas, discount_pesewas, total_pesewas, payment_method,
        is_credit, voided, printer_failed, created_at, created_by,
        updated_at, updated_by, device_id
      )
      SELECT 'perf-sale-' || i, '${shiftId}', '${cashierId}', '${locationId}', NULL, 'WALK_IN',
             1000, 0, 1000, 'CASH', 0, 0, 0,
             '${date}T12:00:00.000Z', '${cashierId}', '${date}T12:00:00.000Z',
             '${cashierId}', '${deviceId}'
        FROM n;

      WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000
      )
      INSERT INTO sale_lines (
        id, sale_id, product_id, quantity, unit_price_pesewas,
        unit_cost_pesewas, line_total_pesewas, margin_pesewas,
        line_cogs_pesewas, created_at, created_by, updated_at, updated_by, device_id
      )
      SELECT 'perf-line-' || i, 'perf-sale-' || i, '${productId}', 1, 1000,
             600, 1000, 400, 600, '${date}T12:00:00.000Z', '${cashierId}',
             '${date}T12:00:00.000Z', '${cashierId}', '${deviceId}'
        FROM n;

      WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000
      )
      INSERT INTO sale_payments (
        id, sale_id, payment_method, amount_pesewas, cash_given_pesewas,
        change_pesewas, display_order, created_at, created_by,
        updated_at, updated_by, device_id
      )
      SELECT 'perf-payment-' || i, 'perf-sale-' || i, 'CASH', 1000, 1000,
             0, 0, '${date}T12:00:00.000Z', '${cashierId}',
             '${date}T12:00:00.000Z', '${cashierId}', '${deviceId}'
        FROM n;
    `);
    loadMs = performance.now() - started;
  }, 120_000);

  afterAll(() => db.close());

  it('builds the concentration report in under two seconds', () => {
    const started = performance.now();
    const report = getConcentrationReport(db, {
      actorWorkerId: ownerId, pin: '9999', deviceId, locationId,
      fromDate: date, toDate: date,
    });
    const reportMs = performance.now() - started;
    expect(report.dimensions.find((row) => row.dimension === 'PRODUCT')?.totalPesewas)
      .toBe(40_000_000);
    expect(reportMs).toBeLessThan(2_000);
    expect(loadMs).toBeGreaterThan(0);
  }, 10_000);
});
