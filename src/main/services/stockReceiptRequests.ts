import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { logAudit } from '../db/audit.js';
import { getUnit } from './productUnits.js';
import { receiveStock, type StockReceiptLine } from './stockReceipts.js';

export type StockReceiptRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';
const SENIOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);
const OWNER_ROLES = new Set(['OWNER', 'FOUNDER']);

export interface StockReceiptRequestInput {
  supplierId: string | null;
  isOpeningStock?: boolean;
  purchaseOrderId?: string | null;
  supplierInvoiceNumber?: string | null;
  supplierInvoiceDate?: string | null;
  supplierDueDate?: string | null;
  transportCostPesewas?: number;
  loadingCostPesewas?: number;
  lines: StockReceiptLine[];
  notes?: string | null;
}

export interface StockReceiptRequestSummary {
  id: string;
  status: StockReceiptRequestStatus;
  isOpeningStock: boolean;
  supplierId: string | null;
  supplierName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: string | null;
  supplierDueDate: string | null;
  transportCostPesewas: number;
  loadingCostPesewas: number;
  goodsValuePesewas: number;
  totalPayablePesewas: number;
  lineCount: number;
  notes: string | null;
  requestedBy: string;
  requesterName: string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  costSwingApproved: boolean;
  postedSupplierInvoiceId: string | null;
  movementCount: number;
  productsCostUpdated: number | null;
}

export interface StockReceiptRequestDetail extends StockReceiptRequestSummary {
  lines: Array<{
    id: string;
    productId: string;
    productName: string;
    productSku: string;
    unitId: string | null;
    unitName: string;
    conversionFactor: number;
    quantity: number;
    canonicalQuantity: number;
    unitCostPesewas: number;
    lineTotalPesewas: number;
    currentCanonicalCostPesewas: number;
    proposedCanonicalCostPesewas: number;
  }>;
  costSwingWarnings: string[];
}

function worker(db: DB, workerId: string): { id: string; role: string; name: string } {
  const row = db.prepare(`SELECT id, role, full_name AS name, active, deleted_at, terminated_at
    FROM workers WHERE id = ?`).get(workerId) as
    | { id: string; role: string; name: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!row || row.active !== 1 || row.deleted_at || row.terminated_at) throw new Error('Active worker not found');
  return row;
}

function isSenior(role: string): boolean { return SENIOR_ROLES.has(role); }
function trimmed(value?: string | null): string | null { return value?.trim() || null; }
function validDate(value: string | null): boolean { return value === null || /^\d{4}-\d{2}-\d{2}$/.test(value); }

function validateDraft(db: DB, input: StockReceiptRequestInput, actorWorkerId: string): void {
  const actor = worker(db, actorWorkerId);
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error('Add at least one stock line');
  if (input.lines.length > 200) throw new Error('A stock receipt request cannot exceed 200 lines');
  const opening = !!input.isOpeningStock;
  if (opening && !OWNER_ROLES.has(actor.role)) {
    throw new Error('Opening stock requests can only be created by an owner or founder');
  }
  if (opening) {
    if (input.supplierId || input.purchaseOrderId || trimmed(input.supplierInvoiceNumber)
      || input.supplierInvoiceDate || input.supplierDueDate
      || (input.transportCostPesewas ?? 0) !== 0 || (input.loadingCostPesewas ?? 0) !== 0) {
      throw new Error('Opening stock cannot carry supplier, invoice, PO, transport, or loading details');
    }
  } else {
    if (!input.supplierId) throw new Error('Select a supplier');
    const supplier = db.prepare(`SELECT active, deleted_at FROM suppliers WHERE id = ?`).get(input.supplierId) as
      | { active: number; deleted_at: string | null } | undefined;
    if (!supplier || supplier.active !== 1 || supplier.deleted_at) throw new Error('Supplier not found or inactive');
    const invoiceNumber = trimmed(input.supplierInvoiceNumber);
    if (invoiceNumber) {
      const existing = db.prepare(`SELECT id FROM supplier_invoices WHERE supplier_id = ? AND invoice_number = ?
        UNION ALL SELECT id FROM stock_receipt_requests WHERE supplier_id = ? AND supplier_invoice_number = ? AND status = 'PENDING'
        LIMIT 1`).get(input.supplierId, invoiceNumber, input.supplierId, invoiceNumber) as { id: string } | undefined;
      if (existing) throw new Error(`Supplier invoice ${invoiceNumber} is already recorded or pending approval`);
    }
    if (input.purchaseOrderId) {
      const po = db.prepare(`SELECT supplier_id, status FROM purchase_orders WHERE id = ?`).get(input.purchaseOrderId) as
        | { supplier_id: string; status: string } | undefined;
      if (!po || po.supplier_id !== input.supplierId || po.status === 'CANCELLED') {
        throw new Error('Purchase order is not open for the selected supplier');
      }
    }
  }
  const transport = input.transportCostPesewas ?? 0;
  const loading = input.loadingCostPesewas ?? 0;
  if (!Number.isInteger(transport) || transport < 0 || !Number.isInteger(loading) || loading < 0) {
    throw new Error('Transport and loading costs must be non-negative integer pesewas');
  }
  const invoiceDate = trimmed(input.supplierInvoiceDate);
  const dueDate = trimmed(input.supplierDueDate);
  if (!validDate(invoiceDate) || !validDate(dueDate)) throw new Error('Invoice and due dates must use YYYY-MM-DD');
  if ((trimmed(input.notes)?.length ?? 0) > 500) throw new Error('Notes cannot exceed 500 characters');
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new Error('Every quantity must be a positive integer');
    if (!Number.isInteger(line.unitCostPesewas) || line.unitCostPesewas < 0) throw new Error('Every unit cost must be non-negative integer pesewas');
    const product = db.prepare(`SELECT id FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL`).get(line.productId);
    if (!product) throw new Error(`Product ${line.productId} not found or inactive`);
    if (line.unitId) {
      const unit = getUnit(db, line.unitId);
      if (!unit || !unit.active || unit.productId !== line.productId || !unit.isPurchaseUnit) {
        throw new Error(`Unit ${line.unitId} is not an active purchase unit for this product`);
      }
    }
  }
}

export function createStockReceiptRequest(db: DB, input: StockReceiptRequestInput & {
  locationId?: string; requesterWorkerId: string; deviceId: string;
}): StockReceiptRequestDetail {
  validateDraft(db, input, input.requesterWorkerId);
  const requestId = `srr-${uuidv4()}`;
  const now = new Date().toISOString();
  const opening = !!input.isOpeningStock;
  db.transaction(() => {
    db.prepare(`INSERT INTO stock_receipt_requests (
      id, location_id, supplier_id, is_opening_stock, purchase_order_id,
      supplier_invoice_number, supplier_invoice_date, supplier_due_date,
      transport_cost_pesewas, loading_cost_pesewas, notes,
      requested_by, requested_at, request_device_id, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, input.locationId ?? DEFAULT_LOCATION_ID, opening ? null : input.supplierId,
        opening ? 1 : 0, opening ? null : input.purchaseOrderId ?? null,
        opening ? null : trimmed(input.supplierInvoiceNumber),
        opening ? null : trimmed(input.supplierInvoiceDate),
        opening ? null : trimmed(input.supplierDueDate),
        opening ? 0 : input.transportCostPesewas ?? 0,
        opening ? 0 : input.loadingCostPesewas ?? 0, trimmed(input.notes),
        input.requesterWorkerId, now, input.deviceId, input.requesterWorkerId, input.requesterWorkerId);
    for (let lineNumber = 0; lineNumber < input.lines.length; lineNumber++) {
      const line = input.lines[lineNumber]!;
      db.prepare(`INSERT INTO stock_receipt_request_lines (
        id, request_id, line_number, product_id, source_unit_id, quantity, unit_cost_pesewas,
        created_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`srrl-${uuidv4()}`, requestId, lineNumber, line.productId, line.unitId ?? null,
          line.quantity, line.unitCostPesewas, input.requesterWorkerId, input.deviceId);
    }
    logAudit(db, {
      workerId: input.requesterWorkerId, action: 'STOCK_RECEIPT_REQUESTED',
      entityType: 'stock_receipt_requests', entityId: requestId,
      afterValue: { supplierId: opening ? null : input.supplierId, isOpeningStock: opening, lineCount: input.lines.length,
        goodsValuePesewas: input.lines.reduce((sum, line) => sum + line.quantity * line.unitCostPesewas, 0) },
      deviceId: input.deviceId,
    });
  })();
  return getStockReceiptRequest(db, requestId, input.requesterWorkerId);
}

const SUMMARY_SELECT = `SELECT r.id, r.status, r.is_opening_stock AS isOpeningStock,
  r.supplier_id AS supplierId, s.name AS supplierName, r.purchase_order_id AS purchaseOrderId,
  po.po_number AS purchaseOrderNumber, r.supplier_invoice_number AS supplierInvoiceNumber,
  r.supplier_invoice_date AS supplierInvoiceDate, r.supplier_due_date AS supplierDueDate,
  r.transport_cost_pesewas AS transportCostPesewas, r.loading_cost_pesewas AS loadingCostPesewas,
  COALESCE((SELECT SUM(l.quantity * l.unit_cost_pesewas) FROM stock_receipt_request_lines l WHERE l.request_id = r.id), 0) AS goodsValuePesewas,
  COALESCE((SELECT SUM(l.quantity * l.unit_cost_pesewas) FROM stock_receipt_request_lines l WHERE l.request_id = r.id), 0) + r.transport_cost_pesewas + r.loading_cost_pesewas AS totalPayablePesewas,
  (SELECT COUNT(*) FROM stock_receipt_request_lines l WHERE l.request_id = r.id) AS lineCount,
  r.notes, r.requested_by AS requestedBy, requester.full_name AS requesterName,
  r.requested_at AS requestedAt, r.reviewed_by AS reviewedBy, reviewer.full_name AS reviewerName,
  r.reviewed_at AS reviewedAt, r.review_note AS reviewNote,
  r.cost_swing_approved AS costSwingApproved, r.supplier_invoice_id AS postedSupplierInvoiceId,
  CASE WHEN r.movement_ids_json IS NULL THEN 0 ELSE json_array_length(r.movement_ids_json) END AS movementCount,
  r.products_cost_updated AS productsCostUpdated
 FROM stock_receipt_requests r
 JOIN workers requester ON requester.id = r.requested_by
 LEFT JOIN workers reviewer ON reviewer.id = r.reviewed_by
 LEFT JOIN suppliers s ON s.id = r.supplier_id
 LEFT JOIN purchase_orders po ON po.id = r.purchase_order_id`;

function mapSummary(row: any): StockReceiptRequestSummary {
  return { ...row, isOpeningStock: row.isOpeningStock === 1, costSwingApproved: row.costSwingApproved === 1 };
}

function canView(role: string, actorWorkerId: string, requestedBy: string): boolean {
  return isSenior(role) || actorWorkerId === requestedBy;
}

export function listStockReceiptRequests(db: DB, input: {
  actorWorkerId: string; scope?: 'MY' | 'REVIEWABLE'; status?: 'PENDING' | 'RESOLVED' | 'ALL'; limit?: number;
}): StockReceiptRequestSummary[] {
  const actor = worker(db, input.actorWorkerId);
  if (input.scope === 'REVIEWABLE' && !isSenior(actor.role)) throw new Error('Senior approval access required');
  const where: string[] = [];
  const args: unknown[] = [];
  if (input.scope !== 'REVIEWABLE') { where.push('r.requested_by = ?'); args.push(input.actorWorkerId); }
  if (input.status === 'PENDING' || !input.status) where.push("r.status = 'PENDING'");
  else if (input.status === 'RESOLVED') where.push("r.status IN ('APPROVED','DECLINED','WITHDRAWN')");
  args.push(Math.min(Math.max(input.limit ?? 100, 1), 300));
  const rows = db.prepare(`${SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END, r.requested_at DESC LIMIT ?`).all(...args) as any[];
  return rows.map(mapSummary);
}

export function getStockReceiptRequest(db: DB, requestId: string, actorWorkerId: string): StockReceiptRequestDetail {
  const actor = worker(db, actorWorkerId);
  const row = db.prepare(`${SUMMARY_SELECT} WHERE r.id = ?`).get(requestId) as any;
  if (!row) throw new Error('Stock receipt request not found');
  if (!canView(actor.role, actorWorkerId, row.requestedBy)) throw new Error('You cannot view this stock receipt request');
  const lines = db.prepare(`SELECT l.id, l.product_id AS productId, p.name AS productName, p.sku AS productSku,
      l.source_unit_id AS unitId, COALESCE(u.unit_name, 'UNIT') AS unitName,
      COALESCE(u.conversion_factor, 1) AS conversionFactor, l.quantity,
      l.quantity * COALESCE(u.conversion_factor, 1) AS canonicalQuantity,
      l.unit_cost_pesewas AS unitCostPesewas,
      l.quantity * l.unit_cost_pesewas AS lineTotalPesewas,
      p.cost_price_pesewas AS currentCanonicalCostPesewas,
      ROUND(CAST(l.unit_cost_pesewas AS REAL) / COALESCE(u.conversion_factor, 1)) AS proposedCanonicalCostPesewas
    FROM stock_receipt_request_lines l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN product_units u ON u.id = l.source_unit_id
    WHERE l.request_id = ? ORDER BY l.line_number`).all(requestId) as StockReceiptRequestDetail['lines'];
  const accum = new Map<string, { name: string; oldCost: number; qty: number; value: number }>();
  for (const line of lines) {
    const current = accum.get(line.productId) ?? { name: line.productName, oldCost: line.currentCanonicalCostPesewas, qty: 0, value: 0 };
    current.qty += line.canonicalQuantity; current.value += line.lineTotalPesewas; accum.set(line.productId, current);
  }
  const costSwingWarnings: string[] = [];
  for (const [productId, value] of accum) {
    const proposed = value.qty ? Math.round(value.value / value.qty) : 0;
    // Multiple request lines can reference the same product at different
    // purchase-unit costs. The receiving core writes one weighted cost for
    // that product, so every line must preview that exact aggregate rather
    // than misleadingly showing its own per-line cost as the final result.
    for (const line of lines) {
      if (line.productId === productId) line.proposedCanonicalCostPesewas = proposed;
    }
    if (value.oldCost > 0 && (proposed > value.oldCost * 1.5 || proposed < value.oldCost * 0.5)) {
      costSwingWarnings.push(`${value.name}: ${value.oldCost} → ${proposed} pesewas per canonical unit`);
    }
  }
  return { ...mapSummary(row), lines, costSwingWarnings };
}

export function reviewStockReceiptRequest(db: DB, input: {
  requestId: string; decision: 'APPROVE' | 'DECLINE'; note?: string | null;
  allowLargeCostSwing?: boolean; reviewerWorkerId: string; deviceId: string;
}): StockReceiptRequestDetail {
  const reviewer = worker(db, input.reviewerWorkerId);
  if (!isSenior(reviewer.role)) throw new Error('Supervisor, owner, or founder approval required');
  const header = db.prepare(`SELECT * FROM stock_receipt_requests WHERE id = ?`).get(input.requestId) as any;
  if (!header) throw new Error('Stock receipt request not found');
  if (header.status !== 'PENDING') throw new Error(`Stock receipt request is already ${header.status.toLowerCase()}`);
  if (input.decision === 'APPROVE' && header.requested_by === input.reviewerWorkerId && reviewer.role === 'SUPERVISOR') {
    throw new Error('A supervisor cannot approve their own stock receipt request');
  }
  if (header.is_opening_stock === 1 && !OWNER_ROLES.has(reviewer.role)) {
    throw new Error('Opening stock requires owner or founder approval');
  }
  const note = trimmed(input.note);
  if (input.decision === 'DECLINE' && (note?.length ?? 0) < 3) throw new Error('A decline note of at least 3 characters is required');
  if ((note?.length ?? 0) > 300) throw new Error('Review note cannot exceed 300 characters');
  const lines = db.prepare(`SELECT product_id AS productId, source_unit_id AS unitId,
      quantity, unit_cost_pesewas AS unitCostPesewas FROM stock_receipt_request_lines
    WHERE request_id = ? ORDER BY line_number`).all(input.requestId) as StockReceiptLine[];
  const now = new Date().toISOString();
  db.transaction(() => {
    if (input.decision === 'DECLINE') {
      const result = db.prepare(`UPDATE stock_receipt_requests SET status = 'DECLINED', reviewed_by = ?,
        reviewed_at = ?, review_note = ?, review_device_id = ?, updated_at = ?, updated_by = ?
        WHERE id = ? AND status = 'PENDING'`).run(input.reviewerWorkerId, now, note, input.deviceId, now, input.reviewerWorkerId, input.requestId);
      if (result.changes !== 1) throw new Error('Stock receipt request was already reviewed');
      logAudit(db, { workerId: input.reviewerWorkerId, action: 'STOCK_RECEIPT_REQUEST_DECLINED', entityType: 'stock_receipt_requests', entityId: input.requestId, afterValue: { note }, deviceId: input.deviceId });
      return;
    }
    const received = receiveStock(db, {
      supplierId: header.supplier_id, isOpeningStock: header.is_opening_stock === 1,
      locationId: header.location_id, workerId: header.requested_by,
      supervisorApprovalId: input.reviewerWorkerId, purchaseOrderId: header.purchase_order_id,
      supplierInvoiceNumber: header.supplier_invoice_number, supplierInvoiceDate: header.supplier_invoice_date,
      supplierDueDate: header.supplier_due_date, transportCostPesewas: header.transport_cost_pesewas,
      loadingCostPesewas: header.loading_cost_pesewas, lines, notes: header.notes,
      allowLargeCostSwing: !!input.allowLargeCostSwing, deviceId: input.deviceId,
    });
    const result = db.prepare(`UPDATE stock_receipt_requests SET status = 'APPROVED', reviewed_by = ?,
      reviewed_at = ?, review_note = ?, review_device_id = ?, cost_swing_approved = ?,
      supplier_invoice_id = ?, movement_ids_json = ?, total_value_pesewas = ?,
      total_payable_pesewas = ?, products_cost_updated = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'PENDING'`).run(input.reviewerWorkerId, now, note, input.deviceId,
        input.allowLargeCostSwing ? 1 : 0, received.supplierInvoiceId, JSON.stringify(received.movementIds),
        received.totalValuePesewas, received.totalPayablePesewas, received.productsUpdated,
        now, input.reviewerWorkerId, input.requestId);
    if (result.changes !== 1) throw new Error('Stock receipt request was already reviewed');
    logAudit(db, { workerId: input.reviewerWorkerId, action: 'STOCK_RECEIPT_REQUEST_APPROVED', entityType: 'stock_receipt_requests', entityId: input.requestId,
      afterValue: { requesterWorkerId: header.requested_by, movementCount: received.movementIds.length,
        totalValuePesewas: received.totalValuePesewas, totalPayablePesewas: received.totalPayablePesewas,
        supplierInvoiceId: received.supplierInvoiceId, costSwingApproved: !!input.allowLargeCostSwing,
        selfApproved: header.requested_by === input.reviewerWorkerId }, deviceId: input.deviceId });
  })();
  return getStockReceiptRequest(db, input.requestId, input.reviewerWorkerId);
}

export function withdrawStockReceiptRequest(db: DB, input: {
  requestId: string; requesterWorkerId: string; deviceId: string;
}): StockReceiptRequestDetail {
  worker(db, input.requesterWorkerId);
  const now = new Date().toISOString();
  db.transaction(() => {
    const result = db.prepare(`UPDATE stock_receipt_requests SET status = 'WITHDRAWN', withdrawn_at = ?,
      updated_at = ?, updated_by = ? WHERE id = ? AND requested_by = ? AND status = 'PENDING'`)
      .run(now, now, input.requesterWorkerId, input.requestId, input.requesterWorkerId);
    if (result.changes !== 1) throw new Error('Only the requester can withdraw a pending stock receipt request');
    logAudit(db, { workerId: input.requesterWorkerId, action: 'STOCK_RECEIPT_REQUEST_WITHDRAWN', entityType: 'stock_receipt_requests', entityId: input.requestId, deviceId: input.deviceId });
  })();
  return getStockReceiptRequest(db, input.requestId, input.requesterWorkerId);
}

export function stockReceiptRequestPendingCount(db: DB, actorWorkerId: string): {
  minePendingCount: number; reviewablePendingCount: number;
} {
  const actor = worker(db, actorWorkerId);
  const mine = (db.prepare(`SELECT COUNT(*) AS n FROM stock_receipt_requests WHERE requested_by = ? AND status = 'PENDING'`).get(actorWorkerId) as { n: number }).n;
  const reviewable = isSenior(actor.role)
    ? (db.prepare(`SELECT COUNT(*) AS n FROM stock_receipt_requests WHERE status = 'PENDING'`).get() as { n: number }).n
    : 0;
  return { minePendingCount: mine, reviewablePendingCount: reviewable };
}
