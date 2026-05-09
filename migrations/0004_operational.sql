-- 0004_operational.sql
-- Shifts, stock movements, sales, sale lines, cash counts.
-- This is the heart of the system.

PRAGMA foreign_keys = ON;

-- shifts --------------------------------------------------------------------
-- The unit of accountability. Everything that happens happens in a shift.
-- Pushback fix #5: closing_cash_counted is captured BEFORE expected is shown.
-- Application layer guarantees this; schema does not allow them to be set
-- in a single statement (different INSERT/UPDATE moments).
CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  shift_type TEXT NOT NULL CHECK (shift_type IN ('COUNTER', 'ROUTE')),
  opening_cash_pesewas INTEGER NOT NULL,
  closing_cash_counted_pesewas INTEGER,
  closing_cash_expected_pesewas INTEGER,
  cash_variance_pesewas INTEGER,
  total_sales_pesewas INTEGER NOT NULL DEFAULT 0,
  total_breakage_value_pesewas INTEGER NOT NULL DEFAULT 0,
  shrinkage_value_pesewas INTEGER,
  shrinkage_rate REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (opening_cash_pesewas >= 0),
  -- closed_at consistency: if closed, the close-time fields must be set.
  CHECK (
    (closed_at IS NULL) OR
    (closed_at IS NOT NULL
      AND closing_cash_counted_pesewas IS NOT NULL
      AND closing_cash_expected_pesewas IS NOT NULL
      AND cash_variance_pesewas IS NOT NULL)
  )
);
CREATE INDEX idx_shifts_worker ON shifts(worker_id, opened_at DESC);
CREATE INDEX idx_shifts_open ON shifts(closed_at) WHERE closed_at IS NULL;
CREATE INDEX idx_shifts_date ON shifts(opened_at);
CREATE INDEX idx_shifts_location_date ON shifts(location_id, opened_at DESC);

-- stock_movements -----------------------------------------------------------
-- The single source of truth for inventory.
-- SUM(quantity) WHERE product_id = X AND location_id = Y = current stock.
-- No stock_levels cache table by design.
--
-- quantity is signed. insertStockMovement() looks up reason_codes.category
-- and signs the value: inflow positive, outflow negative.
-- Never UPDATE this table — corrections are new rows with reversing reasons.
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity INTEGER NOT NULL,                     -- signed, never zero
  reason_code TEXT NOT NULL REFERENCES reason_codes(code),
  shift_id TEXT REFERENCES shifts(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  -- one of these is set depending on reason_code (declared in app, not enforced
  -- as XOR here because some rows are pure adjustments with no parent).
  sale_id TEXT,
  purchase_order_id TEXT,
  route_run_id TEXT,
  breakage_log_id TEXT,
  unit_cost_pesewas INTEGER NOT NULL,
  total_value_pesewas INTEGER NOT NULL,          -- signed: quantity * unit_cost
  photo_url TEXT,                                 -- required by app if reason_codes.requires_photo = 1
  supervisor_approval_id TEXT REFERENCES workers(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (quantity != 0),
  CHECK (unit_cost_pesewas >= 0)
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id, location_id, created_at DESC);
CREATE INDEX idx_stock_movements_shift ON stock_movements(shift_id);
CREATE INDEX idx_stock_movements_reason ON stock_movements(reason_code);
CREATE INDEX idx_stock_movements_worker ON stock_movements(worker_id, created_at DESC);
CREATE INDEX idx_stock_movements_sale ON stock_movements(sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_stock_movements_route_run ON stock_movements(route_run_id) WHERE route_run_id IS NOT NULL;
CREATE INDEX idx_stock_movements_location ON stock_movements(location_id, created_at DESC);

-- sales ---------------------------------------------------------------------
-- Pushback fix #3: printer_failed flag captures degraded-mode receipts.
-- Sale completes regardless of printer state; printer_failed = 1 puts the
-- row into the supervisor's reprint queue.
CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  customer_id TEXT REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('WALK_IN', 'WHOLESALE', 'ROUTE')),
  route_run_id TEXT,
  route_stop_id TEXT,
  subtotal_pesewas INTEGER NOT NULL,
  discount_pesewas INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT,
  total_pesewas INTEGER NOT NULL,
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  payment_reference TEXT,
  is_credit INTEGER NOT NULL DEFAULT 0 CHECK (is_credit IN (0, 1)),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  voided_by TEXT REFERENCES workers(id),
  voided_at TEXT,
  void_reason TEXT,
  printer_failed INTEGER NOT NULL DEFAULT 0 CHECK (printer_failed IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (subtotal_pesewas >= 0),
  CHECK (discount_pesewas >= 0),
  CHECK (total_pesewas >= 0),
  CHECK (total_pesewas = subtotal_pesewas - discount_pesewas),
  CHECK ((discount_pesewas = 0) OR (discount_pesewas > 0 AND discount_reason IS NOT NULL)),
  CHECK ((voided = 0 AND voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided = 1 AND voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sales_customer ON sales(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_sales_worker_date ON sales(worker_id, created_at DESC);
CREATE INDEX idx_sales_channel ON sales(channel, created_at);
CREATE INDEX idx_sales_credit_open ON sales(customer_id) WHERE is_credit = 1 AND voided = 0;
CREATE INDEX idx_sales_route_run ON sales(route_run_id) WHERE route_run_id IS NOT NULL;
CREATE INDEX idx_sales_location_date ON sales(location_id, created_at DESC);
CREATE INDEX idx_sales_printer_failed ON sales(printer_failed, created_at DESC) WHERE printer_failed = 1;

-- sale_lines ----------------------------------------------------------------
-- Invariant 7: unit_cost_pesewas is snapshotted at sale time.
-- margin_pesewas = (unit_price - unit_cost) * quantity, computed at insert.
-- Never UPDATE these rows.
CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_pesewas INTEGER NOT NULL,
  unit_cost_pesewas INTEGER NOT NULL,
  line_total_pesewas INTEGER NOT NULL,
  margin_pesewas INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (unit_price_pesewas >= 0),
  CHECK (unit_cost_pesewas >= 0),
  CHECK (line_total_pesewas = unit_price_pesewas * quantity),
  CHECK (margin_pesewas = (unit_price_pesewas - unit_cost_pesewas) * quantity)
);
CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id, created_at DESC);

-- cash_counts ---------------------------------------------------------------
-- Discrete cash counts. The blind-count rule (invariant 9) is application-
-- enforced: counted_pesewas is INSERTed first, expected_pesewas + variance
-- are filled in by a follow-up UPDATE in the same transaction.
CREATE TABLE cash_counts (
  id TEXT PRIMARY KEY,
  shift_id TEXT REFERENCES shifts(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  count_type TEXT NOT NULL CHECK (count_type IN (
    'SHIFT_OPEN', 'SHIFT_CLOSE', 'SPOT_CHECK', 'CASH_DROP', 'OWNER_RECONCILIATION'
  )),
  counted_pesewas INTEGER NOT NULL,
  expected_pesewas INTEGER,
  variance_pesewas INTEGER,
  notes TEXT,
  supervisor_id TEXT REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (counted_pesewas >= 0),
  -- expected and variance arrive together
  CHECK ((expected_pesewas IS NULL AND variance_pesewas IS NULL)
      OR (expected_pesewas IS NOT NULL AND variance_pesewas IS NOT NULL))
);
CREATE INDEX idx_cash_counts_shift ON cash_counts(shift_id);
CREATE INDEX idx_cash_counts_worker_date ON cash_counts(worker_id, created_at DESC);
CREATE INDEX idx_cash_counts_location_date ON cash_counts(location_id, created_at DESC);
