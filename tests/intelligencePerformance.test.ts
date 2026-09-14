import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { getIntelligenceBrief, refreshIntelligence } from '../src/main/services/intelligence';

const enabled = process.env['COUNTER_INTELLIGENCE_PERF'] === '1';
const perfIt = enabled ? it : it.skip;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
let db: ReturnType<typeof Database>;

describe('intelligence operational budgets (100,000-sale fixture)', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = MEMORY');
    db.pragma('synchronous = OFF');
    runMigrations(db, migrationsDir);
    runSeed(db, { includeDevFixtures: true });
    const product = db.prepare('SELECT id, cost_price_pesewas AS cost, walk_in_price_pesewas AS price FROM products LIMIT 1')
      .get() as { id: string; cost: number; price: number };
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO shifts (id, worker_id, location_id, opened_at, closed_at, shift_type,
      opening_cash_pesewas, closing_cash_counted_pesewas, closing_cash_expected_pesewas,
      cash_variance_pesewas, created_by, updated_by, device_id)
      VALUES ('perf-shift', 'dev-counter-1', 'loc-main-counter', ?, ?, 'COUNTER',
        0, 0, 0, 0, 'dev-counter-1', 'dev-counter-1', 'perf')`).run(at, at);
    const sale = db.prepare(`INSERT INTO sales (id, shift_id, worker_id, location_id, channel,
      subtotal_pesewas, discount_pesewas, total_pesewas, payment_method, created_at,
      created_by, updated_by, device_id)
      VALUES (?, 'perf-shift', 'dev-counter-1', 'loc-main-counter', 'WALK_IN', ?, 0, ?, 'CASH', ?,
        'dev-counter-1', 'dev-counter-1', 'perf')`);
    const line = db.prepare(`INSERT INTO sale_lines (id, sale_id, product_id, quantity,
      unit_price_pesewas, unit_cost_pesewas, line_total_pesewas, margin_pesewas,
      line_cogs_pesewas, list_price_pesewas, created_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'dev-counter-1', 'dev-counter-1', 'perf')`);
    db.transaction(() => {
      for (let index = 0; index < 100_000; index++) {
        const id = `perf-sale-${index}`;
        sale.run(id, product.price, product.price, at);
        line.run(`perf-line-${index}`, id, product.id, product.price, product.cost,
          product.price, product.price - product.cost, product.cost, product.price, at);
      }
      db.prepare('DELETE FROM sync_outbox').run();
    })();
  }, 120_000);
  afterAll(() => db?.close());

  perfIt('keeps exact event evaluation below 250ms', () => {
    const start = performance.now();
    refreshIntelligence(db, { actorWorkerId: 'dev-supervisor-1', deviceId: 'perf',
      trigger: 'EVENT', exactOnly: true });
    expect(performance.now() - start).toBeLessThan(250);
  });

  perfIt('keeps persisted Home brief reads below 100ms', () => {
    const start = performance.now();
    getIntelligenceBrief(db, { workerId: 'dev-supervisor-1', role: 'SUPERVISOR' }, 'perf');
    expect(performance.now() - start).toBeLessThan(100);
  });

  perfIt('keeps the predictive daily suite below five seconds', () => {
    db.prepare("UPDATE device_config SET value = 'PREDICTIVE' WHERE key = 'intelligence_stage'").run();
    const start = performance.now();
    refreshIntelligence(db, { actorWorkerId: 'dev-supervisor-1', deviceId: 'perf', trigger: 'MANUAL' });
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
