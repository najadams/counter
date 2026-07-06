import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { getCustomerIntelligence } from '../src/main/services/customerIntelligence';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare(`UPDATE workers SET role = 'OWNER' WHERE id = ?`).run(W);
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 0, deviceId: D }).shiftId;
});
afterEach(() => { db.close(); });

function product() {
  return db.prepare("SELECT id, walk_in_price_pesewas AS price, cost_price_pesewas AS cost FROM products WHERE sku = 'STAR-330'")
    .get() as { id: string; price: number; cost: number };
}

function addCustomer(id: string, name: string, phone: string) {
  db.prepare(
    `INSERT INTO customers (
       id, display_name, phone, customer_type, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, 'WALK_IN_REGULAR', ?, ?, ?)`,
  ).run(id, name, phone, W, W, D);
}

function addSale(id: string, customerId: string, date: string, qty: number) {
  const p = product();
  const total = p.price * qty;
  db.prepare(
    `INSERT INTO sales (
       id, shift_id, worker_id, location_id, customer_id, channel,
       subtotal_pesewas, total_pesewas, payment_method,
       created_at, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, 'WALK_IN', ?, ?, 'CASH', ?, ?, ?, ?)`,
  ).run(id, shiftId, W, L, customerId, total, total, `${date}T12:00:00.000Z`, W, W, D);
  db.prepare(
    `INSERT INTO sale_lines (
       id, sale_id, product_id, quantity, unit_price_pesewas, unit_cost_pesewas,
       line_total_pesewas, margin_pesewas, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${id}-line`, id, p.id, qty, p.price, p.cost, total, (p.price - p.cost) * qty, W, W, D);
}

describe('customer intelligence reports', () => {
  it('reports inactivity, purchase frequency, top products, ABC class, and monthly value', () => {
    addCustomer('cust-a', 'Alpha Bar', '+233555000101');
    addCustomer('cust-b', 'Beta Shop', '+233555000102');
    addCustomer('cust-c', 'Cold Customer', '+233555000103');
    addSale('sale-a-1', 'cust-a', '2026-07-01', 10);
    addSale('sale-a-2', 'cust-a', '2026-07-05', 10);
    addSale('sale-b-1', 'cust-b', '2026-06-20', 2);

    const report = getCustomerIntelligence(db, {
      actorWorkerId: W,
      asOfDateISO: '2026-07-10',
      inactiveDays: 10,
    });

    const alpha = report.rows.find((r) => r.customerId === 'cust-a');
    expect(alpha?.purchaseCount).toBe(2);
    expect(alpha?.purchaseFrequencyDays).toBe(4);
    expect(alpha?.daysInactive).toBe(5);
    expect(alpha?.monthlyValuePesewas).toBeGreaterThan(0);
    expect(alpha?.abcClass).toBe('A');

    expect(report.inactive.map((r) => r.customerId)).toContain('cust-b');
    expect(report.inactive.map((r) => r.customerId)).toContain('cust-c');
    const top = report.topProducts.find((r) => r.customerId === 'cust-a');
    expect(top?.unitsSold).toBe(20);
    expect(top?.revenuePesewas).toBe(alpha?.totalValuePesewas);
  });
});
