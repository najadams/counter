-- 0010_indexes.sql
-- Cross-cutting analytical indexes that didn't fit naturally on a single
-- table's migration. Kept thin in v1 — most indexes live with their tables.

PRAGMA foreign_keys = ON;

-- Common nightly-summary aggregation: by date, all sales.
CREATE INDEX idx_sales_created_date ON sales(date(created_at), location_id) WHERE voided = 0;

-- Stock movement totals by (product, location, day) — speeds the per-day
-- "where did the stock go" report.
CREATE INDEX idx_stock_movements_product_day ON stock_movements(product_id, location_id, date(created_at));

-- Common audit query: "what did this worker do today".
CREATE INDEX idx_audit_worker_day ON audit_log(worker_id, date(created_at));
