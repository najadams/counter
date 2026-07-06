import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { updateProduct } from '../src/main/services/productsAdmin';
import { receiveStock } from '../src/main/services/stockReceipts';
import {
  getLandedCostAllocations,
  getPriceHistory,
  getPriceIntelligence,
} from '../src/main/services/priceIntelligence';
import { _resetPrinter, _setPrinter } from '../src/main/printer/printer';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare(`UPDATE workers SET role = 'OWNER' WHERE id = ?`).run(W);
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

function star() {
  return db.prepare("SELECT id, walk_in_price_pesewas AS price FROM products WHERE sku = 'STAR-330'")
    .get() as { id: string; price: number };
}
function supplierId() {
  return (db.prepare('SELECT id FROM suppliers LIMIT 1').get() as { id: string }).id;
}

describe('price intelligence', () => {
  it('records user/date price history and surfaces competitor plus legacy minimum gaps', () => {
    const p = star();
    updateProduct(db, {
      productId: p.id,
      fields: {
        walkInPricePesewas: 900,
        minimumPricePesewas: 850,
        competitorPricePesewas: 800,
        competitorName: 'Shop next door',
        competitorCheckedAt: '2026-07-05T09:00:00.000Z',
        priceChangeReason: 'market check',
      },
      actorWorkerId: W,
      deviceId: D,
    });

    const history = getPriceHistory(db, { actorWorkerId: W, productId: p.id });
    expect(history.rows.some((r) => r.fieldName === 'WALK_IN' && r.oldPesewas === p.price && r.newPesewas === 900)).toBe(true);
    expect(history.rows.some((r) => r.fieldName === 'MINIMUM' && r.newPesewas === 850)).toBe(true);
    expect(history.rows[0]?.changedBy).toBeTruthy();

    const intel = getPriceIntelligence(db, { actorWorkerId: W }).rows.find((r) => r.productId === p.id);
    expect(intel?.minimumPricePesewas).toBe(850);
    expect(intel?.competitorPricePesewas).toBe(800);
    expect(intel?.walkInVsCompetitorPesewas).toBe(100);
  });

  it('does not use the legacy minimum price field as a checkout hard floor', async () => {
    const p = star();
    updateProduct(db, {
      productId: p.id,
      fields: { minimumPricePesewas: p.price + 100, priceChangeReason: 'protect margin' },
      actorWorkerId: W,
      deviceId: D,
    });
    const shiftId = openShift(db, {
      workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 0, deviceId: D,
    }).shiftId;
    db.prepare(
      `INSERT INTO stock_movements (
         id, product_id, location_id, quantity, reason_code, worker_id,
         unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
         created_by, updated_by, device_id
       ) VALUES ('sm-price-floor', ?, ?, 10, 'OPENING_STOCK', ?, 600, 6000, ?, ?, ?, ?)`,
    ).run(p.id, L, SUP, SUP, W, W, D);

    const sale = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Owner', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: p.price }],
      paymentMethod: 'CASH', cashGivenPesewas: p.price, deviceId: D, shopName: 'T',
    });

    expect(sale.receipt.totalPesewas).toBe(p.price);
  });

  it('allocates transport and loading costs onto supplier invoice lines', () => {
    const p = star();
    const receipt = receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      supplierInvoiceNumber: 'INV-LANDED-1',
      transportCostPesewas: 300,
      loadingCostPesewas: 200,
      lines: [{ productId: p.id, quantity: 10, unitCostPesewas: 600 }],
      deviceId: D,
    });

    expect(receipt.totalValuePesewas).toBe(6000);
    expect(receipt.totalPayablePesewas).toBe(6500);
    const line = getLandedCostAllocations(db, { actorWorkerId: W }).rows[0];
    expect(line?.allocatedTransportCostPesewas).toBe(300);
    expect(line?.allocatedLoadingCostPesewas).toBe(200);
    expect(line?.landedLineTotalPesewas).toBe(6500);
  });
});
