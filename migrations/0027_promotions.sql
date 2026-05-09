-- 0027_promotions.sql
-- Wave D — bonus-unit promotions ("buy 5 crates, get 1 free").
--
-- Schema:
--   promotions table — qty_buy / qty_get_free, optional channel filter,
--   optional supplier_id (so reports can attribute the rebate value), date
--   window, active flag, audit columns.
--
--   sale_lines.kind — REGULAR (default) vs BONUS. Bonus lines have
--   unit_price_pesewas = 0 and line_total_pesewas = 0 but quantity > 0
--   so the canonical-stock movement still leaves the shelf. The existing
--   line_total = unit_price * quantity CHECK still holds (0 = 0 * qty).

CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  -- Optional unit. If specified, the promo only applies to lines sold in
  -- this unit (e.g. "1 free crate per 5 crates"). NULL = canonical units.
  applies_to_unit_id TEXT REFERENCES product_units(id),
  channel TEXT CHECK (channel IS NULL OR channel IN ('WALK_IN', 'WHOLESALE', 'ROUTE')),
  qty_buy INTEGER NOT NULL CHECK (qty_buy > 0),
  qty_get_free INTEGER NOT NULL CHECK (qty_get_free > 0),
  -- Optional date window (ISO YYYY-MM-DD). NULL = open-ended.
  valid_from TEXT,
  valid_to TEXT,
  -- For supplier-rebate reconciliation. Reports group bonus-unit cost by
  -- supplier so dad can claim the rebate.
  supplier_id TEXT REFERENCES suppliers(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

CREATE INDEX idx_promotions_product_active
  ON promotions(product_id) WHERE active = 1;

-- sale_lines.kind: REGULAR (paid) vs BONUS (free under a promotion).
-- Existing rows default to REGULAR so the migration is backwards-compat.
ALTER TABLE sale_lines ADD COLUMN kind TEXT NOT NULL DEFAULT 'REGULAR'
  CHECK (kind IN ('REGULAR', 'BONUS'));

-- Track which promotion fired (NULL for non-bonus lines).
ALTER TABLE sale_lines ADD COLUMN applied_promotion_id TEXT
  REFERENCES promotions(id);

CREATE INDEX idx_sale_lines_kind
  ON sale_lines(kind) WHERE kind != 'REGULAR';
