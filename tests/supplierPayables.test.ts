import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { receiveStock } from '../src/main/services/stockReceipts';
import {
  getSupplierStatementLines,
  listSupplierInvoices,
  listSupplierStatements,
  recordSupplierPayment,
} from '../src/main/services/supplierPaymentsAdmin';

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
});
afterEach(() => { db.close(); });

function star() {
  return db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string };
}
function supplierId() {
  return (db.prepare("SELECT id FROM suppliers LIMIT 1").get() as { id: string }).id;
}
function createPO(id: string, supplier: string, product: string, qty: number, unitCost: number) {
  db.prepare(
    `INSERT INTO purchase_orders (
       id, supplier_id, location_id, status, po_number, ordered_at,
       total_ordered_pesewas, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, 'DRAFT', ?, '2026-07-01T00:00:00.000Z', ?, ?, ?, ?)`,
  ).run(id, supplier, L, `PO-${id}`, qty * unitCost, W, W, D);
  db.prepare(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, product_id, quantity_ordered, unit_cost_pesewas,
       line_total_ordered_pesewas, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${id}-line`, id, product, qty, unitCost, qty * unitCost, W, W, D);
}

describe('supplier invoice payables', () => {
  it('lists invoices and builds supplier statement lines from structured receipt rows', () => {
    const sid = supplierId();
    const p = star();
    const receipt = receiveStock(db, {
      supplierId: sid, locationId: L, workerId: W, supervisorApprovalId: SUP,
      supplierInvoiceNumber: 'INV-2001',
      supplierInvoiceDate: '2026-07-01',
      supplierDueDate: '2026-07-15',
      lines: [{ productId: p.id, quantity: 5, unitCostPesewas: 600 }],
      deviceId: D,
    });
    expect(receipt.supplierInvoiceId).toBeTruthy();

    const invoices = listSupplierInvoices(db, { supplierId: sid });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.invoiceNumber).toBe('INV-2001');
    expect(invoices[0]?.outstandingPesewas).toBe(3000);

    const statements = listSupplierStatements(db);
    const row = statements.find((s) => s.supplierId === sid);
    expect(row?.lifetimeReceivedCostPesewas).toBe(3000);
    expect(row?.openInvoiceCount).toBe(1);
    expect(row?.nextDueDate).toBe('2026-07-15');

    const lines = getSupplierStatementLines(db, sid);
    expect(lines[0]?.invoiceNumber).toBe('INV-2001');
    expect(lines[0]?.lineTotalPesewas).toBe(3000);
  });

  it('allocates supplier payments FIFO to open invoices and marks them paid', () => {
    const sid = supplierId();
    const p = star();
    const a = receiveStock(db, {
      supplierId: sid, locationId: L, workerId: W, supervisorApprovalId: SUP,
      supplierInvoiceNumber: 'INV-3001',
      supplierInvoiceDate: '2026-07-01',
      supplierDueDate: '2026-07-08',
      lines: [{ productId: p.id, quantity: 5, unitCostPesewas: 600 }],
      deviceId: D,
    });
    const b = receiveStock(db, {
      supplierId: sid, locationId: L, workerId: W, supervisorApprovalId: SUP,
      supplierInvoiceNumber: 'INV-3002',
      supplierInvoiceDate: '2026-07-02',
      supplierDueDate: '2026-07-09',
      lines: [{ productId: p.id, quantity: 4, unitCostPesewas: 600 }],
      deviceId: D,
    });

    const pay = recordSupplierPayment(db, {
      supplierId: sid,
      amountPesewas: 4200,
      paymentMethod: 'CASH',
      actorWorkerId: W,
      deviceId: D,
    });
    expect(pay.totalAllocatedPesewas).toBe(4200);
    expect(pay.allocations).toEqual([
      { supplierInvoiceId: a.supplierInvoiceId!, amountPesewas: 3000 },
      { supplierInvoiceId: b.supplierInvoiceId!, amountPesewas: 1200 },
    ]);
    const invA = db.prepare('SELECT status, total_paid_pesewas FROM supplier_invoices WHERE id = ?')
      .get(a.supplierInvoiceId) as { status: string; total_paid_pesewas: number };
    const invB = db.prepare('SELECT status, total_paid_pesewas FROM supplier_invoices WHERE id = ?')
      .get(b.supplierInvoiceId) as { status: string; total_paid_pesewas: number };
    expect(invA).toEqual({ status: 'PAID', total_paid_pesewas: 3000 });
    expect(invB).toEqual({ status: 'PARTIALLY_PAID', total_paid_pesewas: 1200 });
  });

  it('links invoice payments back to their purchase order', () => {
    const sid = supplierId();
    const p = star();
    createPO('po-payment-match', sid, p.id, 5, 600);
    const receipt = receiveStock(db, {
      supplierId: sid, locationId: L, workerId: W, supervisorApprovalId: SUP,
      purchaseOrderId: 'po-payment-match',
      supplierInvoiceNumber: 'INV-PO-1',
      lines: [{ productId: p.id, quantity: 5, unitCostPesewas: 600 }],
      deviceId: D,
    });

    recordSupplierPayment(db, {
      supplierId: sid,
      amountPesewas: 3000,
      paymentMethod: 'CASH',
      allocations: [{ supplierInvoiceId: receipt.supplierInvoiceId!, amountPesewas: 3000 }],
      actorWorkerId: W,
      deviceId: D,
    });

    const po = db.prepare(
      `SELECT total_received_pesewas, total_paid_pesewas, status
         FROM purchase_orders WHERE id = ?`,
    ).get('po-payment-match') as { total_received_pesewas: number; total_paid_pesewas: number; status: string };
    expect(po).toEqual({ total_received_pesewas: 3000, total_paid_pesewas: 3000, status: 'PAID' });
    const allocation = db.prepare(
      `SELECT supplier_payment_id, amount_pesewas
         FROM supplier_payment_allocations
        WHERE purchase_order_id = ?`,
    ).get('po-payment-match') as { supplier_payment_id: string; amount_pesewas: number };
    expect(allocation.supplier_payment_id).toMatch(/^spay-/);
    expect(allocation.amount_pesewas).toBe(3000);
  });
});
