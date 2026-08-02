// VAT-on integration: a real sale records the Ghana VAT breakdown and the
// receipt prints it. Vitest doesn't apply the Vite `define`, so VAT_ENABLED
// falls back to process.env.COUNTER_VAT — run this file with COUNTER_VAT=1:
//
//   COUNTER_VAT=1 npx vitest --run tests/vat-sale.test.ts
//
// (The default `npm test` runs without the flag, where these are skipped, so the
// no-VAT receipt assertions in the rest of the suite stay valid.)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { formatReceipt } from '../src/main/printer/receipt';
import { createSaleVoidRequest, reviewSaleVoidRequest } from '../src/main/services/voids';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const VAT_ON = process.env['COUNTER_VAT'] === '1';
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
  const products = db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>;
  for (const p of products) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
         worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
         created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, 100, 'dev-supervisor-1', p.cost_price_pesewas, 100 * p.cost_price_pesewas, 'dev-supervisor-1', W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => {
  _resetPrinter();
  db.close();
});

describe.runIf(VAT_ON)('VAT-enabled sale (Act 1151, inclusive)', () => {
  it('records the extracted VAT breakdown summing to the unchanged total', async () => {
    const star = db.prepare(`SELECT id FROM products WHERE sku = 'STAR-330'`).get() as { id: string };
    // 15 × GH¢8.00 = GH¢120.00 inclusive.
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 15, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 12000,
      deviceId: D, shopName: 'TEST',
    });

    expect(r.totalPesewas).toBe(12000); // unchanged — inclusive

    const row = db.prepare(
      'SELECT total_pesewas, taxable_pesewas, vat_pesewas, nhil_pesewas, getfund_pesewas FROM sales WHERE id = ?',
    ).get(r.saleId) as Record<string, number>;

    expect(row).toEqual({
      total_pesewas: 12000,
      taxable_pesewas: 10000,
      vat_pesewas: 1500,
      nhil_pesewas: 250,
      getfund_pesewas: 250,
    });
    // The identity that makes the books honest.
    expect(row.taxable_pesewas + row.vat_pesewas + row.nhil_pesewas + row.getfund_pesewas)
      .toBe(row.total_pesewas);
  });

  it('prints the VAT block on the receipt', async () => {
    const star = db.prepare(`SELECT id FROM products WHERE sku = 'STAR-330'`).get() as { id: string };
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 15, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 12000,
      deviceId: D, shopName: 'TEST',
    });
    const text = formatReceipt(r.receipt).join('\n');
    expect(text).toContain('TOTAL includes VAT');
    expect(text).toContain('VAT 15%');
    expect(text).toContain('NHIL 2.5%');
    expect(text).toContain('GETFund 2.5%');
    expect(text).toContain('Taxable (excl)');
  });

  it('queues and atomically approves a void with the exact VAT effect visible to the reviewer', async () => {
    const star = db.prepare(`SELECT id FROM products WHERE sku = 'STAR-330'`).get() as { id: string };
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 15, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 12000,
      deviceId: D, shopName: 'TEST',
    });
    const request = createSaleVoidRequest(db, {
      saleId: r.saleId, reason: 'Customer order was duplicated', requesterWorkerId: W, deviceId: D,
    });
    expect(request.accountingEffect).toMatchObject({
      netSalesPesewas: 10000, vatPesewas: 1500, nhilPesewas: 250, getfundPesewas: 250,
    });
    const approved = reviewSaleVoidRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: 'dev-supervisor-1', deviceId: D,
    });
    expect(approved.status).toBe('APPROVED');
    expect(db.prepare('SELECT voided FROM sales WHERE id = ?').get(r.saleId)).toMatchObject({ voided: 1 });
  });
});
