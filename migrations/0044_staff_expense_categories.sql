-- 0044_staff_expense_categories.sql
-- Add dedicated staff payment expense categories instead of hiding wages
-- under OTHER. SQLite cannot alter a CHECK constraint in place, so rebuild
-- the table while preserving rows and indexes.

PRAGMA foreign_keys = ON;

CREATE TABLE petty_cash_expenses_new (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  category TEXT NOT NULL CHECK (category IN (
    'RENT','UTILITIES','TRANSPORT','SUPPLIES','COMMS',
    'REPAIRS','BANK_FEES','STAFF_WAGES','STAFF_ADVANCE',
    'COMMISSION','STAFF_WELFARE','OTHER'
  )),
  payee TEXT,
  photo_url TEXT,
  notes TEXT,
  supervisor_approval_id TEXT REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

INSERT INTO petty_cash_expenses_new (
  id, shift_id, location_id, worker_id, amount_pesewas, category,
  payee, photo_url, notes, supervisor_approval_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at
)
SELECT
  id, shift_id, location_id, worker_id, amount_pesewas, category,
  payee, photo_url, notes, supervisor_approval_id,
  created_at, created_by, updated_at, updated_by, device_id, synced_at
FROM petty_cash_expenses;

DROP TABLE petty_cash_expenses;
ALTER TABLE petty_cash_expenses_new RENAME TO petty_cash_expenses;

CREATE INDEX idx_petty_cash_shift ON petty_cash_expenses(shift_id);
CREATE INDEX idx_petty_cash_location_date ON petty_cash_expenses(location_id, created_at DESC);
CREATE INDEX idx_petty_cash_category_date ON petty_cash_expenses(category, created_at DESC);

CREATE TRIGGER trg_outbox_petty_cash_expenses_ins AFTER INSERT ON petty_cash_expenses
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('petty_cash_expenses', NEW.id, 'INSERT');
END;
