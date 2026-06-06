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
] as const;

export type SyncedEventTable = (typeof SYNCED_EVENT_TABLES)[number];

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
