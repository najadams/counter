-- 0054_sale_lines_margin_from_cogs.sql
-- Re-express the sale_lines margin invariant against line_cogs_pesewas.
--
-- Why: 0018's CHECK (margin = (unit_price - unit_cost) * quantity) predates
-- the perpetual moving-average ledger (0047). With ledger posting on,
-- completeSaleCore replaces line_cogs/margin with the exact valuation slice,
-- while unit_cost stays the rounded per-canonical cost x factor. Whenever the
-- two disagreed by a pesewa -- a crate whose average cost isn't a whole
-- pesewa per bottle, the sale that empties stock, a hand-edited product
-- cost -- the CHECK failed and the whole sale rolled back.
--
-- Setting unit_cost = round(line_cogs / quantity) does NOT fix it: that only
-- reconciles when quantity divides line_cogs evenly (7 bottles of a
-- 416.67-pesewa average still fails). The invariant that holds at every write
-- site, with no division, is
--
--   margin = line_total - line_cogs
--
-- line_cogs_pesewas is the cost authority. unit_cost_pesewas stays as the
-- informational per-unit snapshot shown at ring time.
--
-- SQLite can't alter a CHECK in place, so rebuild: create new, copy, drop old,
-- rename new. No other table has a foreign key into sale_lines. The runner
-- wraps this file in a transaction, where PRAGMA foreign_keys is a no-op, so
-- none is set here. The outbox trigger is recreated AFTER the copy so the
-- rebuild doesn't re-queue every historic line for sync.

CREATE TABLE sale_lines_new (
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
  kind TEXT NOT NULL DEFAULT 'REGULAR' CHECK (kind IN ('REGULAR', 'BONUS')),
  applied_promotion_id TEXT REFERENCES promotions(id),
  list_price_pesewas INTEGER,
  line_cogs_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (line_cogs_pesewas >= 0),
  CHECK (unit_price_pesewas >= 0),
  CHECK (unit_cost_pesewas >= 0),
  CHECK (line_total_pesewas = unit_price_pesewas * quantity),
  CHECK (margin_pesewas = line_total_pesewas - line_cogs_pesewas)
);

-- Every existing row satisfies the old CHECK, so line_total - margin is
-- exactly unit_cost * quantity (>= 0) -- the same value 0047 backfilled into
-- line_cogs. Rows already consistent (expected: all of them) copy unchanged;
-- a row whose line_cogs contradicts its own margin resolves to the cost that
-- margin was computed from, rather than failing the upgrade and bricking boot.
INSERT INTO sale_lines_new (
  id, sale_id, product_id, quantity, unit_price_pesewas, unit_cost_pesewas,
  line_total_pesewas, margin_pesewas, applied_tier_id, applied_unit_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at,
  kind, applied_promotion_id, list_price_pesewas, line_cogs_pesewas
)
SELECT
  id, sale_id, product_id, quantity, unit_price_pesewas, unit_cost_pesewas,
  line_total_pesewas, margin_pesewas, applied_tier_id, applied_unit_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at,
  kind, applied_promotion_id, list_price_pesewas,
  CASE
    WHEN margin_pesewas = line_total_pesewas - line_cogs_pesewas THEN line_cogs_pesewas
    ELSE line_total_pesewas - margin_pesewas
  END
FROM sale_lines;

DROP TABLE sale_lines;
ALTER TABLE sale_lines_new RENAME TO sale_lines;

CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id, created_at DESC);
CREATE INDEX idx_sale_lines_tier ON sale_lines(applied_tier_id) WHERE applied_tier_id IS NOT NULL;
CREATE INDEX idx_sale_lines_kind ON sale_lines(kind) WHERE kind != 'REGULAR';

CREATE TRIGGER trg_outbox_sale_lines_ins AFTER INSERT ON sale_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('sale_lines', NEW.id, 'INSERT');
END;
