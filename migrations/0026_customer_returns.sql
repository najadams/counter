-- 0026_customer_returns.sql
-- Wave C.3 — customer returns (distinct from sale voids).
--
-- A void reverses an entire sale that shouldn't have happened. A return is
-- when a customer comes back days later, drops off unsold stock, and we
-- re-shelve it. The two are accounted differently:
--
--   - voids:   reverse all stock & money atomically against the original sale
--   - returns: positive stock movement + a separate refund event (cash out,
--              customer balance reduction, or store credit). Original sale
--              stays intact.
--
-- The customer_returns table is the header; per-line detail lives in
-- customer_return_lines. A return must be approved by a supervisor (PIN).

CREATE TABLE customer_returns (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  -- The original sale, if known. Nullable because some shops accept returns
  -- without a receipt; we still want to track them but lose the linkage.
  original_sale_id TEXT REFERENCES sales(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  shift_id TEXT REFERENCES shifts(id),
  supervisor_approval_id TEXT NOT NULL REFERENCES workers(id),
  -- How the customer was made whole:
  --   CASH       -> we paid cash out of the till (recorded as a negative cash drop)
  --   CREDIT     -> reduce their outstanding balance (works for credit customers)
  --   STORE      -> store credit (future feature; for now, treat as CREDIT)
  refund_method TEXT NOT NULL CHECK (refund_method IN ('CASH', 'CREDIT', 'STORE')),
  total_refund_pesewas INTEGER NOT NULL CHECK (total_refund_pesewas >= 0),
  reason TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

CREATE INDEX idx_customer_returns_customer ON customer_returns(customer_id);
CREATE INDEX idx_customer_returns_created_at ON customer_returns(created_at);
CREATE INDEX idx_customer_returns_sale ON customer_returns(original_sale_id)
  WHERE original_sale_id IS NOT NULL;

CREATE TABLE customer_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES customer_returns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  applies_to_unit_id TEXT REFERENCES product_units(id),
  -- Quantity in display units (CRATE, BOTTLE, BAG_50KG). Service converts
  -- to canonical when posting the inflow stock movement.
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_pesewas INTEGER NOT NULL CHECK (unit_price_pesewas >= 0),
  line_total_pesewas INTEGER NOT NULL CHECK (line_total_pesewas >= 0),
  -- The stock_movement row this line created (RETURN_FROM_CUSTOMER reason).
  stock_movement_id TEXT REFERENCES stock_movements(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

CREATE INDEX idx_customer_return_lines_return ON customer_return_lines(return_id);
