-- 0041_drawings_supplier_invoices.sql
-- Split owner/family drawings from generic cash drops and add invoice-level
-- supplier payables with structured receipt rows.

PRAGMA foreign_keys = ON;

ALTER TABLE suppliers ADD COLUMN credit_limit_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (credit_limit_pesewas >= 0);

ALTER TABLE suppliers ADD COLUMN payment_schedule TEXT NOT NULL DEFAULT 'ON_RECEIPT'
  CHECK (payment_schedule IN ('ON_RECEIPT', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'));

CREATE TABLE drawing_policies (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'OWNER_DRAWING', 'FAMILY_SUPPORT', 'OWNER_SALARY', 'OTHER_DRAWING'
  )),
  beneficiary_name TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('DAILY', 'WEEKLY', 'MONTHLY', 'AD_HOC')),
  limit_pesewas INTEGER NOT NULL CHECK (limit_pesewas >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT
);
CREATE INDEX idx_drawing_policies_active ON drawing_policies(active) WHERE deleted_at IS NULL;

CREATE TABLE owner_drawings (
  id TEXT PRIMARY KEY,
  cash_count_id TEXT NOT NULL UNIQUE REFERENCES cash_counts(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  category TEXT NOT NULL CHECK (category IN (
    'OWNER_DRAWING', 'FAMILY_SUPPORT', 'OWNER_SALARY', 'OTHER_DRAWING'
  )),
  beneficiary_name TEXT NOT NULL,
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  policy_id TEXT REFERENCES drawing_policies(id),
  policy_period_key TEXT,
  notes TEXT,
  approved_by TEXT NOT NULL REFERENCES workers(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX idx_owner_drawings_period ON owner_drawings(location_id, created_at DESC);
CREATE INDEX idx_owner_drawings_category ON owner_drawings(category, created_at DESC);
CREATE INDEX idx_owner_drawings_policy ON owner_drawings(policy_id, policy_period_key)
  WHERE policy_id IS NOT NULL;

CREATE TABLE supplier_invoices (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  purchase_order_id TEXT REFERENCES purchase_orders(id),
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  total_pesewas INTEGER NOT NULL CHECK (total_pesewas >= 0),
  total_paid_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (total_paid_pesewas >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN', 'PARTIALLY_PAID', 'PAID', 'DISPUTED', 'VOID'
  )),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (supplier_id, invoice_number)
);
CREATE INDEX idx_supplier_invoices_supplier_due ON supplier_invoices(supplier_id, due_date, status);
CREATE INDEX idx_supplier_invoices_status ON supplier_invoices(status, due_date);
CREATE INDEX idx_supplier_invoices_po ON supplier_invoices(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;

CREATE TABLE supplier_invoice_lines (
  id TEXT PRIMARY KEY,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id),
  stock_movement_id TEXT REFERENCES stock_movements(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  source_unit_id TEXT REFERENCES product_units(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  canonical_quantity INTEGER NOT NULL CHECK (canonical_quantity > 0),
  unit_cost_pesewas INTEGER NOT NULL CHECK (unit_cost_pesewas >= 0),
  line_total_pesewas INTEGER NOT NULL CHECK (line_total_pesewas >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX idx_supplier_invoice_lines_invoice ON supplier_invoice_lines(supplier_invoice_id);
CREATE INDEX idx_supplier_invoice_lines_product ON supplier_invoice_lines(product_id);
CREATE INDEX idx_supplier_invoice_lines_movement ON supplier_invoice_lines(stock_movement_id)
  WHERE stock_movement_id IS NOT NULL;

CREATE TABLE supplier_invoice_payment_allocations (
  id TEXT PRIMARY KEY,
  supplier_payment_id TEXT NOT NULL REFERENCES supplier_payments(id),
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX idx_sipa_payment ON supplier_invoice_payment_allocations(supplier_payment_id);
CREATE INDEX idx_sipa_invoice ON supplier_invoice_payment_allocations(supplier_invoice_id);

CREATE TRIGGER trg_outbox_drawing_policies_ins AFTER INSERT ON drawing_policies
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('drawing_policies', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_drawing_policies_upd AFTER UPDATE ON drawing_policies
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('drawing_policies', NEW.id, 'UPDATE');
END;

CREATE TRIGGER trg_outbox_owner_drawings_ins AFTER INSERT ON owner_drawings
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('owner_drawings', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_supplier_invoices_ins AFTER INSERT ON supplier_invoices
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('supplier_invoices', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_supplier_invoices_upd AFTER UPDATE ON supplier_invoices
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('supplier_invoices', NEW.id, 'UPDATE');
END;

CREATE TRIGGER trg_outbox_supplier_invoice_lines_ins AFTER INSERT ON supplier_invoice_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('supplier_invoice_lines', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_supplier_invoice_payment_allocations_ins
AFTER INSERT ON supplier_invoice_payment_allocations
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('supplier_invoice_payment_allocations', NEW.id, 'INSERT');
END;
