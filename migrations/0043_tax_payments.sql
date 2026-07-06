-- 0043_tax_payments.sql
-- VAT/NHIL/GETFund remittances to GRA. These are liability payments, not
-- operating expenses, so they live outside petty_cash_expenses.

PRAGMA foreign_keys = ON;

CREATE TABLE tax_payments (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  shift_id TEXT REFERENCES shifts(id),
  tax_period_from TEXT NOT NULL,
  tax_period_to TEXT NOT NULL,
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  payment_reference TEXT,
  paid_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (tax_period_to >= tax_period_from)
);

CREATE INDEX idx_tax_payments_period ON tax_payments(tax_period_from, tax_period_to, paid_at DESC);
CREATE INDEX idx_tax_payments_location_paid ON tax_payments(location_id, paid_at DESC);
CREATE INDEX idx_tax_payments_shift ON tax_payments(shift_id) WHERE shift_id IS NOT NULL;

CREATE TRIGGER trg_outbox_tax_payments_ins AFTER INSERT ON tax_payments
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('tax_payments', NEW.id, 'INSERT');
END;
