import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift, submitClosingCount } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import {
  createSaleVoidRequest,
  getSaleVoidRequest,
  listRecentSales,
  listSaleVoidRequests,
  reviewSaleVoidRequest,
  withdrawSaleVoidRequest,
} from '../src/main/services/voids';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { _resetPrinter, _setPrinter } from '../src/main/printer/printer';
import { buildSaleReceiptForReprint } from '../src/main/services/reprintQueue';
import { formatReceipt } from '../src/shared/lib/receipt';
import { correctSale } from '../src/main/services/correctSale';
import { recordCustomerReturn } from '../src/main/services/customerReturns';
import bcrypt from 'bcryptjs';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const COUNTER = 'dev-counter-1';
const SENIOR = 'dev-supervisor-1';
const LOCATION = 'loc-main-counter';
const DEVICE = 'queued-void-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let productId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  productId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO stock_movements
       (id, product_id, location_id, quantity, reason_code, worker_id,
        unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
     VALUES ('queued-opening', ?, ?, 30, 'RECEIVED_FROM_SUPPLIER', ?, 600, 18000, ?, ?, ?, ?)`,
  ).run(productId, LOCATION, SENIOR, SENIOR, COUNTER, COUNTER, DEVICE);
  shiftId = openShift(db, {
    workerId: COUNTER, locationId: LOCATION, shiftType: 'COUNTER',
    openingCashPesewas: 5000, deviceId: DEVICE,
  }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => { _resetPrinter(); db.close(); });

async function sale(paymentMethod: 'CASH' | 'CREDIT' = 'CASH') {
  if (paymentMethod === 'CREDIT') {
    db.prepare(
      `INSERT OR IGNORE INTO customers
        (id, display_name, phone, customer_type, credit_limit_pesewas, created_by, updated_by, device_id)
       VALUES ('queued-customer', 'Ama', '+233244000111', 'WALK_IN_REGULAR', 100000, ?, ?, ?)`,
    ).run(COUNTER, COUNTER, DEVICE);
  }
  return completeSale(db, {
    shiftId, workerId: COUNTER, workerName: 'Counter', locationId: LOCATION,
    channel: 'WALK_IN', customerId: paymentMethod === 'CREDIT' ? 'queued-customer' : undefined,
    lines: [{ productId, quantity: 2, unitPricePesewas: 800 }],
    paymentMethod, cashGivenPesewas: paymentMethod === 'CASH' ? 1600 : undefined,
    deviceId: DEVICE, shopName: 'TEST',
  });
}

function addWorker(id: string, role: 'DRIVER' | 'STOCKMASTER' | 'FOUNDER', active = 1) {
  db.prepare(
    `INSERT INTO workers
      (id, full_name, phone, role, pin_hash, active, hired_at, created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, ?, '2026-01-01', 'sys-system', 'sys-system', ?)`,
  ).run(id, id, `+23324400${id === 'driver-q' ? '0201' : id === 'stock-q' ? '0202' : '0203'}`, role,
    bcrypt.hashSync('7777', PIN_BCRYPT_ROUNDS), active, DEVICE);
}

describe('queued void lifecycle', () => {
  it('creates a pending request without touching the valid sale, stock, customer, or ledger', async () => {
    const completed = await sale('CREDIT');
    const before = {
      stock: unitsOnHand(db, productId, LOCATION),
      customer: (db.prepare("SELECT current_balance_pesewas AS n FROM customers WHERE id = 'queued-customer'").get() as { n: number }).n,
      journals: (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n,
    };
    const request = createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'Customer chose the wrong item',
      requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(request.status).toBe('PENDING');
    expect(db.prepare('SELECT voided FROM sales WHERE id = ?').get(completed.saleId)).toMatchObject({ voided: 0 });
    expect(unitsOnHand(db, productId, LOCATION)).toBe(before.stock);
    expect((db.prepare("SELECT current_balance_pesewas AS n FROM customers WHERE id = 'queued-customer'").get() as { n: number }).n).toBe(before.customer);
    expect((db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n).toBe(before.journals);
    expect(listRecentSales(db, 5)[0]?.voidRequest?.status).toBe('PENDING');
    const reprint = buildSaleReceiptForReprint(db, completed.saleId);
    expect(reprint?.statusNotice).toBe('VOID REQUEST PENDING — SALE STILL VALID');
    expect(formatReceipt(reprint!).map((line) => line.trim())).toEqual(
      expect.arrayContaining(['VOID REQUEST PENDING', 'SALE STILL VALID']),
    );
    expect(() => createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'A duplicate request', requesterWorkerId: COUNTER, deviceId: DEVICE,
    })).toThrow(/already has a pending request/);
  });

  it('declines and withdraws without reversing the sale', async () => {
    const first = await sale();
    const firstRequest = createSaleVoidRequest(db, {
      saleId: first.saleId, reason: 'Cashier suspects duplicate', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(() => reviewSaleVoidRequest(db, {
      requestId: firstRequest.id, decision: 'DECLINE', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    })).toThrow(/decline note/);
    const declined = reviewSaleVoidRequest(db, {
      requestId: firstRequest.id, decision: 'DECLINE', note: 'Receipt is valid', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    });
    expect(declined.status).toBe('DECLINED');
    expect(db.prepare('SELECT voided FROM sales WHERE id = ?').get(first.saleId)).toMatchObject({ voided: 0 });

    const second = await sale();
    const secondRequest = createSaleVoidRequest(db, {
      saleId: second.saleId, reason: 'Customer reconsidered', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    const withdrawn = withdrawSaleVoidRequest(db, {
      requestId: secondRequest.id, requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect(db.prepare('SELECT voided FROM sales WHERE id = ?').get(second.saleId)).toMatchObject({ voided: 0 });
  });

  it('approves exactly once and restores the original stock and credit amount', async () => {
    const completed = await sale('CREDIT');
    const stockAfterSale = unitsOnHand(db, productId, LOCATION);
    const request = createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'Wrong customer account', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    const approved = reviewSaleVoidRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    });
    expect(approved.status).toBe('APPROVED');
    expect(unitsOnHand(db, productId, LOCATION)).toBe(stockAfterSale + 2);
    expect(db.prepare("SELECT current_balance_pesewas AS n FROM customers WHERE id = 'queued-customer'").get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT voided FROM sales WHERE id = ?').get(completed.saleId)).toMatchObject({ voided: 1 });
    expect(() => reviewSaleVoidRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    })).toThrow(/already approved/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE sale_id = ? AND reason_code = 'SALE_VOID_REVERSAL'").get(completed.saleId) as { n: number }).n).toBe(1);
  });

  it('enforces reviewer roles and supervisor/owner self-approval rules', async () => {
    const first = await sale();
    const counterRequest = createSaleVoidRequest(db, {
      saleId: first.saleId, reason: 'Need a senior review', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(() => reviewSaleVoidRequest(db, {
      requestId: counterRequest.id, decision: 'APPROVE', reviewerWorkerId: COUNTER, deviceId: DEVICE,
    })).toThrow(/requires SUPERVISOR/);

    const second = await sale();
    const supervisorRequest = createSaleVoidRequest(db, {
      saleId: second.saleId, reason: 'Supervisor found a duplicate', requesterWorkerId: SENIOR, deviceId: DEVICE,
    });
    expect(() => reviewSaleVoidRequest(db, {
      requestId: supervisorRequest.id, decision: 'APPROVE', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    })).toThrow(/cannot review their own/);

    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SENIOR);
    const approved = reviewSaleVoidRequest(db, {
      requestId: supervisorRequest.id, decision: 'APPROVE', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    });
    expect(approved.status).toBe('APPROVED');
    const audit = db.prepare("SELECT after_value FROM audit_log WHERE action = 'SALE_VOID_REQUEST_APPROVED' AND entity_id = ?").get(supervisorRequest.id) as { after_value: string };
    expect(JSON.parse(audit.after_value)).toMatchObject({ selfApproved: true });
  });

  it('blocks shift close and rejects previous-day or sealed-day requests', async () => {
    const completed = await sale();
    const request = createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'Resolve before close', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(() => submitClosingCount(db, shiftId, 5000, COUNTER, DEVICE)).toThrow(/pending void request/);
    withdrawSaleVoidRequest(db, { requestId: request.id, requesterWorkerId: COUNTER, deviceId: DEVICE });

    const prior = await sale();
    db.prepare("UPDATE sales SET created_at = '2020-01-01T12:00:00.000Z' WHERE id = ?").run(prior.saleId);
    expect(() => createSaleVoidRequest(db, {
      saleId: prior.saleId, reason: 'Too late to request', requesterWorkerId: COUNTER, deviceId: DEVICE,
    })).toThrow(/current business day/);

    const current = await sale();
    const day = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO period_closes (id, location_id, business_date, sealed_by, device_id)
       VALUES ('queued-seal', ?, ?, ?, ?)`,
    ).run(LOCATION, day, SENIOR, DEVICE);
    expect(() => createSaleVoidRequest(db, {
      saleId: current.saleId, reason: 'Sealed sale request', requesterWorkerId: COUNTER, deviceId: DEVICE,
    })).toThrow(/sealed/);
  });

  it('keeps decisions immutable and syncs request plus approved sale updates', async () => {
    const completed = await sale();
    const request = createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'Outbox and immutability', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    reviewSaleVoidRequest(db, {
      requestId: request.id, decision: 'DECLINE', note: 'Keep this receipt', reviewerWorkerId: SENIOR, deviceId: DEVICE,
    });
    expect(() => db.prepare("UPDATE sale_void_requests SET status = 'PENDING' WHERE id = ?").run(request.id)).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM sale_void_requests WHERE id = ?').run(request.id)).toThrow(/cannot be deleted/);
    const ops = db.prepare("SELECT table_name, op FROM sync_outbox WHERE row_pk = ? ORDER BY seq").all(request.id);
    expect(ops).toEqual([
      { table_name: 'sale_void_requests', op: 'INSERT' },
      { table_name: 'sale_void_requests', op: 'UPDATE' },
    ]);
    expect(listSaleVoidRequests(db, { actorWorkerId: SENIOR, scope: 'REVIEWABLE', status: 'RESOLVED' })).toHaveLength(1);
    expect(getSaleVoidRequest(db, request.id, COUNTER).status).toBe('DECLINED');
  });

  it('blocks correction and linked returns until the pending request is resolved', async () => {
    const completed = await sale('CREDIT');
    createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'Senior must decide first', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    await expect(correctSale(db, {
      originalSaleId: completed.saleId,
      addedLines: [{ productId, quantity: 1, unitPricePesewas: 800 }],
      payments: [{ method: 'CREDIT', amountPesewas: 2400 }],
      workerId: COUNTER, workerName: 'Counter', deviceId: DEVICE, shopName: 'TEST',
    })).rejects.toThrow(/pending void request/);
    expect(() => recordCustomerReturn(db, {
      customerId: 'queued-customer', originalSaleId: completed.saleId,
      locationId: LOCATION, workerId: COUNTER, shiftId,
      supervisorWorkerId: SENIOR, supervisorPin: '9999', refundMethod: 'CREDIT',
      reason: 'Customer return while pending',
      lines: [{ productId, quantity: 1, unitPricePesewas: 800 }], deviceId: DEVICE,
    })).toThrow(/pending void request/);
  });

  it('allows every active role to request, but only senior roles to decide', async () => {
    addWorker('driver-q', 'DRIVER');
    addWorker('stock-q', 'STOCKMASTER');
    addWorker('founder-q', 'FOUNDER');
    for (const requesterWorkerId of ['driver-q', 'stock-q']) {
      const completed = await sale();
      const request = createSaleVoidRequest(db, {
        saleId: completed.saleId, reason: `${requesterWorkerId} found an error`, requesterWorkerId, deviceId: DEVICE,
      });
      expect(request.status).toBe('PENDING');
      expect(() => reviewSaleVoidRequest(db, {
        requestId: request.id, decision: 'DECLINE', note: 'Not authorized',
        reviewerWorkerId: requesterWorkerId, deviceId: DEVICE,
      })).toThrow(/requires SUPERVISOR/);
      withdrawSaleVoidRequest(db, { requestId: request.id, requesterWorkerId, deviceId: DEVICE });
    }
    const completed = await sale();
    const request = createSaleVoidRequest(db, {
      saleId: completed.saleId, reason: 'Founder decision required', requesterWorkerId: COUNTER, deviceId: DEVICE,
    });
    expect(reviewSaleVoidRequest(db, {
      requestId: request.id, decision: 'DECLINE', note: 'Sale is correct', reviewerWorkerId: 'founder-q', deviceId: DEVICE,
    }).status).toBe('DECLINED');
    db.prepare("UPDATE workers SET active = 0 WHERE id = 'driver-q'").run();
    const inactiveSale = await sale();
    expect(() => createSaleVoidRequest(db, {
      saleId: inactiveSale.saleId, reason: 'Inactive worker attempt', requesterWorkerId: 'driver-q', deviceId: DEVICE,
    })).toThrow(/inactive/);
  });
});
