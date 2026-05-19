-- 0029_product_primary_units.sql
-- Add primary purchase/sale unit hints on products.
--
-- Why: today the only way to pick a default unit at receive-time or sale-time
-- is the canonical row (factor 1). But the canonical is the SMALLEST unit
-- you might transact in — a beer crate's canonical is "bottle," not "crate,"
-- yet receipts and counts almost always happen at the crate level.
--
-- These columns let the UI default the unit picker to whatever the user
-- normally deals in. They're hints — the storage layer still works in
-- canonical units. NULL means "no preference, fall back to canonical."

PRAGMA foreign_keys = ON;

ALTER TABLE products ADD COLUMN primary_purchase_unit_id TEXT
  REFERENCES product_units(id);

ALTER TABLE products ADD COLUMN primary_sale_unit_id TEXT
  REFERENCES product_units(id);

-- Lookups: when rendering a product row in the UI, we always need both.
CREATE INDEX idx_products_primary_purchase_unit ON products(primary_purchase_unit_id)
  WHERE primary_purchase_unit_id IS NOT NULL;

CREATE INDEX idx_products_primary_sale_unit ON products(primary_sale_unit_id)
  WHERE primary_sale_unit_id IS NOT NULL;
