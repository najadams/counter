-- 0024_product_count_class.sql
-- Cycle-counting support: classify products into A/B/C buckets so a
-- stocktake can target a subset of SKUs.
--
-- Convention:
--   A = top 20% by sales velocity (count weekly)
--   B = next 30% (count every 2-3 weeks)
--   C = the long tail (count monthly)
--   NULL = unclassified (treated as C in defaults)
--
-- Classification is set manually today (Settings → Products → Edit). A
-- future service can auto-assign by reading the last 90 days of sales.

ALTER TABLE products ADD COLUMN count_class TEXT
  CHECK (count_class IS NULL OR count_class IN ('A', 'B', 'C'));

CREATE INDEX idx_products_count_class ON products(count_class)
  WHERE deleted_at IS NULL AND active = 1;
