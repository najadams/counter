-- 0052_stock_receipt_requests.sql
-- Asynchronous approval queue for supplier and opening-stock receipts.
-- Pending requests are evidence only; stock, payables, POs, cost and ledger
-- records are written only when a senior reviewer approves.

PRAGMA foreign_keys = ON;

CREATE TABLE stock_receipt_requests (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  supplier_id TEXT REFERENCES suppliers(id),
  is_opening_stock INTEGER NOT NULL DEFAULT 0 CHECK (is_opening_stock IN (0,1)),
  purchase_order_id TEXT REFERENCES purchase_orders(id),
  supplier_invoice_number TEXT,
  supplier_invoice_date TEXT,
  supplier_due_date TEXT,
  transport_cost_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (transport_cost_pesewas >= 0),
  loading_cost_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (loading_cost_pesewas >= 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DECLINED','WITHDRAWN')),
  requested_by TEXT NOT NULL REFERENCES workers(id),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  request_device_id TEXT NOT NULL,
  reviewed_by TEXT REFERENCES workers(id),
  reviewed_at TEXT,
  review_note TEXT,
  review_device_id TEXT,
  withdrawn_at TEXT,
  cost_swing_approved INTEGER NOT NULL DEFAULT 0 CHECK (cost_swing_approved IN (0,1)),
  supplier_invoice_id TEXT REFERENCES supplier_invoices(id),
  movement_ids_json TEXT,
  total_value_pesewas INTEGER,
  total_payable_pesewas INTEGER,
  products_cost_updated INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  CHECK (
    (is_opening_stock = 1 AND supplier_id IS NULL AND purchase_order_id IS NULL
      AND supplier_invoice_number IS NULL AND supplier_invoice_date IS NULL
      AND supplier_due_date IS NULL AND transport_cost_pesewas = 0 AND loading_cost_pesewas = 0)
    OR
    (is_opening_stock = 0 AND supplier_id IS NOT NULL)
  ),
  CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_device_id IS NULL AND withdrawn_at IS NULL
      AND supplier_invoice_id IS NULL AND movement_ids_json IS NULL
      AND total_value_pesewas IS NULL AND total_payable_pesewas IS NULL
      AND products_cost_updated IS NULL)
    OR
    (status = 'APPROVED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_device_id IS NOT NULL AND withdrawn_at IS NULL
      AND movement_ids_json IS NOT NULL AND total_value_pesewas IS NOT NULL
      AND total_payable_pesewas IS NOT NULL AND products_cost_updated IS NOT NULL)
    OR
    (status = 'DECLINED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_device_id IS NOT NULL AND withdrawn_at IS NULL
      AND length(trim(COALESCE(review_note, ''))) BETWEEN 3 AND 300
      AND supplier_invoice_id IS NULL AND movement_ids_json IS NULL)
    OR
    (status = 'WITHDRAWN' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_device_id IS NULL AND withdrawn_at IS NOT NULL
      AND supplier_invoice_id IS NULL AND movement_ids_json IS NULL)
  )
);
CREATE INDEX idx_stock_receipt_requests_queue
  ON stock_receipt_requests(location_id, status, requested_at);
CREATE INDEX idx_stock_receipt_requests_requester
  ON stock_receipt_requests(requested_by, requested_at DESC);
CREATE INDEX idx_stock_receipt_requests_supplier
  ON stock_receipt_requests(supplier_id, requested_at DESC);

CREATE TABLE stock_receipt_request_lines (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES stock_receipt_requests(id),
  line_number INTEGER NOT NULL CHECK (line_number >= 0),
  product_id TEXT NOT NULL REFERENCES products(id),
  source_unit_id TEXT REFERENCES product_units(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_pesewas INTEGER NOT NULL CHECK (unit_cost_pesewas >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  UNIQUE (request_id, line_number)
);
CREATE INDEX idx_stock_receipt_request_lines_request
  ON stock_receipt_request_lines(request_id, created_at, id);

CREATE TRIGGER trg_stock_receipt_requests_identity_immutable
BEFORE UPDATE ON stock_receipt_requests
WHEN NEW.id <> OLD.id
  OR NEW.location_id <> OLD.location_id
  OR COALESCE(NEW.supplier_id, '') <> COALESCE(OLD.supplier_id, '')
  OR NEW.is_opening_stock <> OLD.is_opening_stock
  OR COALESCE(NEW.purchase_order_id, '') <> COALESCE(OLD.purchase_order_id, '')
  OR COALESCE(NEW.supplier_invoice_number, '') <> COALESCE(OLD.supplier_invoice_number, '')
  OR COALESCE(NEW.supplier_invoice_date, '') <> COALESCE(OLD.supplier_invoice_date, '')
  OR COALESCE(NEW.supplier_due_date, '') <> COALESCE(OLD.supplier_due_date, '')
  OR NEW.transport_cost_pesewas <> OLD.transport_cost_pesewas
  OR NEW.loading_cost_pesewas <> OLD.loading_cost_pesewas
  OR COALESCE(NEW.notes, '') <> COALESCE(OLD.notes, '')
  OR NEW.requested_by <> OLD.requested_by
  OR NEW.requested_at <> OLD.requested_at
  OR NEW.request_device_id <> OLD.request_device_id
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'stock receipt request evidence is immutable');
END;

CREATE TRIGGER trg_stock_receipt_requests_terminal_immutable
BEFORE UPDATE ON stock_receipt_requests
WHEN OLD.status <> 'PENDING'
BEGIN
  SELECT RAISE(ABORT, 'resolved stock receipt requests are immutable');
END;

CREATE TRIGGER trg_stock_receipt_requests_transition
BEFORE UPDATE OF status ON stock_receipt_requests
WHEN OLD.status = 'PENDING' AND NEW.status NOT IN ('APPROVED','DECLINED','WITHDRAWN')
BEGIN
  SELECT RAISE(ABORT, 'invalid stock receipt request transition');
END;

CREATE TRIGGER trg_stock_receipt_requests_no_delete
BEFORE DELETE ON stock_receipt_requests
BEGIN
  SELECT RAISE(ABORT, 'stock receipt requests cannot be deleted');
END;

CREATE TRIGGER trg_stock_receipt_request_lines_no_update
BEFORE UPDATE ON stock_receipt_request_lines
BEGIN
  SELECT RAISE(ABORT, 'stock receipt request lines are immutable');
END;

CREATE TRIGGER trg_stock_receipt_request_lines_no_delete
BEFORE DELETE ON stock_receipt_request_lines
BEGIN
  SELECT RAISE(ABORT, 'stock receipt request lines cannot be deleted');
END;

CREATE TRIGGER trg_outbox_stock_receipt_requests_ins
AFTER INSERT ON stock_receipt_requests
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('stock_receipt_requests', NEW.id, 'INSERT');
END;
CREATE TRIGGER trg_outbox_stock_receipt_requests_upd
AFTER UPDATE ON stock_receipt_requests
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('stock_receipt_requests', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_stock_receipt_request_lines_ins
AFTER INSERT ON stock_receipt_request_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('stock_receipt_request_lines', NEW.id, 'INSERT');
END;
