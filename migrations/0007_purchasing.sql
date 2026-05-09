-- 0007_purchasing.sql
-- Purchase orders, PO lines, supplier payments, payment-to-PO allocations.
-- total_ordered, total_received, total_paid are three independent values
-- because in informal trade they almost never match.

PRAGMA foreign_keys = ON;

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL CHECK (status IN (
    'DRAFT','PLACED','PARTIALLY_RECEIVED','RECEIVED','PAID','CANCELLED'
  )),
  po_number TEXT NOT NULL UNIQUE,
  ordered_at TEXT,
  expected_delivery_date TEXT,
  received_at TEXT,
  paid_at TEXT,
  total_ordered_pesewas INTEGER NOT NULL DEFAULT 0,
  total_received_pesewas INTEGER NOT NULL DEFAULT 0,
  total_paid_pesewas INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT REFERENCES workers(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (total_ordered_pesewas >= 0),
  CHECK (total_received_pesewas >= 0),
  CHECK (total_paid_pesewas >= 0)
);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id, ordered_at DESC);
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_location ON purchase_orders(location_id, ordered_at DESC);

CREATE TABLE purchase_order_lines (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity_ordered INTEGER NOT NULL,
  quantity_received INTEGER NOT NULL DEFAULT 0,
  unit_cost_pesewas INTEGER NOT NULL,
  line_total_ordered_pesewas INTEGER NOT NULL,
  line_total_received_pesewas INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (quantity_ordered > 0),
  CHECK (quantity_received >= 0),
  CHECK (quantity_received <= quantity_ordered),
  CHECK (unit_cost_pesewas >= 0)
);
CREATE INDEX idx_po_lines_po ON purchase_order_lines(purchase_order_id);
CREATE INDEX idx_po_lines_product ON purchase_order_lines(product_id);

-- supplier_payments: independent of POs because suppliers often get
-- lump-sum payments against multiple POs.
CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  amount_pesewas INTEGER NOT NULL,
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  payment_reference TEXT,
  paid_at TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES workers(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (amount_pesewas > 0)
);
CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(supplier_id, paid_at DESC);

CREATE TABLE supplier_payment_allocations (
  id TEXT PRIMARY KEY,
  supplier_payment_id TEXT NOT NULL REFERENCES supplier_payments(id),
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  amount_pesewas INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (amount_pesewas > 0)
);
CREATE INDEX idx_spa_payment ON supplier_payment_allocations(supplier_payment_id);
CREATE INDEX idx_spa_po ON supplier_payment_allocations(purchase_order_id);
