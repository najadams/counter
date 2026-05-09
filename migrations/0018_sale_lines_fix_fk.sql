-- 0018_sale_lines_fix_fk.sql
-- Fix a stale FK reference: migration 0017 used `legacy_alter_table = ON`
-- when renaming pricing_tiers → pricing_tiers_old, which causes other
-- tables' FK references to NOT auto-update. After 0017 dropped
-- pricing_tiers_old, sale_lines.applied_tier_id still pointed at the
-- vanished name, breaking FK validation on INSERT.
--
-- Fix by rebuilding sale_lines with the FK pointing at the current
-- pricing_tiers table.

PRAGMA foreign_keys = OFF;

ALTER TABLE sale_lines RENAME TO sale_lines_oldfk;

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_pesewas INTEGER NOT NULL,
  unit_cost_pesewas INTEGER NOT NULL,
  line_total_pesewas INTEGER NOT NULL,
  margin_pesewas INTEGER NOT NULL,
  applied_tier_id TEXT REFERENCES pricing_tiers(id),
  applied_unit_id TEXT REFERENCES product_units(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (unit_price_pesewas >= 0),
  CHECK (unit_cost_pesewas >= 0),
  CHECK (line_total_pesewas = unit_price_pesewas * quantity),
  CHECK (margin_pesewas = (unit_price_pesewas - unit_cost_pesewas) * quantity)
);

INSERT INTO sale_lines (
  id, sale_id, product_id, quantity, unit_price_pesewas, unit_cost_pesewas,
  line_total_pesewas, margin_pesewas, applied_tier_id, applied_unit_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at
)
SELECT
  id, sale_id, product_id, quantity, unit_price_pesewas, unit_cost_pesewas,
  line_total_pesewas, margin_pesewas, applied_tier_id, applied_unit_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at
FROM sale_lines_oldfk;

DROP TABLE sale_lines_oldfk;

CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id, created_at DESC);
CREATE INDEX idx_sale_lines_tier ON sale_lines(applied_tier_id) WHERE applied_tier_id IS NOT NULL;

PRAGMA foreign_keys = ON;
