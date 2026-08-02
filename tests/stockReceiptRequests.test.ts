import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { unitsOnHand } from '../src/main/services/stockMovements';
import {
  createStockReceiptRequest,
  getStockReceiptRequest,
  listStockReceiptRequests,
  reviewStockReceiptRequest,
  stockReceiptRequestPendingCount,
  withdrawStockReceiptRequest,
} from '../src/main/services/stockReceiptRequests';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const COUNTER = 'dev-counter-1';
const SUPERVISOR = 'dev-supervisor-1';
const LOCATION = 'loc-main-counter';
const DEVICE = 'stock-request-device';

let db: ReturnType<typeof Database>;
let productId: string;
let supplierId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  productId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  supplierId = (db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get() as { id: string }).id;
});

afterEach(() => db.close());

function addWorker(id: string, role: 'DRIVER' | 'STOCKMASTER' | 'OWNER' | 'FOUNDER', active = 1): void {
  db.prepare(
    `INSERT INTO workers
      (id, full_name, phone, role, pin_hash, active, hired_at, created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, '$2a$04$placeholder', ?, '2026-01-01', 'sys-system', 'sys-system', ?)`,
  ).run(id, id, `+233555${String(Math.abs(id.length * 7919)).padStart(6, '0')}`, role, active, DEVICE);
}

function createRequest(requesterWorkerId = COUNTER, overrides: Partial<Parameters<typeof createStockReceiptRequest>[1]> = {}) {
  return createStockReceiptRequest(db, {
    supplierId,
    supplierInvoiceNumber: 'REQ-INV-001',
    supplierInvoiceDate: '2026-08-02',
    supplierDueDate: '2026-08-16',
    transportCostPesewas: 100,
    loadingCostPesewas: 50,
    lines: [{ productId, quantity: 24, unitCostPesewas: 650 }],
    notes: 'Delivery counted at the counter',
    locationId: LOCATION,
    requesterWorkerId,
    deviceId: DEVICE,
    ...overrides,
  });
}

function operationalSnapshot() {
  return {
    stock: unitsOnHand(db, productId, LOCATION),
    cost: (db.prepare('SELECT cost_price_pesewas AS n FROM products WHERE id = ?').get(productId) as { n: number }).n,
    supplierBalance: (db.prepare('SELECT current_balance_pesewas AS n FROM suppliers WHERE id = ?').get(supplierId) as { n: number }).n,
    movements: (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n,
    invoices: (db.prepare('SELECT COUNT(*) AS n FROM supplier_invoices').get() as { n: number }).n,
    invoiceLines: (db.prepare('SELECT COUNT(*) AS n FROM supplier_invoice_lines').get() as { n: number }).n,
    obligations: (db.prepare('SELECT COUNT(*) AS n FROM obligations').get() as { n: number }).n,
    journals: (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n,
  };
}

function createPurchaseOrder(): string {
  const id = 'po-stock-request';
  db.prepare(
    `INSERT INTO purchase_orders
      (id, supplier_id, location_id, status, po_number, ordered_at, total_ordered_pesewas,
       created_by, updated_by, device_id)
     VALUES (?, ?, ?, 'PLACED', 'PO-STOCK-REQUEST', '2026-08-01T00:00:00.000Z', 15600, ?, ?, ?)`,
  ).run(id, supplierId, LOCATION, COUNTER, COUNTER, DEVICE);
  db.prepare(
    `INSERT INTO purchase_order_lines
      (id, purchase_order_id, product_id, quantity_ordered, unit_cost_pesewas,
       line_total_ordered_pesewas, created_by, updated_by, device_id)
     VALUES ('po-stock-request-line', ?, ?, 24, 650, 15600, ?, ?, ?)`,
  ).run(id, productId, COUNTER, COUNTER, DEVICE);
  return id;
}

describe('queued stock receipt lifecycle', () => {
  it('creates evidence only, preserving stock, costs, supplier balances, invoices, obligations, and journals', () => {
    const before = operationalSnapshot();
    const request = createRequest();

    expect(request.status).toBe('PENDING');
    expect(request.goodsValuePesewas).toBe(15_600);
    expect(request.totalPayablePesewas).toBe(15_750);
    expect(request.lines[0]).toMatchObject({ quantity: 24, canonicalQuantity: 24, unitCostPesewas: 650 });
    expect(operationalSnapshot()).toEqual(before);
    expect(stockReceiptRequestPendingCount(db, COUNTER)).toEqual({ minePendingCount: 1, reviewablePendingCount: 0 });
    expect(stockReceiptRequestPendingCount(db, SUPERVISOR)).toEqual({ minePendingCount: 0, reviewablePendingCount: 1 });
    expect(() => createRequest()).toThrow(/already recorded or pending approval/);
  });

  it('declining or withdrawing leaves the operational books untouched', () => {
    const before = operationalSnapshot();
    const first = createRequest();
    expect(() => reviewStockReceiptRequest(db, {
      requestId: first.id, decision: 'DECLINE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/decline note/);
    const declined = reviewStockReceiptRequest(db, {
      requestId: first.id, decision: 'DECLINE', note: 'Invoice quantity does not match the delivery',
      reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    });
    expect(declined.status).toBe('DECLINED');
    expect(operationalSnapshot()).toEqual(before);

    const second = createRequest(COUNTER, { supplierInvoiceNumber: 'REQ-INV-002' });
    expect(() => withdrawStockReceiptRequest(db, {
      requestId: second.id, requesterWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/Only the requester/);
    expect(withdrawStockReceiptRequest(db, {
      requestId: second.id, requesterWorkerId: COUNTER, deviceId: DEVICE,
    }).status).toBe('WITHDRAWN');
    expect(operationalSnapshot()).toEqual(before);
  });

  it('approval posts the exact receipt once and records the reviewer', () => {
    const before = operationalSnapshot();
    const request = createRequest();
    const approved = reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', note: 'Count and invoice checked',
      reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    });

    expect(approved).toMatchObject({
      status: 'APPROVED', reviewedBy: SUPERVISOR, totalPayablePesewas: 15_750,
      movementCount: 1, productsCostUpdated: 1,
    });
    expect(unitsOnHand(db, productId, LOCATION)).toBe(before.stock + 24);
    expect((db.prepare('SELECT cost_price_pesewas AS n FROM products WHERE id = ?').get(productId) as { n: number }).n).toBe(650);
    expect((db.prepare('SELECT current_balance_pesewas AS n FROM suppliers WHERE id = ?').get(supplierId) as { n: number }).n)
      .toBe(before.supplierBalance + 15_750);
    expect(db.prepare('SELECT total_pesewas, transport_cost_pesewas, loading_cost_pesewas FROM supplier_invoices WHERE id = ?')
      .get(approved.postedSupplierInvoiceId)).toEqual({ total_pesewas: 15_750, transport_cost_pesewas: 100, loading_cost_pesewas: 50 });
    expect(db.prepare("SELECT supervisor_approval_id FROM stock_movements WHERE reason_code = 'RECEIVED_FROM_SUPPLIER' ORDER BY created_at DESC LIMIT 1").get())
      .toEqual({ supervisor_approval_id: SUPERVISOR });
    expect(() => reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/already approved/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reason_code = 'RECEIVED_FROM_SUPPLIER'").get() as { n: number }).n)
      .toBe(before.movements + 1);
  });

  it('does not consume a purchase order until approval succeeds', () => {
    const purchaseOrderId = createPurchaseOrder();
    const request = createRequest(COUNTER, { purchaseOrderId, supplierInvoiceNumber: 'REQ-PO-001' });
    expect(db.prepare('SELECT status, total_received_pesewas FROM purchase_orders WHERE id = ?').get(purchaseOrderId))
      .toEqual({ status: 'PLACED', total_received_pesewas: 0 });
    expect(db.prepare('SELECT quantity_received FROM purchase_order_lines WHERE purchase_order_id = ?').get(purchaseOrderId))
      .toEqual({ quantity_received: 0 });

    reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    });
    expect(db.prepare('SELECT status, total_received_pesewas FROM purchase_orders WHERE id = ?').get(purchaseOrderId))
      .toEqual({ status: 'RECEIVED', total_received_pesewas: 15_600 });
    expect(db.prepare('SELECT quantity_received FROM purchase_order_lines WHERE purchase_order_id = ?').get(purchaseOrderId))
      .toEqual({ quantity_received: 24 });
  });

  it('enforces reviewer roles, supervisor self-approval, and owner/founder escape hatch', () => {
    addWorker('stock-requester', 'STOCKMASTER');
    addWorker('owner-reviewer', 'OWNER');
    addWorker('founder-reviewer', 'FOUNDER');
    const counterRequest = createRequest();
    expect(() => reviewStockReceiptRequest(db, {
      requestId: counterRequest.id, decision: 'APPROVE', reviewerWorkerId: COUNTER, deviceId: DEVICE,
    })).toThrow(/Supervisor, owner, or founder/);
    reviewStockReceiptRequest(db, {
      requestId: counterRequest.id, decision: 'DECLINE', note: 'Delivery should be re-entered',
      reviewerWorkerId: 'founder-reviewer', deviceId: DEVICE,
    });

    const supervisorRequest = createRequest(SUPERVISOR, { supplierInvoiceNumber: 'REQ-SELF-SUP' });
    expect(() => reviewStockReceiptRequest(db, {
      requestId: supervisorRequest.id, decision: 'APPROVE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/cannot approve their own/);
    expect(reviewStockReceiptRequest(db, {
      requestId: supervisorRequest.id, decision: 'APPROVE', reviewerWorkerId: 'owner-reviewer', deviceId: DEVICE,
    }).status).toBe('APPROVED');

    const ownerRequest = createRequest('owner-reviewer', { supplierInvoiceNumber: 'REQ-SELF-OWNER' });
    expect(reviewStockReceiptRequest(db, {
      requestId: ownerRequest.id, decision: 'APPROVE', reviewerWorkerId: 'owner-reviewer', deviceId: DEVICE,
    }).status).toBe('APPROVED');
    const audit = db.prepare("SELECT after_value FROM audit_log WHERE action = 'STOCK_RECEIPT_REQUEST_APPROVED' AND entity_id = ?")
      .get(ownerRequest.id) as { after_value: string };
    expect(JSON.parse(audit.after_value)).toMatchObject({ selfApproved: true });

    const stockRequest = createRequest('stock-requester', { supplierInvoiceNumber: 'REQ-STOCKMASTER' });
    expect(() => reviewStockReceiptRequest(db, {
      requestId: stockRequest.id, decision: 'DECLINE', note: 'Not permitted', reviewerWorkerId: 'stock-requester', deviceId: DEVICE,
    })).toThrow(/Supervisor, owner, or founder/);
  });

  it('reserves opening stock for owner/founder creation and approval', () => {
    addWorker('opening-owner', 'OWNER');
    expect(() => createRequest(COUNTER, {
      supplierId: null, supplierInvoiceNumber: null, supplierInvoiceDate: null, supplierDueDate: null,
      transportCostPesewas: 0, loadingCostPesewas: 0, isOpeningStock: true,
    })).toThrow(/owner or founder/);
    const request = createRequest('opening-owner', {
      supplierId: null, supplierInvoiceNumber: null, supplierInvoiceDate: null, supplierDueDate: null,
      transportCostPesewas: 0, loadingCostPesewas: 0, isOpeningStock: true,
    });
    expect(() => reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/Opening stock requires owner or founder/);
    expect(reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: 'opening-owner', deviceId: DEVICE,
    }).status).toBe('APPROVED');
  });

  it('requires explicit senior confirmation for a large cost swing', () => {
    const before = operationalSnapshot();
    const request = createRequest(COUNTER, {
      supplierInvoiceNumber: 'REQ-COST-SWING',
      lines: [{ productId, quantity: 24, unitCostPesewas: 25 }],
    });
    expect(request.costSwingWarnings).toHaveLength(1);
    expect(() => reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/COST_SWING/);
    expect(getStockReceiptRequest(db, request.id, COUNTER).status).toBe('PENDING');
    expect(operationalSnapshot()).toEqual(before);

    const approved = reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', allowLargeCostSwing: true,
      reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.costSwingApproved).toBe(true);
    expect((db.prepare('SELECT cost_price_pesewas AS n FROM products WHERE id = ?').get(productId) as { n: number }).n).toBe(25);
  });

  it('rolls back receipt writes and the decision if approval hits a late invoice conflict', () => {
    const request = createRequest(COUNTER, { supplierInvoiceNumber: 'LATE-CONFLICT' });
    db.prepare(
      `INSERT INTO supplier_invoices
        (id, supplier_id, invoice_number, invoice_date, due_date, total_pesewas,
         total_paid_pesewas, status, created_by, updated_by, device_id)
       VALUES ('late-conflict-invoice', ?, 'LATE-CONFLICT', '2026-08-02', '2026-08-16',
         1, 0, 'OPEN', ?, ?, ?)`,
    ).run(supplierId, SUPERVISOR, SUPERVISOR, DEVICE);
    const before = operationalSnapshot();

    expect(() => reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'APPROVE', reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    })).toThrow(/UNIQUE constraint failed/);
    expect(getStockReceiptRequest(db, request.id, COUNTER).status).toBe('PENDING');
    expect(operationalSnapshot()).toEqual(before);
  });

  it('keeps request evidence immutable and captures inserts and decisions for sync', () => {
    const request = createRequest();
    reviewStockReceiptRequest(db, {
      requestId: request.id, decision: 'DECLINE', note: 'Supplier invoice is unclear',
      reviewerWorkerId: SUPERVISOR, deviceId: DEVICE,
    });
    expect(() => db.prepare("UPDATE stock_receipt_requests SET status = 'PENDING' WHERE id = ?").run(request.id)).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE stock_receipt_request_lines SET quantity = 1 WHERE request_id = ?').run(request.id)).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM stock_receipt_requests WHERE id = ?').run(request.id)).toThrow(/cannot be deleted/);

    const requestOps = db.prepare('SELECT table_name, op FROM sync_outbox WHERE row_pk = ? ORDER BY seq').all(request.id);
    expect(requestOps).toEqual([
      { table_name: 'stock_receipt_requests', op: 'INSERT' },
      { table_name: 'stock_receipt_requests', op: 'UPDATE' },
    ]);
    const line = db.prepare('SELECT id FROM stock_receipt_request_lines WHERE request_id = ?').get(request.id) as { id: string };
    expect(db.prepare('SELECT table_name, op FROM sync_outbox WHERE row_pk = ?').get(line.id))
      .toEqual({ table_name: 'stock_receipt_request_lines', op: 'INSERT' });
    expect(listStockReceiptRequests(db, { actorWorkerId: SUPERVISOR, scope: 'REVIEWABLE', status: 'RESOLVED' }))
      .toHaveLength(1);
  });
});
