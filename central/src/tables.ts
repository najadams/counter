// The synced table sets, mirrored from the app's src/shared/sync.ts.
//
// KEEP IN SYNC with src/shared/sync.ts (SYNCED_EVENT_TABLES / SYNCED_MASTER_TABLES).
// They are duplicated here rather than imported so the central server stays a
// standalone deployable with no compile-time dependency on the Electron app.
// These lists change rarely; a row for an unknown table is still seq-logged for
// gap continuity but not stored (defense in depth).

export const EVENT_TABLES = [
  'sales', 'sale_lines', 'sale_payments', 'stock_movements', 'breakage_log',
  'worker_consumption_log', 'audit_log', 'customer_payments', 'customer_payment_allocations',
  'supplier_payments', 'supplier_payment_allocations', 'purchase_orders', 'purchase_order_lines',
  'cash_counts', 'shifts', 'stocktake_events', 'stocktake_lines', 'period_closes',
  'petty_cash_expenses', 'container_movements', 'customer_returns', 'customer_return_lines',
  'route_runs', 'route_stops', 'daily_summaries',
] as const;

export const MASTER_TABLES = [
  'products', 'product_units', 'pricing_tiers', 'promotions', 'suppliers', 'workers',
] as const;
