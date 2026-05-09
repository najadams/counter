-- 0019_sale_payments.sql
-- Split-tender support: a sale can be paid with multiple payment methods
-- in one transaction (e.g. 30 cash + 50 MoMo). Today sales.payment_method
-- forced one method per sale; this is too narrow for real Ghanaian retail.
--
-- Design:
--   - sale_payments holds one row per tender. Sum of amounts == sales.total_pesewas
--     (enforced at the service level — too expensive to do as a DB trigger).
--   - sales.payment_method stays as the "primary" tender (the largest by amount)
--     for backwards-compatible reporting and simple lookups.
--   - Single-payment sales get exactly one sale_payments row, so all queries
--     that previously read sales.payment_method can keep working AND start
--     joining to sale_payments for accurate split-tender breakdowns.
--
-- Backfill: every existing sale gets a single sale_payments row matching its
-- old payment_method + total_pesewas + payment_reference.

CREATE TABLE sale_payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  reference TEXT,                                -- e.g. MoMo reference, check number
  cash_given_pesewas INTEGER,                    -- only meaningful when method = CASH
  change_pesewas INTEGER,                        -- only meaningful when method = CASH
  display_order INTEGER NOT NULL DEFAULT 0,      -- order tenders appear on the receipt
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX idx_sale_payments_method_date ON sale_payments(payment_method, created_at DESC);

-- Backfill: one row per existing sale, copying the legacy single-method fields.
INSERT INTO sale_payments (
  id, sale_id, payment_method, amount_pesewas, reference,
  display_order, created_at, created_by, updated_by, device_id
)
SELECT
  's-pay-backfill-' || s.id,
  s.id,
  s.payment_method,
  s.total_pesewas,
  s.payment_reference,
  0,
  s.created_at,
  s.created_by,
  s.updated_by,
  s.device_id
FROM sales s
WHERE s.total_pesewas > 0;
