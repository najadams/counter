-- Ghana VAT breakdown on sales (VAT Act 2025 / Act 1151, effective 1 Jan 2026).
--
-- Prices are VAT-inclusive, so total_pesewas is UNCHANGED — these columns record
-- the tax EXTRACTED out of the inclusive total for receipts and reporting:
--
--   taxable_pesewas + vat_pesewas + nhil_pesewas + getfund_pesewas = total_pesewas
--
-- The identity is enforced in application code (completeSaleCore), not as a table
-- CHECK, because SQLite can't add a multi-column CHECK via ALTER TABLE, and the
-- existing CHECK (total = subtotal - discount) stays valid regardless.
--
-- This migration runs in BOTH builds. In the no-VAT binary these columns simply
-- stay 0 on every sale, so the schema never diverges between variants.

ALTER TABLE sales ADD COLUMN taxable_pesewas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN vat_pesewas     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN nhil_pesewas    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN getfund_pesewas INTEGER NOT NULL DEFAULT 0;
