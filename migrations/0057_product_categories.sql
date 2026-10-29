-- 0057_product_categories.sql
-- Counter now serves shops that don't sell drinks. products.category was a
-- closed list of beverage kinds (BEER, WINE, ... NON_BEVERAGE), so a hardware
-- or provisions shop could only file everything under OTHER.
--
-- Categories become an owner-editable list: product_categories holds the code
-- and the label people see; products.category keeps holding the code, now
-- without the CHECK. There is deliberately no foreign key from products to
-- product_categories — catalog rows pulled from HQ (§10 sync) may carry a
-- code this shop hasn't seen, and the app shows such a code as a label
-- instead of refusing the row.
--
-- SQLite can't drop a CHECK in place, so products is rebuilt. Nineteen tables
-- reference products(id) and foreign_keys can't be switched off inside the
-- migration's transaction, so the rebuild runs with defer_foreign_keys: the
-- DROP's implicit delete counts deferred violations, and re-inserting every
-- id into the new products table clears them before COMMIT. No child table
-- uses ON DELETE CASCADE, so the drop deletes no child rows.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE product_categories (
  code TEXT PRIMARY KEY CHECK (code <> '' AND code = upper(code)),
  label TEXT NOT NULL CHECK (label <> ''),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id)
);

-- Existing installs keep their beverage list. A new shop's first-run setup
-- replaces the unused ones with its business profile's starter list
-- (src/main/services/businessProfile.ts).
INSERT INTO product_categories (code, label, sort_order, created_by, updated_by) VALUES
  ('BEER', 'Beer', 10, 'sys-system', 'sys-system'),
  ('WINE', 'Wine', 20, 'sys-system', 'sys-system'),
  ('SPIRITS', 'Spirits', 30, 'sys-system', 'sys-system'),
  ('SOFT_DRINK', 'Soft drink', 40, 'sys-system', 'sys-system'),
  ('WATER', 'Water', 50, 'sys-system', 'sys-system'),
  ('JUICE', 'Juice', 60, 'sys-system', 'sys-system'),
  ('ENERGY_DRINK', 'Energy drink', 70, 'sys-system', 'sys-system'),
  ('MIXER', 'Mixer', 80, 'sys-system', 'sys-system'),
  ('NON_BEVERAGE', 'Non-beverage', 90, 'sys-system', 'sys-system'),
  ('OTHER', 'Other', 1000, 'sys-system', 'sys-system');

CREATE TEMP TABLE products_0057 AS SELECT * FROM products;

DROP TABLE products;

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category <> ''),
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
  canonical_unit TEXT NOT NULL DEFAULT 'UNIT',
  count_class TEXT
    CHECK (count_class IS NULL OR count_class IN ('A', 'B', 'C')),
  primary_purchase_unit_id TEXT REFERENCES product_units(id),
  primary_sale_unit_id TEXT REFERENCES product_units(id),
  minimum_price_pesewas INTEGER NOT NULL DEFAULT 0
    CHECK (minimum_price_pesewas >= 0),
  competitor_price_pesewas INTEGER
    CHECK (competitor_price_pesewas IS NULL OR competitor_price_pesewas >= 0),
  competitor_name TEXT,
  competitor_checked_at TEXT,
  CHECK (cost_price_pesewas >= 0),
  CHECK (walk_in_price_pesewas >= 0),
  CHECK (wholesale_price_pesewas >= 0),
  CHECK (route_price_pesewas >= 0),
  CHECK (bottle_deposit_pesewas >= 0)
);

INSERT INTO products (
  id, sku, barcode, name, category, brand, pack_size_units, unit_volume_ml,
  is_returnable, bottle_deposit_pesewas, cost_price_pesewas,
  walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
  reorder_threshold, reorder_quantity, primary_supplier_id,
  default_lead_time_days, shelf_life_days, active, created_at, created_by,
  updated_at, updated_by, device_id, synced_at, deleted_at, deleted_by,
  deleted_reason, canonical_unit, count_class, primary_purchase_unit_id,
  primary_sale_unit_id, minimum_price_pesewas, competitor_price_pesewas,
  competitor_name, competitor_checked_at
)
SELECT
  id, sku, barcode, name, category, brand, pack_size_units, unit_volume_ml,
  is_returnable, bottle_deposit_pesewas, cost_price_pesewas,
  walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
  reorder_threshold, reorder_quantity, primary_supplier_id,
  default_lead_time_days, shelf_life_days, active, created_at, created_by,
  updated_at, updated_by, device_id, synced_at, deleted_at, deleted_by,
  deleted_reason, canonical_unit, count_class, primary_purchase_unit_id,
  primary_sale_unit_id, minimum_price_pesewas, competitor_price_pesewas,
  competitor_name, competitor_checked_at
FROM products_0057;

DROP TABLE products_0057;

CREATE INDEX idx_products_sku ON products(sku) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_products_category ON products(category) WHERE active = 1 AND deleted_at IS NULL;
CREATE INDEX idx_products_supplier ON products(primary_supplier_id);
CREATE INDEX idx_products_count_class ON products(count_class)
  WHERE deleted_at IS NULL AND active = 1;
CREATE INDEX idx_products_primary_purchase_unit ON products(primary_purchase_unit_id)
  WHERE primary_purchase_unit_id IS NOT NULL;
CREATE INDEX idx_products_primary_sale_unit ON products(primary_sale_unit_id)
  WHERE primary_sale_unit_id IS NOT NULL;

CREATE TRIGGER trg_outbox_products_mins AFTER INSERT ON products
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('products', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_products_mupd AFTER UPDATE ON products
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('products', NEW.id, 'UPDATE');
END;
