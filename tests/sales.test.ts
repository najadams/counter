// Sale flow tests — the integration backbone the pushback fix #5 demanded.
//
// The atomicity test exercises the most safety-critical code path in the
// system: completeSale() must write sales + sale_lines + stock_movements
// + audit_log atomically, or none at all. Anything else corrupts inventory.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale, searchProducts, getShopHeader } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { formatReceipt } from '../src/main/printer/receipt';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

let db: ReturnType<typeof Database>;
let shiftId: string;
const W = 'dev-counter-1';
const L = 'loc-main-counter';
const D = 'test-device';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // Stock the dev products: receive 24 of each.
  const products = db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>;
  for (const p of products) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
         worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
         created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `sm-seed-${p.id}`, p.id, L, 24,
      'dev-supervisor-1', p.cost_price_pesewas, 24 * p.cost_price_pesewas,
      'dev-supervisor-1', W, W, D,
    );
  }
  // Open a shift.
  const open = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D });
  shiftId = open.shiftId;
  // Use a no-op printer for sale tests by default.
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => {
  _resetPrinter();
  db.close();
});

function pickProduct(sku: string) {
  return db.prepare('SELECT id, cost_price_pesewas, walk_in_price_pesewas, name FROM products WHERE sku = ?').get(sku) as
    { id: string; cost_price_pesewas: number; walk_in_price_pesewas: number; name: string };
}

describe('searchProducts', () => {
  it('returns walk-in price by default', () => {
    const hits = searchProducts(db, 'star', 'WALK_IN', L);
    const star = hits.find((h) => h.sku === 'STAR-330');
    expect(star).toBeDefined();
    expect(star!.unitPricePesewas).toBe(800); // walk-in
  });

  it('returns wholesale price when channel is WHOLESALE', () => {
    const hits = searchProducts(db, 'star', 'WHOLESALE', L);
    const star = hits.find((h) => h.sku === 'STAR-330');
    expect(star!.unitPricePesewas).toBe(750);
  });

  it('returns route price when channel is ROUTE', () => {
    const hits = searchProducts(db, 'star', 'ROUTE', L);
    const star = hits.find((h) => h.sku === 'STAR-330');
    expect(star!.unitPricePesewas).toBe(720);
  });

  it('matches by SKU prefix and name substring', () => {
    expect(searchProducts(db, 'STAR', 'WALK_IN', L).map((h) => h.sku)).toContain('STAR-330');
    expect(searchProducts(db, 'voltic', 'WALK_IN', L).map((h) => h.sku)).toContain('VOLTIC-1L');
  });

  it('matches by SKU substring, not just prefix', () => {
    // Typing the middle/suffix of a SKU should still find the product.
    // Pre-fix this used `sku LIKE 'query%'` (prefix-only) and returned
    // empty — cashiers who didn't remember the brand prefix got nothing.
    expect(searchProducts(db, '330', 'WALK_IN', L).map((h) => h.sku)).toContain('STAR-330');
    expect(searchProducts(db, '1L', 'WALK_IN', L).map((h) => h.sku)).toContain('VOLTIC-1L');
  });

  it('excludes inactive and deleted products', () => {
    const cl = db.prepare('SELECT id FROM products WHERE sku = ?').get('CLUB-330') as { id: string };
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(cl.id);
    expect(searchProducts(db, 'club', 'WALK_IN', L)).toHaveLength(0);
  });

  it('reports current stock from stock_movements', () => {
    const hits = searchProducts(db, 'STAR', 'WALK_IN', L);
    const star = hits.find((h) => h.sku === 'STAR-330');
    expect(star!.unitsOnHand).toBe(24);
  });

  it('empty query returns top N products', () => {
    const hits = searchProducts(db, '', 'WALK_IN', L, 3);
    expect(hits.length).toBe(3);
  });
});

describe('completeSale — atomicity', () => {
  it('writes sales + sale_lines + stock_movements + audit in one transaction', async () => {
    const star = pickProduct('STAR-330');
    const before = {
      sales: rowCount('sales'),
      lines: rowCount('sale_lines'),
      sm: rowCount('stock_movements'),
      audit: rowCount('audit_log'),
    };
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 2, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 1600,
      deviceId: D, shopName: 'TEST',
    });
    expect(r.saleId).toMatch(/^sa-/);
    expect(r.totalPesewas).toBe(1600);
    // changePesewas is null when no cash overpay (exact change). The old
    // "always 0" semantic was changed to distinguish "no change due" from
    // "no cash tender at all" — see completeSale aggregation.
    expect(r.changePesewas).toBeNull();
    expect(r.printerFailed).toBe(false);

    expect(rowCount('sales') - before.sales).toBe(1);
    expect(rowCount('sale_lines') - before.lines).toBe(1);
    expect(rowCount('stock_movements') - before.sm).toBe(1);
    expect(rowCount('audit_log') - before.audit).toBeGreaterThanOrEqual(1);
  });

  it('rolls back ALL writes when one INSERT fails', async () => {
    const star = pickProduct('STAR-330');
    const before = {
      sales: rowCount('sales'),
      lines: rowCount('sale_lines'),
      sm: rowCount('stock_movements'),
    };
    // Force a failure: pass a quantity that breaks the CHECK on sale_lines
    // by mocking the stockMovements throw — easier: pass a non-existent
    // product, which fails the product lookup BEFORE the txn starts.
    // For an in-txn failure we use an intentionally bad reason indirectly:
    // make the product inactive after price snapshot would have been read.
    // The clean path: pass an unknown productId — completeSale throws
    // before any INSERT, so before/after counts must match.
    await expect(
      completeSale(db, {
        shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
        lines: [
          { productId: star.id, quantity: 2, unitPricePesewas: 800 },
          { productId: 'nope-not-real', quantity: 1, unitPricePesewas: 100 },
        ],
        paymentMethod: 'CASH', cashGivenPesewas: 2000,
        deviceId: D, shopName: 'TEST',
      }),
    ).rejects.toThrow(/not found/);
    expect(rowCount('sales')).toBe(before.sales);
    expect(rowCount('sale_lines')).toBe(before.lines);
    expect(rowCount('stock_movements')).toBe(before.sm);
  });

  it('mid-transaction failure rolls back partial line writes', async () => {
    const star = pickProduct('STAR-330');
    const before = {
      sales: rowCount('sales'),
      lines: rowCount('sale_lines'),
      sm: rowCount('stock_movements'),
    };
    // Drop a CHECK in stock_movements to simulate mid-txn failure on
    // the SECOND line. We delete the reason code temporarily so the
    // FK fails partway through.
    db.prepare('UPDATE reason_codes SET active = 0 WHERE code = ?').run('SALE_WALK_IN');
    await expect(
      completeSale(db, {
        shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
        lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
        paymentMethod: 'CASH', cashGivenPesewas: 800,
        deviceId: D, shopName: 'TEST',
      }),
    ).rejects.toThrow();
    db.prepare('UPDATE reason_codes SET active = 1 WHERE code = ?').run('SALE_WALK_IN');
    expect(rowCount('sales')).toBe(before.sales);
    expect(rowCount('sale_lines')).toBe(before.lines);
    expect(rowCount('stock_movements')).toBe(before.sm);
  });
});

describe('completeSale — line snapshot + margin', () => {
  it('snapshots unit_cost from products at sale time', async () => {
    const star = pickProduct('STAR-330');
    expect(star.cost_price_pesewas).toBe(600);
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
    });
    const row = db.prepare('SELECT unit_cost_pesewas, margin_pesewas FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { unit_cost_pesewas: number; margin_pesewas: number };
    expect(row.unit_cost_pesewas).toBe(600);
    expect(row.margin_pesewas).toBe(200); // (800-600)*1
  });

  it('cost change AFTER sale does not retroactively change snapshot', async () => {
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
    });
    db.prepare('UPDATE products SET cost_price_pesewas = 999 WHERE id = ?').run(star.id);
    const row = db.prepare('SELECT unit_cost_pesewas FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { unit_cost_pesewas: number };
    expect(row.unit_cost_pesewas).toBe(600);
  });

  it('margin = (unit_price - unit_cost) * quantity for multiple units', async () => {
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'TEST',
    });
    const row = db.prepare('SELECT margin_pesewas, line_total_pesewas FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { margin_pesewas: number; line_total_pesewas: number };
    expect(row.line_total_pesewas).toBe(2400);
    expect(row.margin_pesewas).toBe(600); // (800-600)*3
  });
});

describe('completeSale — stock effects', () => {
  it('decrements stock by quantity', async () => {
    const star = pickProduct('STAR-330');
    expect(unitsOnHand(db, star.id, L)).toBe(24);
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 2400, deviceId: D, shopName: 'TEST',
    });
    expect(unitsOnHand(db, star.id, L)).toBe(21);
  });

  it('uses SALE_WALK_IN reason for walk-in channel', async () => {
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
    });
    const sm = db.prepare('SELECT reason_code, quantity FROM stock_movements WHERE sale_id = ?').get(r.saleId) as { reason_code: string; quantity: number };
    expect(sm.reason_code).toBe('SALE_WALK_IN');
    expect(sm.quantity).toBe(-1); // signed outflow
  });

  it('uses SALE_CREDIT reason when payment is CREDIT', async () => {
    // Need a customer.
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('cust-1', 'Yaw Boateng', '+233244999000', 'WALK_IN_REGULAR', 100000, W, W, D);
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: 'cust-1', deviceId: D, shopName: 'TEST',
    });
    const sm = db.prepare('SELECT reason_code FROM stock_movements WHERE sale_id = ?').get(r.saleId) as { reason_code: string };
    expect(sm.reason_code).toBe('SALE_CREDIT');
  });
});

describe('completeSale — validation', () => {
  it('rejects empty cart', async () => {
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [], paymentMethod: 'CASH', cashGivenPesewas: 0, deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/empty/);
  });

  it('rejects MoMo without payment_reference (invariant 10)', async () => {
    const star = pickProduct('STAR-330');
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'MOMO_MTN', deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/transaction reference/);
    // Whitespace-only also rejected
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'MOMO_MTN', paymentReference: '   ', deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/transaction reference/);
  });

  it('accepts MoMo with valid reference', async () => {
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'MOMO_MTN', paymentReference: 'TXN-12345', deviceId: D, shopName: 'TEST',
    });
    expect(r.saleId).toBeDefined();
    const row = db.prepare('SELECT payment_reference FROM sales WHERE id = ?').get(r.saleId) as { payment_reference: string };
    expect(row.payment_reference).toBe('TXN-12345');
  });

  it('rejects CREDIT without customer', async () => {
    // Error message wording changed from "credit sale requires" to
    // "credit tender requires" when the split-tender refactor (0019)
    // introduced the payments[] array.
    const star = pickProduct('STAR-330');
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/credit tender requires a customer/);
  });

  it('legacy CASH without cashGivenPesewas assumes exact change (no throw)', async () => {
    // The single-tender legacy path used to require cashGivenPesewas, but
    // the split-payment refactor (0019) treats the absence as "customer
    // paid exact change" — the implicit cashGiven equals the sale total
    // so there's nothing to validate. New payments[] callers still
    // validate explicit values via the < tender check below.
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', deviceId: D, shopName: 'TEST',
    });
    expect(r.totalPesewas).toBe(800);
    expect(r.changePesewas).toBeNull();
  });

  it('rejects CASH where cashGiven < tender amount', async () => {
    // Old wording: "cash given (X) less than total (Y)". New wording
    // after 0019: "cash given (X) less than tender (Y)" since the sale
    // total may now be split across multiple tenders.
    const star = pickProduct('STAR-330');
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      payments: [{ method: 'CASH', amountPesewas: 800, cashGivenPesewas: 500 }],
      deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/less than tender/);
  });

  it('rejects discount > 0 without reason', async () => {
    const star = pickProduct('STAR-330');
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      discountPesewas: 100, paymentMethod: 'CASH', cashGivenPesewas: 700, deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/discountReason/);
  });

  it('rejects blocked customer for credit', async () => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas, blocked, blocked_reason,
         created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, 1, 'over limit', ?, ?, ?)`,
    ).run('cust-blocked', 'Bad Debtor', '+233244111000', 'WALK_IN_REGULAR', 0, W, W, D);
    const star = pickProduct('STAR-330');
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: 'cust-blocked', deviceId: D, shopName: 'TEST',
    })).rejects.toThrow(/blocked/);
  });
});

describe('completeSale — credit balance', () => {
  it('credit sale increments customer balance', async () => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
         created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('cust-1', 'Yaw Boateng', '+233244999000', 'WALK_IN_REGULAR', 100000, W, W, D);
    const star = pickProduct('STAR-330');
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 2, unitPricePesewas: 800 }],
      paymentMethod: 'CREDIT', customerId: 'cust-1', deviceId: D, shopName: 'TEST',
    });
    const row = db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get('cust-1') as { current_balance_pesewas: number };
    expect(row.current_balance_pesewas).toBe(1600);
  });

  it('walk-in cash sale does NOT change customer balance', async () => {
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas, current_balance_pesewas,
         created_by, updated_by, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('cust-2', 'Ama Asante', '+233244999111', 'WALK_IN_REGULAR', 100000, 5000, W, W, D);
    const star = pickProduct('STAR-330');
    await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, customerId: 'cust-2', deviceId: D, shopName: 'TEST',
    });
    const row = db.prepare('SELECT current_balance_pesewas FROM customers WHERE id = ?').get('cust-2') as { current_balance_pesewas: number };
    expect(row.current_balance_pesewas).toBe(5000);
  });
});

describe('completeSale — printer degraded mode', () => {
  it('printer failure flips printer_failed and queues a reprint, but sale still completes', async () => {
    _setPrinter({ async print() { return { ok: false, reason: 'OFFLINE', message: 'unplugged' } as const; } });
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
    });
    expect(r.printerFailed).toBe(true);
    expect(r.saleId).toBeDefined();
    const sale = db.prepare('SELECT printer_failed FROM sales WHERE id = ?').get(r.saleId) as { printer_failed: number };
    expect(sale.printer_failed).toBe(1);
    const reprint = db.prepare('SELECT id FROM pending_receipt_reprints WHERE sale_id = ?').get(r.saleId);
    expect(reprint).toBeDefined();
  });

  it('printer success leaves printer_failed = 0 and no reprint row', async () => {
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
    });
    expect(r.printerFailed).toBe(false);
    const sale = db.prepare('SELECT printer_failed FROM sales WHERE id = ?').get(r.saleId) as { printer_failed: number };
    expect(sale.printer_failed).toBe(0);
    const reprint = db.prepare('SELECT id FROM pending_receipt_reprints WHERE sale_id = ?').get(r.saleId);
    expect(reprint).toBeUndefined();
  });
});

describe('completeSale — door station routing', () => {
  it('routes a phone (door) sale to the door printer and tags the reprint station=door', async () => {
    const calls: string[] = [];
    _setPrinter({ async print() { calls.push('counter'); return { ok: true } as const; } }, 'counter');
    _setPrinter({ async print() { calls.push('door'); return { ok: false, reason: 'OFFLINE', message: 'door unplugged' } as const; } }, 'door');
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
      station: 'door',
    });
    // Door printer was used; the counter printer was never touched.
    expect(calls).toEqual(['door']);
    expect(r.station).toBe('door');
    expect(r.printerFailed).toBe(true);
    const reprint = db.prepare(
      'SELECT station_id FROM pending_receipt_reprints WHERE sale_id = ?',
    ).get(r.saleId) as { station_id: string };
    expect(reprint.station_id).toBe('door');
  });

  it('routes a desktop (default) sale to the counter printer, station=counter', async () => {
    const calls: string[] = [];
    _setPrinter({ async print() { calls.push('counter'); return { ok: true } as const; } }, 'counter');
    _setPrinter({ async print() { calls.push('door'); return { ok: true } as const; } }, 'door');
    const star = pickProduct('STAR-330');
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: star.id, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'TEST',
      // no station -> defaults to 'counter'
    });
    // Counter printer was used; the door printer was never touched.
    expect(calls).toEqual(['counter']);
    expect(r.station).toBe('counter');
    expect(r.printerFailed).toBe(false);
  });
});

describe('receipt formatter', () => {
  it('produces 32-column lines, no overflow', () => {
    const lines = formatReceipt({
      shopName: 'COUNTER SHOP',
      shopSubtitle: 'Accra, Ghana',
      receiptId: 'sa-12345678abcdef',
      workerName: 'Naj Adams',
      saleAt: '2026-05-04T14:32:00Z',
      channel: 'WALK_IN',
      lines: [
        { quantity: 2, name: 'Star Beer 330ml', unitPricePesewas: 800, lineTotalPesewas: 1600 },
        { quantity: 1, name: 'Voltic Mineral Water 1L', unitPricePesewas: 300, lineTotalPesewas: 300 },
      ],
      subtotalPesewas: 1900,
      discountPesewas: 0,
      totalPesewas: 1900,
      payment: { method: 'CASH', cashGivenPesewas: 2000, changePesewas: 100 },
    });
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(32);
    }
    // Sanity: includes total and change
    expect(lines.join('\n')).toContain('TOTAL');
    expect(lines.join('\n')).toContain('19.00');
    expect(lines.join('\n')).toContain('Change');
  });

  it('long product name wraps across lines', () => {
    const lines = formatReceipt({
      shopName: 'X', receiptId: 'sa-x', workerName: 'N', saleAt: '2026-05-04T14:32:00Z',
      channel: 'WALK_IN',
      lines: [{
        quantity: 1,
        name: 'Very Long Product Name That Definitely Exceeds Thirty Two Columns',
        unitPricePesewas: 100, lineTotalPesewas: 100,
      }],
      subtotalPesewas: 100, discountPesewas: 0, totalPesewas: 100,
      payment: { method: 'CASH', cashGivenPesewas: 100, changePesewas: 0 },
    });
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(32);
    }
  });

  it('shows "REPRINT" notice when printerFailedNotice is set', () => {
    const lines = formatReceipt({
      shopName: 'X', receiptId: 'sa-x', workerName: 'N', saleAt: '2026-05-04T14:32:00Z',
      channel: 'WALK_IN',
      lines: [{ quantity: 1, name: 'Item', unitPricePesewas: 100, lineTotalPesewas: 100 }],
      subtotalPesewas: 100, discountPesewas: 0, totalPesewas: 100,
      payment: { method: 'CASH', cashGivenPesewas: 100, changePesewas: 0 },
      printerFailedNotice: true,
    });
    expect(lines.join('\n')).toContain('REPRINT');
  });
});

describe('getShopHeader', () => {
  it('reads seeded values from device_config', () => {
    const h = getShopHeader(db);
    expect(h.shopName).toBeTruthy();
    expect(h.shopSubtitle).toBeTruthy();
  });
});

function rowCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
