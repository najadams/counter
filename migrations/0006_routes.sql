-- 0006_routes.sql
-- Route runs and stops. v1 has the schema in place; UI lands Week 5.

PRAGMA foreign_keys = ON;

CREATE TABLE route_runs (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  driver_id TEXT NOT NULL REFERENCES workers(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL CHECK (status IN ('LOADED','IN_PROGRESS','COMPLETED','RECONCILED','DISPUTED')),
  loaded_at TEXT NOT NULL,
  completed_at TEXT,
  reconciled_at TEXT,
  total_loaded_value_pesewas INTEGER NOT NULL,
  total_sold_value_pesewas INTEGER NOT NULL DEFAULT 0,
  total_returned_value_pesewas INTEGER NOT NULL DEFAULT 0,
  total_breakage_value_pesewas INTEGER NOT NULL DEFAULT 0,
  cash_collected_pesewas INTEGER NOT NULL DEFAULT 0,
  momo_collected_pesewas INTEGER NOT NULL DEFAULT 0,
  credit_extended_pesewas INTEGER NOT NULL DEFAULT 0,
  variance_pesewas INTEGER,
  fuel_cost_pesewas INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX idx_route_runs_route ON route_runs(route_id, loaded_at DESC);
CREATE INDEX idx_route_runs_driver ON route_runs(driver_id, loaded_at DESC);
CREATE INDEX idx_route_runs_status ON route_runs(status);

CREATE TABLE route_stops (
  id TEXT PRIMARY KEY,
  route_run_id TEXT NOT NULL REFERENCES route_runs(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  stop_order INTEGER NOT NULL,
  arrived_at TEXT,
  departed_at TEXT,
  geo_lat REAL,
  geo_lng REAL,
  sale_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'SOLD','NO_PURCHASE','CUSTOMER_ABSENT','SHOP_CLOSED','PAYMENT_DISPUTE','OTHER'
  )),
  outcome_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX idx_route_stops_run ON route_stops(route_run_id, stop_order);
CREATE INDEX idx_route_stops_customer ON route_stops(customer_id, arrived_at DESC);
