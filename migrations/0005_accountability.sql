-- 0005_accountability.sql
-- Breakage and worker consumption — the two biggest shrinkage levers.
-- Every breakage requires a photo (DB-level NOT NULL).

PRAGMA foreign_keys = ON;

-- breakage_log --------------------------------------------------------------
-- Invariant 8: photo_url NOT NULL. Application uploads photo first, then
-- inserts. No row exists without a photo.
CREATE TABLE breakage_log (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  photo_url TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN (
    'DROPPED','CUSTOMER_ACCIDENT','TRANSPORT','EXPIRED_LEAK','UNKNOWN','OTHER'
  )),
  cause_description TEXT,
  deducted_from_wages INTEGER NOT NULL DEFAULT 0 CHECK (deducted_from_wages IN (0, 1)),
  supervisor_approval_id TEXT REFERENCES workers(id),
  stock_movement_id TEXT NOT NULL,                 -- the corresponding outflow row
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (length(photo_url) > 0)
);
CREATE INDEX idx_breakage_worker_date ON breakage_log(worker_id, created_at DESC);
CREATE INDEX idx_breakage_product ON breakage_log(product_id);
CREATE INDEX idx_breakage_shift ON breakage_log(shift_id);
CREATE INDEX idx_breakage_location_date ON breakage_log(location_id, created_at DESC);

-- worker_consumption_log ----------------------------------------------------
-- Each time a worker drinks something on shift. within_allowance is set by
-- the application based on month-to-date consumption vs the worker's
-- consumption_allowance_units.
CREATE TABLE worker_consumption_log (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  within_allowance INTEGER NOT NULL CHECK (within_allowance IN (0, 1)),
  cost_to_worker_pesewas INTEGER NOT NULL DEFAULT 0,
  stock_movement_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (cost_to_worker_pesewas >= 0)
);
CREATE INDEX idx_consumption_worker_month ON worker_consumption_log(worker_id, created_at);
CREATE INDEX idx_consumption_location_date ON worker_consumption_log(location_id, created_at DESC);
