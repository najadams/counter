-- 0025_customer_price_overrides.sql
-- Wave C.2 — per-customer price overrides.
--
-- Some VIPs / wholesale buyers get a hand-shaken price that doesn't match
-- any tier. Rather than mixing those into the tier table (which broadcasts
-- to anyone on the same channel), we attach overrides directly to the
-- customer. Lookup precedence at sale time:
--
--   1. customer_price_overrides (channel, applies_to_unit_id) — exact match
--   2. customer_price_overrides (channel = NULL, applies_to_unit_id) — any-channel
--   3. pricing_tiers (channel)  — Wave 7 tier pricing
--   4. product_units.price_pesewas  — the unit's default price
--
-- One row per (customer_id, product_id, unit_id, channel-or-NULL); a UNIQUE
-- partial index covers both the channel-specific and the channel-NULL cases.

CREATE TABLE customer_price_overrides (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  applies_to_unit_id TEXT NOT NULL REFERENCES product_units(id),
  -- channel = NULL means "any channel". Channel-specific overrides take
  -- precedence over channel-null overrides for the same customer/unit.
  channel TEXT CHECK (channel IS NULL OR channel IN ('WALK_IN', 'WHOLESALE', 'ROUTE')),
  price_pesewas INTEGER NOT NULL CHECK (price_pesewas > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

-- Active rows are unique per (customer, product, unit, channel-or-empty).
-- The COALESCE trick lets us share a single index across channel-null and
-- channel-specific rows without conflict.
CREATE UNIQUE INDEX idx_cpo_unique_active
  ON customer_price_overrides(customer_id, product_id, applies_to_unit_id,
                              COALESCE(channel, ''))
  WHERE active = 1;

CREATE INDEX idx_cpo_customer_active
  ON customer_price_overrides(customer_id) WHERE active = 1;
