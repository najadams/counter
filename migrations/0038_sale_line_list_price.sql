-- 0038_sale_line_list_price.sql
-- Snapshot the list price on every sale line.
--
-- completeSale now enforces a server-side price floor: a line may not be rung
-- below the best legitimate price for its (product, unit, channel, customer,
-- quantity) — any lower price must go through the discount field, which is
-- supervisor-gated and audited. This column snapshots what that list price
-- was at ring time so underpricing stays forensically visible even after the
-- catalog price changes (the exception report compares unit_price_pesewas
-- against this snapshot, not against today's price).
--
-- NULL = legacy rows written before this migration.

ALTER TABLE sale_lines ADD COLUMN list_price_pesewas INTEGER;
