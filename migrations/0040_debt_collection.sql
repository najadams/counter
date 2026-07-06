-- 0040_debt_collection.sql
-- Due dates, recovery status, follow-up notes, payment promises, and a
-- cash-only customer flag for hard credit control.

PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN cash_only INTEGER NOT NULL DEFAULT 0
  CHECK (cash_only IN (0, 1));

ALTER TABLE sales ADD COLUMN credit_due_date TEXT;

ALTER TABLE sales ADD COLUMN debt_status TEXT NOT NULL DEFAULT 'CURRENT'
  CHECK (debt_status IN (
    'CURRENT','OVERDUE','PROMISED','RECOVERABLE','DOUBTFUL','DEAD'
  ));

ALTER TABLE sales ADD COLUMN debt_status_updated_at TEXT;
ALTER TABLE sales ADD COLUMN debt_status_updated_by TEXT;

CREATE INDEX idx_sales_debt_due
  ON sales(credit_due_date, debt_status)
  WHERE is_credit = 1 AND voided = 0;

CREATE TABLE customer_debt_followups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  sale_id TEXT REFERENCES sales(id),
  contact_method TEXT NOT NULL CHECK (contact_method IN (
    'CALL','WHATSAPP','VISIT','IN_PERSON','SMS','OTHER'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'NO_ANSWER','PROMISED_TO_PAY','PART_PAID','DISPUTED','REFUSED','REMINDER_SENT','OTHER'
  )),
  notes TEXT,
  next_follow_up_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE INDEX idx_debt_followups_customer
  ON customer_debt_followups(customer_id, created_at DESC);

CREATE INDEX idx_debt_followups_sale
  ON customer_debt_followups(sale_id, created_at DESC)
  WHERE sale_id IS NOT NULL;

CREATE INDEX idx_debt_followups_next
  ON customer_debt_followups(next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

CREATE TABLE customer_payment_promises (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  sale_id TEXT REFERENCES sales(id),
  promised_amount_pesewas INTEGER NOT NULL CHECK (promised_amount_pesewas > 0),
  promise_due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','KEPT','BROKEN','CANCELLED')),
  notes TEXT,
  fulfilled_payment_id TEXT REFERENCES customer_payments(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE INDEX idx_payment_promises_customer
  ON customer_payment_promises(customer_id, status, promise_due_date);

CREATE INDEX idx_payment_promises_sale
  ON customer_payment_promises(sale_id, status, promise_due_date)
  WHERE sale_id IS NOT NULL;
