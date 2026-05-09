-- 0014_pricing_tiers.sql
-- Volume-based pricing tiers per product per channel.
-- "Buy 12+ Star Beer @ 750" instead of the channel base price.
-- Channel = 'ALL' lets a tier apply across all channels.
-- bestTierFor() picks the tier with the highest min_quantity that the cart
-- line meets, preferring an exact channel match over 'ALL'.
--
-- Also: snapshot the tier id onto sale_lines at sale time so we can report
-- "X% of this period's sales got a volume tier."

PRAGMA foreign_keys = ON;

CREATE TABLE pricing_tiers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  channel TEXT NOT NULL CHECK (channel IN ('WALK_IN', 'WHOLESALE', 'ROUTE', 'ALL')),
  min_quantity INTEGER NOT NULL CHECK (min_quantity > 0),
  unit_price_pesewas INTEGER NOT NULL CHECK (unit_price_pesewas >= 0),
  priority INTEGER NOT NULL DEFAULT 0,        -- tie-breaker; higher wins
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE(product_id, channel, min_quantity)
);
CREATE INDEX idx_pricing_tiers_lookup ON pricing_tiers(product_id, channel, min_quantity DESC) WHERE active = 1;

ALTER TABLE sale_lines ADD COLUMN applied_tier_id TEXT REFERENCES pricing_tiers(id);
CREATE INDEX idx_sale_lines_tier ON sale_lines(applied_tier_id) WHERE applied_tier_id IS NOT NULL;
