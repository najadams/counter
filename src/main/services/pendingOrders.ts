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
import { VAT_ENABLED } from '../../shared/lib/vat.js';

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

function taxableSql(expr: string): string {
  return VAT_ENABLED ? `ROUND((${expr}) * 10000.0 / 12000.0)` : `(${expr})`;
}

function lineNetRevenueSql(): string {
  if (!VAT_ENABLED) return 'sl.line_total_pesewas';
  return `CASE
            WHEN s.taxable_pesewas > 0 AND s.subtotal_pesewas > 0
              THEN ROUND(s.taxable_pesewas * sl.line_total_pesewas * 1.0 / s.subtotal_pesewas)
            ELSE ${taxableSql('sl.line_total_pesewas')}
          END`;
}

function lineNetCogsSql(): string {
  return taxableSql('sl.unit_cost_pesewas * sl.quantity');
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
  deliveryStatus: string;
  driverId: string | null;
  driverName: string | null;
  deliveryFeePesewas: number;
  deliveryCostPesewas: number;
  deliveryProfitPesewas: number | null;
}

export interface PendingOrderDetail extends PendingOrderSummary {
  subtotalPesewas: number;
  confirmedAt: string | null;
  lines: PendingOrderLine[];
  fulfilledSaleId: string | null;
  rejectReason: string | null;
  packedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryFailedAt: string | null;
  deliveryFailureReason: string | null;
  deliveryConfirmationCode: string | null;
  deliveryConfirmationName: string | null;
}

interface RawRow {
  id: string; status: string; customer_phone: string; customer_name: string | null;
  channel: string; subtotal_pesewas: number; total_pesewas: number;
  quote_expires_at: string | null; confirmed_at: string | null; received_at: string;
  lines_json: string; fulfilled_sale_id: string | null; reject_reason: string | null;
  delivery_status: string; driver_id: string | null; driver_name: string | null;
  delivery_fee_pesewas: number; delivery_cost_pesewas: number; delivery_profit_pesewas: number | null;
  packed_at: string | null; dispatched_at: string | null; delivered_at: string | null;
  delivery_failed_at: string | null; delivery_failure_reason: string | null;
  delivery_confirmation_code: string | null; delivery_confirmation_name: string | null;
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
    deliveryStatus: r.delivery_status,
    driverId: r.driver_id,
    driverName: r.driver_name,
    deliveryFeePesewas: r.delivery_fee_pesewas,
    deliveryCostPesewas: r.delivery_cost_pesewas,
    deliveryProfitPesewas: r.delivery_profit_pesewas,
    packedAt: r.packed_at,
    dispatchedAt: r.dispatched_at,
    deliveredAt: r.delivered_at,
    deliveryFailedAt: r.delivery_failed_at,
    deliveryFailureReason: r.delivery_failure_reason,
    deliveryConfirmationCode: r.delivery_confirmation_code,
    deliveryConfirmationName: r.delivery_confirmation_name,
  };
}

const ROW_COLS = `id, status, customer_phone, customer_name, channel,
  subtotal_pesewas, total_pesewas, quote_expires_at, confirmed_at, received_at,
  lines_json, fulfilled_sale_id, reject_reason,
  delivery_status, driver_id,
  (SELECT full_name FROM workers w WHERE w.id = pending_orders.driver_id) AS driver_name,
  delivery_fee_pesewas, delivery_cost_pesewas, delivery_profit_pesewas,
  packed_at, dispatched_at, delivered_at, delivery_failed_at, delivery_failure_reason,
  delivery_confirmation_code, delivery_confirmation_name`;

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

export function listDeliveryOrders(db: DB): PendingOrderSummary[] {
  const rows = db.prepare(
    `SELECT ${ROW_COLS}
      FROM pending_orders
      WHERE status = 'FULFILLED'
        AND delivery_status IN ('NOT_STARTED','PACKED','DISPATCHED','DELIVERED','FAILED')
      ORDER BY COALESCE(dispatched_at, packed_at, delivered_at, updated_at) DESC`,
  ).all() as RawRow[];
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

export function markPendingOrderPacked(
  db: DB,
  input: { orderId: string; workerId: string; deviceId: string },
): void {
  const row = db.prepare('SELECT status, delivery_status FROM pending_orders WHERE id = ?').get(input.orderId) as
    | { status: string; delivery_status: string } | undefined;
  if (!row) throw new Error(`markPendingOrderPacked: order ${input.orderId} not found`);
  if (row.status !== 'FULFILLED') throw new Error(`markPendingOrderPacked: order must be fulfilled by a sale first`);
  if (!['NOT_STARTED', 'FAILED'].includes(row.delivery_status)) {
    throw new Error(`markPendingOrderPacked: order delivery is ${row.delivery_status}`);
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pending_orders
        SET delivery_status = 'PACKED', packed_at = ?, packed_by = ?,
            delivery_failed_at = NULL, delivery_failure_reason = NULL,
            updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(now, input.workerId, now, input.workerId, input.orderId);
  auditDelivery(db, input.workerId, input.deviceId, input.orderId, 'WHATSAPP_ORDER_PACKED', {});
}

export function markPendingOrderDispatched(
  db: DB,
  input: { orderId: string; driverId: string; deliveryFeePesewas?: number; deliveryCostPesewas?: number; workerId: string; deviceId: string },
): void {
  const fee = input.deliveryFeePesewas ?? 0;
  const cost = input.deliveryCostPesewas ?? 0;
  if (!Number.isInteger(fee) || fee < 0) throw new Error('deliveryFeePesewas must be a non-negative integer');
  if (!Number.isInteger(cost) || cost < 0) throw new Error('deliveryCostPesewas must be a non-negative integer');
  const row = db.prepare('SELECT status, delivery_status FROM pending_orders WHERE id = ?').get(input.orderId) as
    | { status: string; delivery_status: string } | undefined;
  if (!row) throw new Error(`markPendingOrderDispatched: order ${input.orderId} not found`);
  if (row.status !== 'FULFILLED') throw new Error(`markPendingOrderDispatched: order must be fulfilled by a sale first`);
  if (row.delivery_status !== 'PACKED') throw new Error(`markPendingOrderDispatched: order must be packed first`);
  const driver = db.prepare(
    `SELECT id, active, deleted_at, terminated_at FROM workers WHERE id = ?`,
  ).get(input.driverId) as { id: string; active: number; deleted_at: string | null; terminated_at: string | null } | undefined;
  if (!driver || driver.active !== 1 || driver.deleted_at || driver.terminated_at) {
    throw new Error(`markPendingOrderDispatched: driver ${input.driverId} not active`);
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pending_orders
        SET delivery_status = 'DISPATCHED', dispatched_at = ?, dispatched_by = ?,
            driver_id = ?, delivery_fee_pesewas = ?, delivery_cost_pesewas = ?,
            updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(now, input.workerId, input.driverId, fee, cost, now, input.workerId, input.orderId);
  auditDelivery(db, input.workerId, input.deviceId, input.orderId, 'WHATSAPP_ORDER_DISPATCHED', {
    driverId: input.driverId, deliveryFeePesewas: fee, deliveryCostPesewas: cost,
  });
}

export function completePendingOrderDelivery(
  db: DB,
  input: {
    orderId: string; outcome: 'DELIVERED' | 'FAILED';
    confirmationCode?: string | null; confirmationName?: string | null; failureReason?: string | null;
    workerId: string; deviceId: string;
  },
): { deliveryProfitPesewas: number | null } {
  const row = db.prepare(
    `SELECT delivery_status, fulfilled_sale_id, delivery_fee_pesewas, delivery_cost_pesewas
       FROM pending_orders WHERE id = ?`,
  ).get(input.orderId) as
    | { delivery_status: string; fulfilled_sale_id: string | null; delivery_fee_pesewas: number; delivery_cost_pesewas: number }
    | undefined;
  if (!row) throw new Error(`completePendingOrderDelivery: order ${input.orderId} not found`);
  if (row.delivery_status !== 'DISPATCHED') throw new Error(`completePendingOrderDelivery: order must be dispatched first`);
  const now = new Date().toISOString();
  if (input.outcome === 'FAILED') {
    const reason = input.failureReason?.trim();
    if (!reason) throw new Error('completePendingOrderDelivery: failure reason required');
    db.prepare(
      `UPDATE pending_orders
          SET delivery_status = 'FAILED', delivery_failed_at = ?,
              delivery_failure_reason = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(now, reason, now, input.workerId, input.orderId);
    auditDelivery(db, input.workerId, input.deviceId, input.orderId, 'WHATSAPP_ORDER_DELIVERY_FAILED', { reason });
    return { deliveryProfitPesewas: null };
  }

  const confirmationCode = input.confirmationCode?.trim() || null;
  const netRevenue = lineNetRevenueSql();
  const netCogs = lineNetCogsSql();
  const margin = row.fulfilled_sale_id
    ? (db.prepare(
      `SELECT COALESCE(SUM(${netRevenue} - ${netCogs}), 0) AS margin
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
        WHERE sl.sale_id = ?`,
    ).get(row.fulfilled_sale_id) as { margin: number }).margin
    : 0;
  const deliveryProfit = margin + row.delivery_fee_pesewas - row.delivery_cost_pesewas;
  db.prepare(
    `UPDATE pending_orders
        SET delivery_status = 'DELIVERED', delivered_at = ?, delivered_by = ?,
            delivery_confirmation_code = ?, delivery_confirmation_name = ?,
            delivery_profit_pesewas = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(
    now, input.workerId, confirmationCode, input.confirmationName?.trim() || null,
    deliveryProfit, now, input.workerId, input.orderId,
  );
  auditDelivery(db, input.workerId, input.deviceId, input.orderId, 'WHATSAPP_ORDER_DELIVERED', {
    confirmationCode, deliveryProfitPesewas: deliveryProfit,
  });
  return { deliveryProfitPesewas: deliveryProfit };
}

function auditDelivery(db: DB, workerId: string, deviceId: string, orderId: string, action: string, afterValue: object): void {
  logAudit(db, {
    workerId,
    action,
    entityType: 'pending_orders',
    entityId: orderId,
    afterValue,
    deviceId,
  });
}
