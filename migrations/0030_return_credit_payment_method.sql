-- 0030 — seed the RETURN_CREDIT payment method.
--
-- customerReturns.recordCustomerReturn (added in Wave C with migration 0026)
-- inserts synthetic customer_payments rows with payment_method='RETURN_CREDIT'
-- when the refundMethod is CREDIT. The corresponding lookup row was never
-- seeded, so every CREDIT-method return failed at runtime with a FOREIGN KEY
-- constraint error.
--
-- This migration adds the missing row. INSERT OR IGNORE means a database
-- where the row already exists (e.g. someone manually seeded it) is a no-op.
-- requires_reference = 0 — the synthetic ref column carries the return id,
-- the service always supplies one. Keeping the flag off means the constraint
-- doesn't reject it.

INSERT OR IGNORE INTO payment_methods (code, description, requires_reference) VALUES
  ('RETURN_CREDIT', 'Customer-return credit (synthetic — not a real tender)', 0);
