// Reorder suggestions.
//
// Walks active products whose on-hand canonical quantity is at/below
// reorder_threshold, optionally filtered by primary_supplier_id, and
// proposes a reorder quantity per item.
//
// "Suggested" quantity uses a simple heuristic: reach reorder_threshold
// again plus a safety stock of 50% (rounded up). We don't try to forecast
// demand here — the supplier reps in this trade still write the order in
// person on a triplicate book; this surface saves dad from walking the
// shelves to spot what's running low.
//
// Once the cashier/owner confirms a list, createDraftPO() produces a
// DRAFT purchase_orders row + purchase_order_lines using the Session 7
// schema. The PO can then be PLACED later through whatever PO flow exists.
//
// OWNER/FOUNDER only (PO creation). Supervisors can VIEW suggestions.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';

const VIEW_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);
const CREATE_ROLES = new Set(['OWNER', 'FOUNDER']);

function requireRole(db: DB, actorId: string, allowed: Set<string>): string {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!allowed.has(w.role)) {
    throw new Error(
      `role ${w.role} not permitted (need one of: ${[...allowed].join(', ')})`,
    );
  }
  return w.role;
}

export interface ReorderSuggestion {
  productId: string;
  sku: string;
  productName: string;
  primarySupplierId: string | null;
  primarySupplierName: string | null;
  currentOnHand: number;
  reorderThreshold: number;
  suggestedQty: number;
  lastCostPesewas: number;
  suggestedLineValuePesewas: number;
}

export interface SuggestReorderInput {
  locationId: string;
  /** When set, only products whose primary_supplier_id matches. When null,
   *  returns ALL low-stock products including those without a primary supplier. */
  supplierId?: string | null;
  /** Multiplier on (threshold - on_hand). Default 1.5 — restock to 150% of
   *  threshold so a normal week's sales don't drop below threshold again. */
  safetyMultiplier?: number;
  actorWorkerId: string;
}

export function suggestReorders(
  db: DB,
  input: SuggestReorderInput,
): ReorderSuggestion[] {
  requireRole(db, input.actorWorkerId, VIEW_ROLES);
  const safety = input.safetyMultiplier ?? 1.5;

  const where: string[] = ['p.active = 1', 'p.deleted_at IS NULL', 'p.reorder_threshold > 0'];
  const params: unknown[] = [];

  if (input.supplierId !== undefined) {
    if (input.supplierId === null) {
      // Explicitly: products with NO primary supplier
      where.push('p.primary_supplier_id IS NULL');
    } else {
      where.push('p.primary_supplier_id = ?');
      params.push(input.supplierId);
    }
  }

  // On-hand from stock_movements summed in canonical units. Subquery joins
  // to filter by location and to allow a HAVING clause on the result.
  const rows = db.prepare(
    `SELECT p.id AS productId, p.sku, p.name AS productName,
            p.primary_supplier_id AS primarySupplierId,
            s.name AS primarySupplierName,
            p.reorder_threshold AS reorderThreshold,
            p.cost_price_pesewas AS lastCostPesewas,
            COALESCE((
              SELECT SUM(sm.quantity)
                FROM stock_movements sm
               WHERE sm.product_id = p.id
                 AND sm.location_id = ?
            ), 0) AS currentOnHand
       FROM products p
       LEFT JOIN suppliers s ON s.id = p.primary_supplier_id
      WHERE ${where.join(' AND ')}`,
  ).all(input.locationId, ...params) as Array<{
    productId: string; sku: string; productName: string;
    primarySupplierId: string | null; primarySupplierName: string | null;
    reorderThreshold: number; lastCostPesewas: number; currentOnHand: number;
  }>;

  return rows
    .filter((r) => r.currentOnHand <= r.reorderThreshold)
    .map((r) => {
      const shortBy = r.reorderThreshold - r.currentOnHand;
      const suggestedQty = Math.max(1, Math.ceil(shortBy * safety));
      return {
        ...r,
        suggestedQty,
        suggestedLineValuePesewas: suggestedQty * r.lastCostPesewas,
      };
    })
    .sort((a, b) => {
      // Surface most-urgent first: smallest on-hand relative to threshold.
      const ratioA = a.reorderThreshold > 0 ? a.currentOnHand / a.reorderThreshold : 0;
      const ratioB = b.reorderThreshold > 0 ? b.currentOnHand / b.reorderThreshold : 0;
      return ratioA - ratioB;
    });
}

export interface CreateDraftPOLine {
  productId: string;
  quantity: number;
  unitCostPesewas: number;
}

export interface CreateDraftPOInput {
  supplierId: string;
  locationId: string;
  lines: CreateDraftPOLine[];
  notes?: string | null;
  expectedDeliveryDate?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export interface CreateDraftPOResult {
  poId: string;
  poNumber: string;
  totalOrderedPesewas: number;
}

export function createDraftPO(
  db: DB,
  input: CreateDraftPOInput,
): CreateDraftPOResult {
  requireRole(db, input.actorWorkerId, CREATE_ROLES);
  if (!input.lines.length) throw new Error('createDraftPO: at least one line required');

  const supplier = db
    .prepare('SELECT id, name, active, deleted_at FROM suppliers WHERE id = ?')
    .get(input.supplierId) as { id: string; name: string; active: number; deleted_at: string | null } | undefined;
  if (!supplier || supplier.active !== 1 || supplier.deleted_at) {
    throw new Error(`createDraftPO: supplier ${input.supplierId} not found or inactive`);
  }

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`createDraftPO: quantity must be a positive integer`);
    }
    if (!Number.isInteger(line.unitCostPesewas) || line.unitCostPesewas < 0) {
      throw new Error(`createDraftPO: unitCostPesewas must be a non-negative integer`);
    }
  }

  // PO number: PO-{YYYYMMDD}-{4-char-suffix}. Unique across the system.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const poNumber = `PO-${today}-${uuidv4().slice(0, 4).toUpperCase()}`;
  const poId = `po-${uuidv4()}`;
  const totalOrdered = input.lines.reduce((s, l) => s + l.quantity * l.unitCostPesewas, 0);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchase_orders (
        id, supplier_id, location_id, status, po_number,
        expected_delivery_date, total_ordered_pesewas, notes,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      poId, input.supplierId, input.locationId, poNumber,
      input.expectedDeliveryDate ?? null, totalOrdered, input.notes?.trim() || null,
      input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );

    for (const line of input.lines) {
      db.prepare(
        `INSERT INTO purchase_order_lines (
          id, purchase_order_id, product_id, quantity_ordered,
          unit_cost_pesewas, line_total_ordered_pesewas,
          created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `pol-${uuidv4()}`, poId, line.productId, line.quantity,
        line.unitCostPesewas, line.quantity * line.unitCostPesewas,
        input.actorWorkerId, input.actorWorkerId, input.deviceId,
      );
    }

    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'PO_DRAFT_CREATED',
      entityType: 'purchase_orders',
      entityId: poId,
      afterValue: {
        supplierId: input.supplierId,
        supplierName: supplier.name,
        poNumber,
        lineCount: input.lines.length,
        totalOrderedPesewas: totalOrdered,
      },
      deviceId: input.deviceId,
    });
  });
  tx();

  return { poId, poNumber, totalOrderedPesewas: totalOrdered };
}

export interface DraftPOSummary {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  totalOrderedPesewas: number;
  lineCount: number;
  createdAt: string;
}

export function listDraftPOs(db: DB, actorId: string, locationId: string): DraftPOSummary[] {
  requireRole(db, actorId, VIEW_ROLES);
  return db.prepare(
    `SELECT po.id, po.po_number AS poNumber, po.supplier_id AS supplierId,
            s.name AS supplierName, po.status, po.total_ordered_pesewas AS totalOrderedPesewas,
            (SELECT COUNT(*) FROM purchase_order_lines pol WHERE pol.purchase_order_id = po.id) AS lineCount,
            po.created_at AS createdAt
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.location_id = ? AND po.status = 'DRAFT'
      ORDER BY po.created_at DESC`,
  ).all(locationId) as DraftPOSummary[];
}
