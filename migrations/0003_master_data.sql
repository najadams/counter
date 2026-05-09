-- 0003_master_data.sql
-- Locations, suppliers, products, customers, routes.
--
-- Multi-location: schema-ready, UI-deferred. Every operational/transactional
-- row gets a location_id from here on. v1 uses DEFAULT_LOCATION_ID only.

PRAGMA foreign_keys = ON;

-- locations -----------------------------------------------------------------
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT
);
CREATE INDEX idx_locations_active ON locations(active) WHERE deleted_at IS NULL;

INSERT INTO locations (id, name, code, created_by, updated_by, device_id) VALUES
  ('loc-main-counter', 'Main Counter', 'MAIN', 'sys-system', 'sys-system', 'bootstrap');

-- suppliers -----------------------------------------------------------------
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT CHECK (phone IS NULL OR phone GLOB '+233[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  email TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  current_balance_pesewas INTEGER NOT NULL DEFAULT 0,  -- positive = we owe them
  reliability_score REAL,                              -- 0.00 - 1.00, computed nightly
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT
);
CREATE INDEX idx_suppliers_active ON suppliers(active) WHERE deleted_at IS NULL;

-- products ------------------------------------------------------------------
-- Three prices because three channels: walk-in, wholesale, route.
-- The system enforces the right price for the right channel — eliminates
-- the "the worker gave a discount" excuse.
--
-- is_returnable + bottle_deposit_pesewas: critical for beverage retail in
-- Ghana. Empties returning to supplier are real money. Most informal shops
-- lose track entirely and pay the deposit twice.
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'BEER','WINE','SPIRITS','SOFT_DRINK','WATER','JUICE',
    'ENERGY_DRINK','MIXER','NON_BEVERAGE','OTHER'
  )),
  brand TEXT,
  pack_size_units INTEGER NOT NULL DEFAULT 1,
  unit_volume_ml INTEGER,
  is_returnable INTEGER NOT NULL DEFAULT 0 CHECK (is_returnable IN (0, 1)),
  bottle_deposit_pesewas INTEGER NOT NULL DEFAULT 0,
  cost_price_pesewas INTEGER NOT NULL,
  walk_in_price_pesewas INTEGER NOT NULL,
  wholesale_price_pesewas INTEGER NOT NULL,
  route_price_pesewas INTEGER NOT NULL,
  reorder_threshold INTEGER NOT NULL DEFAULT 0,
  reorder_quantity INTEGER NOT NULL DEFAULT 0,
  primary_supplier_id TEXT REFERENCES suppliers(id),
  default_lead_time_days INTEGER NOT NULL DEFAULT 7,
  shelf_life_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT,
  CHECK (cost_price_pesewas >= 0),
  CHECK (walk_in_price_pesewas >= 0),
  CHECK (wholesale_price_pesewas >= 0),
  CHECK (route_price_pesewas >= 0),
  CHECK (bottle_deposit_pesewas >= 0)
);
CREATE INDEX idx_products_sku ON products(sku) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_products_category ON products(category) WHERE active = 1 AND deleted_at IS NULL;
CREATE INDEX idx_products_supplier ON products(primary_supplier_id);

-- customers -----------------------------------------------------------------
-- current_balance_pesewas is denormalized for performance. Truth lives in
-- sales + customer_payment_allocations. Reconciled nightly.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL CHECK (phone GLOB '+233[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  alternate_phone TEXT CHECK (alternate_phone IS NULL OR alternate_phone GLOB '+233[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  customer_type TEXT NOT NULL CHECK (customer_type IN (
    'WALK_IN_REGULAR','WHOLESALE','ROUTE','STAFF_FAMILY'
  )),
  business_name TEXT,
  location_description TEXT,
  geo_lat REAL,
  geo_lng REAL,
  credit_limit_pesewas INTEGER NOT NULL DEFAULT 0,
  credit_terms_days INTEGER NOT NULL DEFAULT 0,
  current_balance_pesewas INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  blocked_reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT,
  CHECK (credit_limit_pesewas >= 0),
  CHECK ((blocked = 0) OR (blocked = 1 AND blocked_reason IS NOT NULL))
);
CREATE UNIQUE INDEX idx_customers_phone ON customers(phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_type ON customers(customer_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_balance ON customers(current_balance_pesewas) WHERE current_balance_pesewas > 0 AND deleted_at IS NULL;
CREATE INDEX idx_customers_geo ON customers(geo_lat, geo_lng) WHERE geo_lat IS NOT NULL;

-- routes --------------------------------------------------------------------
CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  default_driver_id TEXT REFERENCES workers(id),
  default_day_of_week INTEGER CHECK (default_day_of_week IS NULL OR default_day_of_week BETWEEN 0 AND 6),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT
);
CREATE INDEX idx_routes_active ON routes(active) WHERE deleted_at IS NULL;

-- route_customer_links: many-to-many, sequenced --------------------------
CREATE TABLE route_customer_links (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  stop_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT,
  UNIQUE(route_id, customer_id)
);
CREATE INDEX idx_route_customer_route ON route_customer_links(route_id);
