// pendingOrders.ts — Phase 4 workstream C: shop-side accept/reject of
// WhatsApp orders synced down from the central store into pending_orders.
//
// "Accept" has NO dedicated function here. Accepting an order means loading
// its quoted lines into the cart and ringing it through the NORMAL
// completeSale path (see the renderer's PendingOrdersScreen) — every
// existing guard (price floor, canonical stock movements, receipt, audit)
// applies unchanged, exactly as if the cashier had typed the order in fresh.
// This module covers only what's specific to the queue itself: listing,
// reading one, rejecting, and recording fulfilment after a sale completes.
//
// No supervisor gate on reject or fulfilment-recording: neither moves stock
// or money — declining an order before anything was rung, or stamping the
// sale id after completeSale already ran its own checks, has no independent
// financial stake that would call for one.

import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';
import { unitsOnHand } from './stockMovements.js';

export interface PendingOrderLine {
  productId: string;
  /** Best-effort local catalog lookup for display — "Unknown product" if the
   *  id doesn't resolve (deleted locally, or the catalog mirror hasn't caught
   *  up yet). Never throws: a cashier must be able to REVIEW an order even if
   *  one line looks off; resolvePendingOrderForCart is the strict version
   *  that gates actually ACCEPTING it. */
  productName: string;
  unitId: string | null;
  unitName: string;
  quantity: number;
  unitPricePesewas: number;
  lineTotalPesewas: number;
}

export interface PendingOrderSummary {
  id: string;
  status: string;
  customerPhone: string;
  customerName: string | null;
  channel: string;
  totalPesewas: number;
  quoteExpiresAt: string | null;
  receivedAt: string;
  lineCount: number;
}

export interface PendingOrderDetail extends PendingOrderSummary {
  subtotalPesewas: number;
  confirmedAt: string | null;
  lines: PendingOrderLine[];
  fulfilledSaleId: string | null;
  rejectReason: string | null;
}

interface RawRow {
  id: string; status: string; customer_phone: string; customer_name: string | null;
  channel: string; subtotal_pesewas: number; total_pesewas: number;
  quote_expires_at: string | null; confirmed_at: string | null; received_at: string;
  lines_json: string; fulfilled_sale_id: string | null; reject_reason: string | null;
}

/** Raw shape stored in lines_json (pullOrders.ts's applyOrders writes this —
 *  ids/prices only, no display names, since those can drift from the catalog
 *  and are resolved fresh at read time instead of frozen at pull time). */
interface StoredLine {
  productId: string; unitId: string | null; quantity: number;
  unitPricePesewas: number; lineTotalPesewas: number;
}

function resolveLineNames(db: DB, l: StoredLine): PendingOrderLine {
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(l.productId) as
    | { name: string } | undefined;
  let unitName = 'UNIT';
  if (l.unitId) {
    const unit = db.prepare('SELECT unit_name AS unitName FROM product_units WHERE id = ?').get(l.unitId) as
      | { unitName: string } | undefined;
    if (unit) unitName = unit.unitName;
  }
  return { ...l, productName: product?.name ?? 'Unknown product', unitName };
}

function toDetail(db: DB, r: RawRow): PendingOrderDetail {
  const stored = JSON.parse(r.lines_json) as StoredLine[];
  const lines = stored.map((l) => resolveLineNames(db, l));
  return {
    id: r.id, status: r.status, customerPhone: r.customer_phone, customerName: r.customer_name,
    channel: r.channel, subtotalPesewas: r.subtotal_pesewas, totalPesewas: r.total_pesewas,
    quoteExpiresAt: r.quote_expires_at, confirmedAt: r.confirmed_at, receivedAt: r.received_at,
    lines, lineCount: lines.length,
    fulfilledSaleId: r.fulfilled_sale_id, rejectReason: r.reject_reason,
  };
}

const ROW_COLS = `id, status, customer_phone, customer_name, channel,
  subtotal_pesewas, total_pesewas, quote_expires_at, confirmed_at, received_at,
  lines_json, fulfilled_sale_id, reject_reason`;

/** Orders awaiting a shop decision, oldest first — a FIFO queue reads
 *  naturally as "what's been waiting longest". Defaults to just CONFIRMED
 *  (the actionable queue); pass statuses to also see REJECTED/FULFILLED
 *  history if a screen ever wants that. */
export function listPendingOrders(db: DB, opts: { statuses?: string[] } = {}): PendingOrderSummary[] {
  const statuses = opts.statuses ?? ['CONFIRMED'];
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT ${ROW_COLS} FROM pending_orders WHERE status IN (${placeholders}) ORDER BY received_at ASC`,
  ).all(...statuses) as RawRow[];
  return rows.map((r) => toDetail(db, r));
}

export function getPendingOrder(db: DB, orderId: string): PendingOrderDetail | null {
  const r = db.prepare(`SELECT ${ROW_COLS} FROM pending_orders WHERE id = ?`).get(orderId) as RawRow | undefined;
  return r ? toDetail(db, r) : null;
}

export interface RejectPendingOrderInput {
  orderId: string;
  reason: string;
  workerId: string;
  deviceId: string;
}

/** Decline a CONFIRMED order. The reason travels up to the central store
 *  (via the normal outbox -> writeback trigger) so the agent can give the
 *  customer an honest explanation instead of a generic "cancelled". */
export function rejectPendingOrder(db: DB, input: RejectPendingOrderInput): void {
  const reason = input.reason.trim();
  if (!reason) throw new Error('rejectPendingOrder: a reason is required');

  const row = db.prepare('SELECT status FROM pending_orders WHERE id = ?').get(input.orderId) as
    | { status: string } | undefined;
  if (!row) throw new Error(`rejectPendingOrder: order ${input.orderId} not found`);
  if (row.status !== 'CONFIRMED') {
    throw new Error(`rejectPendingOrder: order is ${row.status}, cannot reject`);
  }

  const now = new Date().toISOString();
  // Optimistic concurrency: two devices (e.g. two staff phones) could both
  // be looking at the same order. The WHERE re-checks status='CONFIRMED' at
  // write time, not just at the read above, so only the first decision wins.
  const result = db.prepare(
    `UPDATE pending_orders
        SET status = 'REJECTED', reject_reason = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'CONFIRMED'`,
  ).run(reason, now, input.workerId, input.orderId);
  if (result.changes === 0) {
    throw new Error(`rejectPendingOrder: order ${input.orderId} changed concurrently — reload and retry`);
  }

  logAudit(db, {
    workerId: input.workerId,
    action: 'WHATSAPP_ORDER_REJECTED',
    entityType: 'pending_orders',
    entityId: input.orderId,
    afterValue: { reason },
    deviceId: input.deviceId,
  });
}

export interface ResolvedCartLine {
  productId: string;
  sku: string;
  name: string;
  unitId: string | null;
  unitName: string;
  factor: number;
  unitPricePesewas: number;
  quantity: number;
  unitsOnHand: number;
}

export interface ResolvedPendingOrder {
  orderId: string;
  channel: string;
  customerName: string | null;
  customerPhone: string;
  lines: ResolvedCartLine[];
}

/** Resolve a CONFIRMED order's central product/unit ids into the local
 *  catalog details the cart needs (sku, name, unit name, conversion factor,
 *  current on-hand) — same JOIN shape as getSaleWithLines's duplicate-as-new
 *  flow (sales.ts), so "accept this WhatsApp order" and "duplicate a past
 *  sale" land the cashier in an identically-shaped prefilled cart.
 *
 *  Throws if a line's product no longer resolves locally (deleted, or the
 *  catalog mirror hasn't caught up) — surfacing that loudly beats silently
 *  dropping a line the customer paid to see quoted. */
export function resolvePendingOrderForCart(db: DB, orderId: string, locationId: string): ResolvedPendingOrder {
  const order = getPendingOrder(db, orderId);
  if (!order) throw new Error(`resolvePendingOrderForCart: order ${orderId} not found`);
  if (order.status !== 'CONFIRMED') {
    throw new Error(`resolvePendingOrderForCart: order is ${order.status}, cannot accept`);
  }

  const lines: ResolvedCartLine[] = order.lines.map((l) => {
    const product = db.prepare(
      `SELECT sku, name FROM products WHERE id = ? AND deleted_at IS NULL`,
    ).get(l.productId) as { sku: string; name: string } | undefined;
    if (!product) {
      throw new Error(`resolvePendingOrderForCart: product ${l.productId} not found in the local catalog`);
    }
    let unitName = 'UNIT';
    let factor = 1;
    if (l.unitId) {
      const unit = db.prepare(
        `SELECT unit_name AS unitName, conversion_factor AS factor FROM product_units WHERE id = ?`,
      ).get(l.unitId) as { unitName: string; factor: number } | undefined;
      if (!unit) {
        throw new Error(`resolvePendingOrderForCart: unit ${l.unitId} not found in the local catalog`);
      }
      unitName = unit.unitName;
      factor = unit.factor;
    }
    return {
      productId: l.productId, sku: product.sku, name: product.name,
      unitId: l.unitId, unitName, factor,
      unitPricePesewas: l.unitPricePesewas, quantity: l.quantity,
      unitsOnHand: unitsOnHand(db, l.productId, locationId),
    };
  });

  return { orderId, channel: order.channel, customerName: order.customerName, customerPhone: order.customerPhone, lines };
}

export interface MarkPendingOrderFulfilledInput {
  orderId: string;
  saleId: string;
  workerId: string;
  deviceId: string;
}

/** Record that a CONFIRMED order was rung — called by the renderer right
 *  after completeSale succeeds for a cart that was loaded from this order.
 *  Purely a status/linkage stamp; completeSale already did every real check
 *  (price floor, stock, payment) before this ever runs. */
export function markPendingOrderFulfilled(db: DB, input: MarkPendingOrderFulfilledInput): void {
  const row = db.prepare('SELECT status FROM pending_orders WHERE id = ?').get(input.orderId) as
    | { status: string } | undefined;
  if (!row) throw new Error(`markPendingOrderFulfilled: order ${input.orderId} not found`);
  if (row.status !== 'CONFIRMED') {
    throw new Error(`markPendingOrderFulfilled: order is ${row.status}, cannot mark fulfilled`);
  }

  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE pending_orders
        SET status = 'FULFILLED', fulfilled_sale_id = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'CONFIRMED'`,
  ).run(input.saleId, now, input.workerId, input.orderId);
  if (result.changes === 0) {
    throw new Error(`markPendingOrderFulfilled: order ${input.orderId} changed concurrently`);
  }

  logAudit(db, {
    workerId: input.workerId,
    action: 'WHATSAPP_ORDER_FULFILLED',
    entityType: 'pending_orders',
    entityId: input.orderId,
    afterValue: { saleId: input.saleId },
    deviceId: input.deviceId,
  });
}
