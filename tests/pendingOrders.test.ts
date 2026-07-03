// pending_orders: pull-apply from the central orders-feed, plus the local
// accept/reject/fulfil service (Phase 4 workstream C).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { applyOrders, pullOrdersOnce } from '../src/main/sync/pullOrders';
import {
  getPendingOrder, listPendingOrders, markPendingOrderFulfilled, rejectPendingOrder,
} from '../src/main/services/pendingOrders';
import type { OrderPullRow, OrdersPullTransport } from '../src/shared/sync';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

/** fulfilled_sale_id has a real FK to sales(id) — a genuine accepted order
 *  always references a real completed sale, so tests exercising that path
 *  need one too, rather than a bare string that would only pass with
 *  foreign_keys off. */
async function makeRealSaleId(): Promise<string> {
  const shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  const product = db.prepare("SELECT id, walk_in_price_pesewas AS price FROM products LIMIT 1").get() as { id: string; price: number };
  const r = await completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: product.id, quantity: 1, unitPricePesewas: product.price }],
    paymentMethod: 'CASH', cashGivenPesewas: product.price, deviceId: D, shopName: 'T',
  });
  return r.saleId;
}

function fakeOrderRow(overrides: Partial<OrderPullRow['data']> = {}, cursor = 1): OrderPullRow {
  return {
    cursor,
    data: {
      id: 'wa-order-1',
      status: 'CONFIRMED',
      customer_phone: '+233555000000',
      customer_name: 'Demo Customer',
      channel: 'WALK_IN',
      subtotal_pesewas: 1600,
      total_pesewas: 1600,
      quote_expires_at: '2026-07-05T00:00:00.000Z',
      confirmed_at: '2026-07-02T12:00:00.000Z',
      created_by_agent: 'demo-agent',
      created_at: '2026-07-02T11:00:00.000Z',
      lines: [
        { product_id: 'p1', unit_id: null, quantity: 2, unit_price_pesewas: 800, line_total_pesewas: 1600 },
      ],
      ...overrides,
    },
  };
}

describe('applyOrders (pull-apply)', () => {
  it('inserts a confirmed order into pending_orders as CONFIRMED', () => {
    applyOrders(db, [fakeOrderRow()], D);
    const row = db.prepare('SELECT status, customer_phone, total_pesewas, lines_json FROM pending_orders WHERE id = ?')
      .get('wa-order-1') as { status: string; customer_phone: string; total_pesewas: number; lines_json: string };
    expect(row.status).toBe('CONFIRMED');
    expect(row.customer_phone).toBe('+233555000000');
    expect(row.total_pesewas).toBe(1600);
    expect(JSON.parse(row.lines_json)).toHaveLength(1);
  });

  it('does NOT clobber a locally-changed status if the same order is re-pulled', () => {
    applyOrders(db, [fakeOrderRow()], D);
    rejectPendingOrder(db, { orderId: 'wa-order-1', reason: 'test', workerId: W, deviceId: D });
    // Simulate a re-pulled page landing again (retried cursor, crash mid-batch).
    applyOrders(db, [fakeOrderRow()], D);
    const row = db.prepare('SELECT status FROM pending_orders WHERE id = ?').get('wa-order-1') as { status: string };
    expect(row.status).toBe('REJECTED'); // NOT reset back to CONFIRMED
  });
});

describe('pullOrdersOnce', () => {
  it('advances the cursor and applies rows from the transport', async () => {
    const transport: OrdersPullTransport = {
      fetchOrders: async (since) => {
        expect(since).toBe(0); // first call starts at 0
        return { rows: [fakeOrderRow({}, 5)], cursor: 5 };
      },
    };
    const result = await pullOrdersOnce(db, transport);
    expect(result.applied).toBe(1);
    expect(result.cursor).toBe(5);
    expect(getPendingOrder(db, 'wa-order-1')).not.toBeNull();
  });

  it('persists the cursor so a second call starts where the first left off', async () => {
    let calls = 0;
    const transport: OrdersPullTransport = {
      fetchOrders: async (since) => {
        calls++;
        if (calls === 1) { expect(since).toBe(0); return { rows: [fakeOrderRow({}, 5)], cursor: 5 }; }
        expect(since).toBe(5);
        return { rows: [], cursor: 5 };
      },
    };
    await pullOrdersOnce(db, transport);
    const second = await pullOrdersOnce(db, transport);
    expect(second.applied).toBe(0);
    expect(calls).toBe(2);
  });
});

describe('listPendingOrders / getPendingOrder', () => {
  it('lists CONFIRMED orders by default, oldest first', () => {
    applyOrders(db, [fakeOrderRow({ id: 'o1' }, 1)], D);
    applyOrders(db, [fakeOrderRow({ id: 'o2' }, 2)], D);
    const orders = listPendingOrders(db);
    expect(orders.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(orders[0]?.lineCount).toBe(1);
  });

  it('getPendingOrder returns full line detail with local catalog names resolved', () => {
    const product = db.prepare('SELECT id, name FROM products LIMIT 1').get() as { id: string; name: string };
    applyOrders(db, [fakeOrderRow({
      lines: [{ product_id: product.id, unit_id: null, quantity: 2, unit_price_pesewas: 800, line_total_pesewas: 1600 }],
    })], D);
    const order = getPendingOrder(db, 'wa-order-1');
    expect(order?.lines).toEqual([
      { productId: product.id, productName: product.name, unitId: null, unitName: 'UNIT', quantity: 2, unitPricePesewas: 800, lineTotalPesewas: 1600 },
    ]);
  });

  it('falls back to a placeholder name for a product no longer in the local catalog, without throwing', () => {
    applyOrders(db, [fakeOrderRow({
      lines: [{ product_id: 'ghost-product', unit_id: null, quantity: 1, unit_price_pesewas: 500, line_total_pesewas: 500 }],
    })], D);
    const order = getPendingOrder(db, 'wa-order-1');
    expect(order?.lines[0]?.productName).toBe('Unknown product');
  });

  it('returns null for an unknown order', () => {
    expect(getPendingOrder(db, 'nope')).toBeNull();
  });
});

describe('rejectPendingOrder', () => {
  it('rejects a CONFIRMED order with a reason and logs an audit row', () => {
    applyOrders(db, [fakeOrderRow()], D);
    rejectPendingOrder(db, { orderId: 'wa-order-1', reason: 'Out of stock', workerId: W, deviceId: D });
    const order = getPendingOrder(db, 'wa-order-1');
    expect(order?.status).toBe('REJECTED');
    expect(order?.rejectReason).toBe('Out of stock');
    const audit = db.prepare(
      `SELECT action FROM audit_log WHERE entity_id = ? AND entity_type = 'pending_orders'`,
    ).get('wa-order-1') as { action: string } | undefined;
    expect(audit?.action).toBe('WHATSAPP_ORDER_REJECTED');
  });

  it('requires a non-empty reason', () => {
    applyOrders(db, [fakeOrderRow()], D);
    expect(() => rejectPendingOrder(db, { orderId: 'wa-order-1', reason: '   ', workerId: W, deviceId: D }))
      .toThrow(/reason is required/);
  });

  it('rejects an already-decided order', () => {
    applyOrders(db, [fakeOrderRow()], D);
    rejectPendingOrder(db, { orderId: 'wa-order-1', reason: 'first', workerId: W, deviceId: D });
    expect(() => rejectPendingOrder(db, { orderId: 'wa-order-1', reason: 'second', workerId: W, deviceId: D }))
      .toThrow(/cannot reject/);
  });

  it('throws for an unknown order', () => {
    expect(() => rejectPendingOrder(db, { orderId: 'nope', reason: 'x', workerId: W, deviceId: D }))
      .toThrow(/not found/);
  });
});

describe('markPendingOrderFulfilled', () => {
  it('marks a CONFIRMED order FULFILLED with the sale id and logs an audit row', async () => {
    applyOrders(db, [fakeOrderRow()], D);
    const saleId = await makeRealSaleId();
    markPendingOrderFulfilled(db, { orderId: 'wa-order-1', saleId, workerId: W, deviceId: D });
    const order = getPendingOrder(db, 'wa-order-1');
    expect(order?.status).toBe('FULFILLED');
    expect(order?.fulfilledSaleId).toBe(saleId);
    const audit = db.prepare(
      `SELECT action FROM audit_log WHERE entity_id = ? AND entity_type = 'pending_orders'`,
    ).get('wa-order-1') as { action: string } | undefined;
    expect(audit?.action).toBe('WHATSAPP_ORDER_FULFILLED');
  });

  it('cannot mark an already-rejected order fulfilled', async () => {
    applyOrders(db, [fakeOrderRow()], D);
    rejectPendingOrder(db, { orderId: 'wa-order-1', reason: 'x', workerId: W, deviceId: D });
    const saleId = await makeRealSaleId();
    expect(() => markPendingOrderFulfilled(db, { orderId: 'wa-order-1', saleId, workerId: W, deviceId: D }))
      .toThrow(/cannot mark fulfilled/);
  });

  it('enqueues the status change onto the outbox so it syncs up', async () => {
    applyOrders(db, [fakeOrderRow()], D);
    const saleId = await makeRealSaleId();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = ?').get('pending_orders') as { n: number }).n;
    markPendingOrderFulfilled(db, { orderId: 'wa-order-1', saleId, workerId: W, deviceId: D });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = ?').get('pending_orders') as { n: number }).n;
    expect(after).toBe(before + 1);
    const row = db.prepare(
      `SELECT op FROM sync_outbox WHERE table_name = 'pending_orders' ORDER BY seq DESC LIMIT 1`,
    ).get() as { op: string };
    expect(row.op).toBe('UPDATE');
  });
});
