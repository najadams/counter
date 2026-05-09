-- 0021_petty_cash_expenses.sql
-- Petty cash expenses paid out of the till.
--
-- Different from cash_counts(count_type='CASH_DROP'): a drop is cash
-- handed to the owner / put in the safe — same family, just out of the
-- till drawer. An expense is cash GONE: water bill, phone top-up,
-- transport for a runner, repair to the cooler.
--
-- Without this table, those payments look like cashier shrinkage at
-- shift close.
--
-- Service-level rules (not all enforceable in the schema):
--   - amount > 0 (CHECK)
--   - category from a closed enum (CHECK)
--   - photo_url required for amounts >= GHS 50.00 (5000 pesewas) — by app
--   - supervisor_approval_id required for amounts >= GHS 100.00 — by app

CREATE TABLE petty_cash_expenses (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  category TEXT NOT NULL CHECK (category IN (
    'RENT','UTILITIES','TRANSPORT','SUPPLIES','COMMS',
    'REPAIRS','BANK_FEES','OTHER'
  )),
  payee TEXT,                         -- "Ghana Water Company", "Kwesi Boatswain", etc.
  photo_url TEXT,                     -- receipt photo if available
  notes TEXT,
  supervisor_approval_id TEXT REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE INDEX idx_petty_cash_shift ON petty_cash_expenses(shift_id);
CREATE INDEX idx_petty_cash_location_date ON petty_cash_expenses(location_id, created_at DESC);
CREATE INDEX idx_petty_cash_category_date ON petty_cash_expenses(category, created_at DESC);
