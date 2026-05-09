-- 0017_pricing_tiers_unique.sql
-- Widen the pricing_tiers UNIQUE constraint to include applies_to_unit_id, so
-- a unit-specific tier and a universal tier can coexist at the same
-- (product, channel, min_quantity) — they target different sale paths.
--
-- SQLite can't ALTER a CREATE TABLE-level UNIQUE; recreate the table.

PRAGMA foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

ALTER TABLE pricing_tiers RENAME TO pricing_tiers_old;

CREATE TABLE pricing_tiers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  channel TEXT NOT NULL CHECK (channel IN ('WALK_IN', 'WHOLESALE', 'ROUTE', 'ALL')),
  min_quantity INTEGER NOT NULL CHECK (min_quantity > 0),
  unit_price_pesewas INTEGER NOT NULL CHECK (unit_price_pesewas >= 0),
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  applies_to_unit_id TEXT REFERENCES product_units(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  -- Wider key: same (product, channel, min_quantity) is allowed if the
  -- applies_to_unit_id differs (in particular, NULL universal coexists
  -- with a non-NULL unit-specific tier).
  UNIQUE(product_id, channel, min_quantity, applies_to_unit_id)
);

INSERT INTO pricing_tiers (
  id, product_id, channel, min_quantity, unit_price_pesewas, priority,
  active, notes, applies_to_unit_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at
)
SELECT
  id, product_id, channel, min_quantity, unit_price_pesewas, priority,
  active, notes, applies_to_unit_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at
FROM pricing_tiers_old;

DROP TABLE pricing_tiers_old;

CREATE INDEX idx_pricing_tiers_lookup ON pricing_tiers(product_id, channel, min_quantity DESC) WHERE active = 1;

PRAGMA legacy_alter_table = OFF;
