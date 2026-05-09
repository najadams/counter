-- 0016_customer_channel.sql
-- Per-customer preferred sale channel. NULL = no preference (default to
-- WALK_IN at the cart). When set, the SaleScreen offers to switch the cart
-- channel when this customer is picked.

PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN preferred_channel TEXT
  CHECK (preferred_channel IS NULL OR preferred_channel IN ('WALK_IN','WHOLESALE','ROUTE'));
