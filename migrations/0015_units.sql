-- 0015_units.sql
-- Canonical units + sellable/purchasable unit definitions.
--
-- Each product has ONE canonical unit (the smallest unit the system
-- tracks). All stock_movements are recorded in canonical-unit integers.
-- A product_units table defines additional ways the same product can be
-- sold or purchased — each with an integer conversion_factor relating it
-- back to the canonical unit, and its own price.
--
-- Backward compat: every existing product gets a synthetic 'UNIT' entry
-- with factor=1, mirrored from walk_in_price_pesewas, marked sale + purchase.
-- Sales and stock movements written before this migration are unchanged
-- (their applied_unit_id stays NULL — the system still understands them).

PRAGMA foreign_keys = ON;

-- 1) Add canonical unit name to products. Default 'UNIT' = legacy behavior.
ALTER TABLE products ADD COLUMN canonical_unit TEXT NOT NULL DEFAULT 'UNIT';

-- 2) Define product_units.
CREATE TABLE product_units (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  unit_name TEXT NOT NULL,                              -- BOTTLE, CRATE, BAG_50KG, SHOT_50ML
  conversion_factor INTEGER NOT NULL CHECK (conversion_factor > 0),
  price_pesewas INTEGER NOT NULL CHECK (price_pesewas >= 0),
  is_purchase_unit INTEGER NOT NULL DEFAULT 0 CHECK (is_purchase_unit IN (0, 1)),
  is_sale_unit INTEGER NOT NULL DEFAULT 1 CHECK (is_sale_unit IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE(product_id, unit_name)
);
CREATE INDEX idx_product_units_product ON product_units(product_id, is_sale_unit, display_order)
  WHERE active = 1;

-- 3) sale_lines + stock_movements record which unit (if any) was used.
--    NULL = legacy / canonical-only writes. Non-NULL = the worker picked
--    a specific unit and we converted to canonical at write time.
ALTER TABLE sale_lines ADD COLUMN applied_unit_id TEXT REFERENCES product_units(id);
ALTER TABLE stock_movements ADD COLUMN source_unit_id TEXT REFERENCES product_units(id);

-- 4) pricing_tiers can target a specific unit (CRATE-tier vs BOTTLE-tier).
ALTER TABLE pricing_tiers ADD COLUMN applies_to_unit_id TEXT REFERENCES product_units(id);

-- 5) Backfill: every existing product gets a synthetic UNIT row.
--    The walk_in_price_pesewas mirrors as the unit's price so existing
--    sale flows that pass unitId=null can fall back to it cleanly.
INSERT INTO product_units (
  id, product_id, unit_name, conversion_factor, price_pesewas,
  is_purchase_unit, is_sale_unit, display_order,
  created_by, updated_by, device_id
)
SELECT
  'pu-default-' || p.id,
  p.id,
  'UNIT',
  1,
  p.walk_in_price_pesewas,
  1,
  1,
  0,
  'sys-system',
  'sys-system',
  'migration-0015'
FROM products p
WHERE p.deleted_at IS NULL;
