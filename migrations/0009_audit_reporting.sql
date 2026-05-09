-- 0009_audit_reporting.sql
-- Append-only audit log + pre-computed daily and worker-monthly summaries.
--
-- audit_log: SQLite has no GRANT, so INSERT-only is enforced at the
-- application layer. Only logAudit() writes here. No service ever UPDATE/DELETEs.

PRAGMA foreign_keys = ON;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  action TEXT NOT NULL,                          -- e.g. SALE_COMPLETED, SALE_VOIDED
  entity_type TEXT NOT NULL,                     -- e.g. 'sales', 'products'
  entity_id TEXT NOT NULL,
  before_value TEXT,                             -- JSON; null on create actions
  after_value TEXT,                              -- JSON; null on delete actions
  device_id TEXT NOT NULL,
  ip_address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- audit_log has NO updated_at / updated_by — it is append-only.
  CHECK (before_value IS NULL OR json_valid(before_value)),
  CHECK (after_value IS NULL OR json_valid(after_value))
);
CREATE INDEX idx_audit_worker_date ON audit_log(worker_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);

-- daily_summaries -----------------------------------------------------------
-- Pre-computed end-of-day digest. Generated nightly.
-- Pushback fix #2: shrinkage_rate is computed against expected vs. counted
-- stock at physical stocktake, not from declared losses. The stocktake
-- screen feeds this.
CREATE TABLE daily_summaries (
  id TEXT PRIMARY KEY,
  summary_date TEXT NOT NULL UNIQUE,             -- 'YYYY-MM-DD'
  location_id TEXT NOT NULL REFERENCES locations(id),
  total_revenue_pesewas INTEGER NOT NULL,
  total_cost_of_goods_sold_pesewas INTEGER NOT NULL,
  gross_margin_pesewas INTEGER NOT NULL,
  total_breakage_value_pesewas INTEGER NOT NULL,
  total_consumption_value_pesewas INTEGER NOT NULL,
  cash_count_variance_pesewas INTEGER NOT NULL,
  -- stocktake-derived shrinkage (true unexplained loss).
  -- NULL on days no stocktake occurred; the value carries over from last
  -- stocktake when the report is rendered.
  stocktake_shrinkage_value_pesewas INTEGER,
  stocktake_shrinkage_rate REAL,
  credit_extended_pesewas INTEGER NOT NULL,
  credit_collected_pesewas INTEGER NOT NULL,
  total_outstanding_credit_pesewas INTEGER NOT NULL,
  num_sales INTEGER NOT NULL,
  num_unique_customers INTEGER NOT NULL,
  top_skus_json TEXT NOT NULL,                   -- JSON array, top 5 by revenue
  reorder_alerts_json TEXT NOT NULL,             -- JSON array of low-stock SKUs
  shift_summaries_json TEXT NOT NULL,            -- JSON array, per-shift breakdown
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  whatsapp_sent_at TEXT,
  CHECK (json_valid(top_skus_json)),
  CHECK (json_valid(reorder_alerts_json)),
  CHECK (json_valid(shift_summaries_json))
);
CREATE INDEX idx_daily_summaries_date ON daily_summaries(summary_date DESC);
CREATE INDEX idx_daily_summaries_location_date ON daily_summaries(location_id, summary_date DESC);

CREATE TABLE worker_monthly_performance (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  month TEXT NOT NULL,                           -- 'YYYY-MM-01'
  total_sales_pesewas INTEGER NOT NULL,
  total_shifts INTEGER NOT NULL,
  total_breakage_value_pesewas INTEGER NOT NULL,
  total_shrinkage_value_pesewas INTEGER NOT NULL,
  shrinkage_rate REAL NOT NULL,
  consumption_units_used INTEGER NOT NULL,
  consumption_units_allowed INTEGER NOT NULL,
  cash_variance_pesewas INTEGER NOT NULL,
  bonus_earned_pesewas INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(worker_id, month)
);
CREATE INDEX idx_wmp_worker_month ON worker_monthly_performance(worker_id, month DESC);
CREATE INDEX idx_wmp_month ON worker_monthly_performance(month DESC);

-- pending_receipt_reprints --------------------------------------------------
-- Pushback fix #3 (printer degraded mode): when sales.printer_failed = 1,
-- a row lands here for the supervisor to clear once the printer is fixed.
CREATE TABLE pending_receipt_reprints (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  reason TEXT NOT NULL,                          -- 'PRINTER_OFFLINE','OUT_OF_PAPER','JAMMED','OTHER'
  resolved_at TEXT,
  resolved_by TEXT REFERENCES workers(id),
  resolution_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK ((resolved_at IS NULL AND resolved_by IS NULL)
      OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX idx_pending_reprints_open ON pending_receipt_reprints(created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_pending_reprints_sale ON pending_receipt_reprints(sale_id);
