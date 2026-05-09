-- 0008_credit.sql
-- Customer credit: payments received and how they allocate against sales.

PRAGMA foreign_keys = ON;

CREATE TABLE customer_payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount_pesewas INTEGER NOT NULL,
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  payment_reference TEXT,
  received_at TEXT NOT NULL,
  received_by TEXT NOT NULL REFERENCES workers(id),
  shift_id TEXT REFERENCES shifts(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (amount_pesewas > 0)
);
CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id, received_at DESC);

CREATE TABLE customer_payment_allocations (
  id TEXT PRIMARY KEY,
  customer_payment_id TEXT NOT NULL REFERENCES customer_payments(id),
  sale_id TEXT NOT NULL REFERENCES sales(id),
  amount_pesewas INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (amount_pesewas > 0)
);
CREATE INDEX idx_cpa_payment ON customer_payment_allocations(customer_payment_id);
CREATE INDEX idx_cpa_sale ON customer_payment_allocations(sale_id);
