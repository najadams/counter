// Wire contract for shop -> central push sync (Phase 3b).
//
// The shop is the only writer of these (append-only) event rows; it ships them
// up to the central store, which is the union of every shop's activity. There
// is never a conflict because no two shops touch the same row.

/** The append-only event tables captured by sync_outbox (migration 0032).
 *  Single source of truth shared by the hydrator and the tests, which assert
 *  this list matches the triggers actually present in the DB. */
export const SYNCED_EVENT_TABLES = [
  'sales', 'sale_lines', 'sale_payments', 'stock_movements', 'breakage_log',
  'worker_consumption_log', 'audit_log', 'customer_payments', 'customer_payment_allocations',
  'supplier_payments', 'supplier_payment_allocations', 'purchase_orders', 'purchase_order_lines',
  'cash_counts', 'shifts', 'stocktake_events', 'stocktake_lines', 'period_closes',
  'petty_cash_expenses', 'container_movements', 'customer_returns', 'customer_return_lines',
  'route_runs', 'route_stops', 'daily_summaries',
  // Phase 4: WhatsApp order accept/reject/fulfil. Unlike every other table in
  // this list, pending_orders rows are MUTATED in place (CONFIRMED ->
  // FULFILLED|REJECTED|CANCELLED), not append-only — migration 0039 captures
  // both INSERT and UPDATE, where every other table here captures INSERT only.
  'pending_orders',
] as const;

export type SyncedEventTable = (typeof SYNCED_EVENT_TABLES)[number];

/** Subset of SYNCED_EVENT_TABLES whose rows are mutated in place after their
 *  initial insert, so they capture an UPDATE trigger too (migration 0039),
 *  unlike every other event table here which is genuinely append-only and
 *  only ever needs INSERT capture. Single source of truth for the "no drift"
 *  trigger-count test in tests/syncOutbox.test.ts. */
export const MUTABLE_EVENT_TABLES: readonly SyncedEventTable[] = ['pending_orders'];

export interface PushRow {
  seq: number;
  table: string;
  op: 'INSERT' | 'UPDATE';
  /** The full source row. Money stays integer pesewas; stock stays canonical. */
  data: Record<string, unknown>;
}

export interface PushBatch {
  shopId: string;
  rows: PushRow[];
}

export interface PushAck {
  /** Highest seq the central store has durably ingested for this shop. The
   *  shop marks its outbox acked up to this value. */
  ackedSeq: number;
}

/** What moves a batch to the central store. Injected so the worker is testable
 *  without a network, and the transport can be swapped (HTTP today). */
export interface SyncTransport {
  send(batch: PushBatch): Promise<PushAck>;
}

// --- Phase 3c: master/catalog distribution (HQ -> shops) -------------------

/** HQ-owned catalog tables that flow DOWN to shops. Captured only on HQ (see
 *  migration 0033) and applied on shops by upsert on id. Kept deliberately
 *  narrow; identity/credit-scoped tables are open questions (design B14). */
export const SYNCED_MASTER_TABLES = [
  'products', 'product_units', 'pricing_tiers', 'promotions', 'suppliers',
  // HQ-owned roster: flows down so catalog created_by/updated_by FKs resolve
  // on shops (migration 0034). Additive upsert; shop-local accounts untouched.
  'workers',
] as const;

export type SyncedMasterTable = (typeof SYNCED_MASTER_TABLES)[number];

export interface PullRow {
  /** Central-assigned monotonic cursor for this row. */
  cursor: number;
  table: string;
  data: Record<string, unknown>;
}

export interface PullResponse {
  rows: PullRow[];
  /** Highest cursor in this page; the shop persists it and asks for more. */
  cursor: number;
}

/** Pull side of sync: fetch catalog rows newer than `since`. Separate from
 *  SyncTransport (push) so push-only fakes stay valid. */
export interface PullTransport {
  fetchCatalog(since: number, limit?: number): Promise<PullResponse>;
}

// --- Phase 4: WhatsApp orders (agent -> central -> shop, DOWN) -------------
//
// Distinct from PullRow/PullResponse above: catalog rows are HQ-authored and
// upserted by bare id (any shop's catalog table); order rows are CONFIRMED
// orders addressed to THIS shop specifically, served by orders-feed (not
// catalog), and applied into pending_orders rather than a mirrored table.

export interface OrderPullLine {
  product_id: string;
  unit_id: string | null;
  quantity: number;
  unit_price_pesewas: number;
  line_total_pesewas: number;
}

export interface OrderPullData {
  id: string;
  status: string;
  customer_phone: string;
  customer_name: string | null;
  channel: string;
  subtotal_pesewas: number;
  total_pesewas: number;
  quote_expires_at: string;
  confirmed_at: string | null;
  created_by_agent: string;
  created_at: string;
  lines: OrderPullLine[];
}

export interface OrderPullRow {
  /** Central-assigned monotonic cursor (orders.seq, set once by confirm_order). */
  cursor: number;
  data: OrderPullData;
}

export interface OrdersPullResponse {
  rows: OrderPullRow[];
  cursor: number;
}

/** Separate from PullTransport (catalog) so a push/catalog-only fake transport
 *  stays valid without also having to fake order-pulling. */
export interface OrdersPullTransport {
  fetchOrders(since: number, limit?: number): Promise<OrdersPullResponse>;
}
