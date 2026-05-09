-- 0013_stocktake.sql
-- Physical stocktake: a parent event grouping per-product line counts.
-- Variance per line becomes a STOCKTAKE_VARIANCE_LOSS or STOCK_FOUND
-- stock_movement on completion (pushback fix #2 — this is what feeds
-- daily_summaries.stocktake_shrinkage_rate).

PRAGMA foreign_keys = ON;

CREATE TABLE stocktake_events (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
  started_by TEXT NOT NULL REFERENCES workers(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  cancelled_at TEXT,
  supervisor_approval_id TEXT REFERENCES workers(id),
  -- summary stats, computed at complete time
  total_loss_value_pesewas INTEGER NOT NULL DEFAULT 0,    -- positive = how much we lost
  total_found_value_pesewas INTEGER NOT NULL DEFAULT 0,    -- positive = surplus found
  total_expected_stock_value_pesewas INTEGER NOT NULL DEFAULT 0,
  products_counted INTEGER NOT NULL DEFAULT 0,
  products_with_variance INTEGER NOT NULL DEFAULT 0,
  shrinkage_rate REAL,                                     -- loss / expected, computed at complete
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  -- COMPLETED events must have completed_at + supervisor + a date in the past
  CHECK (
    (status = 'DRAFT' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND supervisor_approval_id IS NOT NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
  )
);
CREATE INDEX idx_stocktake_events_location_date ON stocktake_events(location_id, completed_at DESC) WHERE status = 'COMPLETED';
CREATE INDEX idx_stocktake_events_status ON stocktake_events(status);
-- One DRAFT per location at a time. Belt-and-suspenders against the app check.
CREATE UNIQUE INDEX idx_stocktake_events_one_draft_per_location
  ON stocktake_events(location_id) WHERE status = 'DRAFT';

CREATE TABLE stocktake_lines (
  id TEXT PRIMARY KEY,
  stocktake_event_id TEXT NOT NULL REFERENCES stocktake_events(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  expected_qty INTEGER NOT NULL,             -- snapshot at start
  counted_qty INTEGER,                       -- NULL until the worker counts
  variance INTEGER,                          -- counted - expected, signed; NULL until counted
  unit_cost_pesewas INTEGER NOT NULL,        -- snapshot at start
  variance_value_pesewas INTEGER,            -- signed; NULL until counted
  stock_movement_id TEXT,                    -- non-NULL after complete if variance != 0
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE(stocktake_event_id, product_id)
);
CREATE INDEX idx_stocktake_lines_event ON stocktake_lines(stocktake_event_id);
CREATE INDEX idx_stocktake_lines_product ON stocktake_lines(product_id);
