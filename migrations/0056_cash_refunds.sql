-- 0056_cash_refunds.sql
-- Cash handed back to a customer out of a till drawer, as its own record.
--
-- Until now a customer-return refund was written as a CASH_DROP cash count
-- (notes 'customer-refund:…'), so it read as money taken to the safe. And a
-- void approved after its sale's shift had closed paid the customer from the
-- current drawer without that drawer knowing, so its cashier closed short.
--
-- A refund row names the drawer the cash left (shift_id) and what it was for.
-- A sale voided WITH a cash refund keeps its cash counted in the drawer that
-- took it; the refund comes out of the drawer that paid it. A sale voided
-- without one (rung by mistake, no money changed hands) drops out as before.
-- Existing refund CASH_DROP rows are left as they are: they already balanced
-- their shifts.

CREATE TABLE cash_refunds (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('SALE_VOID', 'CUSTOMER_RETURN')),
  sale_id TEXT REFERENCES sales(id),
  void_request_id TEXT REFERENCES sale_void_requests(id),
  customer_return_id TEXT REFERENCES customer_returns(id),
  customer_id TEXT REFERENCES customers(id),
  reason TEXT NOT NULL,
  -- The cashier who handed the money over, and who approved it.
  paid_by TEXT NOT NULL REFERENCES workers(id),
  approved_by TEXT REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (
    (source_type = 'SALE_VOID' AND sale_id IS NOT NULL AND void_request_id IS NOT NULL
      AND customer_return_id IS NULL)
    OR
    (source_type = 'CUSTOMER_RETURN' AND customer_return_id IS NOT NULL
      AND void_request_id IS NULL)
  )
);

CREATE INDEX idx_cash_refunds_shift ON cash_refunds(shift_id);
CREATE INDEX idx_cash_refunds_location_date ON cash_refunds(location_id, created_at);
CREATE INDEX idx_cash_refunds_sale ON cash_refunds(sale_id) WHERE sale_id IS NOT NULL;
CREATE UNIQUE INDEX idx_cash_refunds_one_per_void
  ON cash_refunds(void_request_id) WHERE void_request_id IS NOT NULL;

-- Money records are append-only.
CREATE TRIGGER trg_cash_refunds_immutable
BEFORE UPDATE ON cash_refunds
WHEN NEW.id <> OLD.id OR NEW.shift_id <> OLD.shift_id
  OR NEW.location_id <> OLD.location_id OR NEW.amount_pesewas <> OLD.amount_pesewas
  OR NEW.source_type <> OLD.source_type OR NEW.sale_id IS NOT OLD.sale_id
  OR NEW.void_request_id IS NOT OLD.void_request_id
  OR NEW.customer_return_id IS NOT OLD.customer_return_id
  OR NEW.paid_by <> OLD.paid_by OR NEW.approved_by IS NOT OLD.approved_by
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'cash refunds are immutable');
END;

CREATE TRIGGER trg_cash_refunds_no_delete
BEFORE DELETE ON cash_refunds
BEGIN
  SELECT RAISE(ABORT, 'cash refunds cannot be deleted');
END;

CREATE TRIGGER trg_outbox_cash_refunds_ins
AFTER INSERT ON cash_refunds
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('cash_refunds', NEW.id, 'INSERT');
END;

-- A void request says, when it is made, whether cash goes back to the
-- customer and from which drawer (the requester's open shift). The refund
-- is paid when the request is approved; that drawer can't close before.
ALTER TABLE sale_void_requests ADD COLUMN cash_refund_pesewas INTEGER
  CHECK (cash_refund_pesewas IS NULL OR cash_refund_pesewas > 0);
ALTER TABLE sale_void_requests ADD COLUMN refund_shift_id TEXT REFERENCES shifts(id);

CREATE INDEX idx_sale_void_requests_refund_shift
  ON sale_void_requests(refund_shift_id, status) WHERE refund_shift_id IS NOT NULL;

DROP TRIGGER trg_sale_void_requests_identity_immutable;
CREATE TRIGGER trg_sale_void_requests_identity_immutable
BEFORE UPDATE ON sale_void_requests
WHEN NEW.sale_id <> OLD.sale_id
  OR NEW.location_id <> OLD.location_id
  OR NEW.shift_id <> OLD.shift_id
  OR NEW.requested_by <> OLD.requested_by
  OR NEW.reason <> OLD.reason
  OR NEW.requested_at <> OLD.requested_at
  OR NEW.request_device_id <> OLD.request_device_id
  OR NEW.cash_refund_pesewas IS NOT OLD.cash_refund_pesewas
  OR NEW.refund_shift_id IS NOT OLD.refund_shift_id
BEGIN
  SELECT RAISE(ABORT, 'sale void request identity is immutable');
END;

-- The day's figures are net of returns; these say how much was returned
-- and how much cash went back over the counter.
ALTER TABLE daily_summaries ADD COLUMN total_returns_pesewas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_summaries ADD COLUMN num_returns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_summaries ADD COLUMN cash_refunded_pesewas INTEGER NOT NULL DEFAULT 0;
