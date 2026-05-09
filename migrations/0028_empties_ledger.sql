-- 0028_empties_ledger.sql
-- Wave F — empties / returnable container ledger.
--
-- Two parallel ledgers:
--   1. Per-customer empties owed: each sale of a returnable product
--      increments customers.empties_owed_count for that product. When the
--      customer returns empties, we decrement and (optionally) refund their
--      deposit out of the till. Balance can never go below 0.
--   2. Per-supplier depot reconciliation: full crates received and empties
--      returned at the depot are tracked in the same table tagged with
--      supplier_id. Weekly settlement checks net deposit owed/due.
--
-- One container_movements row per event for audit symmetry. Negative
-- quantities not allowed; the kind column makes direction explicit.

ALTER TABLE customers ADD COLUMN empties_owed_count INTEGER NOT NULL DEFAULT 0
  CHECK (empties_owed_count >= 0);

CREATE TABLE container_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  -- Exactly one of customer_id or supplier_id is set — the kind constrains
  -- which side the movement is on.
  customer_id TEXT REFERENCES customers(id),
  supplier_id TEXT REFERENCES suppliers(id),
  -- Positive integer count of containers (bottles, crates) — direction is
  -- encoded in `kind`, not in a sign.
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'CUSTOMER_TAKES_FULL',     -- sale of returnable: customer takes empties owe count up
    'CUSTOMER_RETURNS_EMPTY',  -- customer brings bottles back: empties owed down
    'DEPOT_RECEIVES_FULL',     -- we got full crates from supplier
    'DEPOT_RETURNS_EMPTY'      -- we sent empties back to supplier
  )),
  related_sale_id TEXT REFERENCES sales(id),
  related_return_id TEXT REFERENCES customer_returns(id),
  -- Per-container deposit captured at the time of the movement, in pesewas.
  -- Snapshotted to be honest about what the deposit was when the bottle
  -- left/returned, even if the product's bottle_deposit_pesewas changed
  -- later.
  deposit_per_container_pesewas INTEGER NOT NULL DEFAULT 0
    CHECK (deposit_per_container_pesewas >= 0),
  notes TEXT,
  shift_id TEXT REFERENCES shifts(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  -- Customer-facing kinds require customer_id; depot-facing kinds require supplier_id.
  CHECK (
    (kind IN ('CUSTOMER_TAKES_FULL', 'CUSTOMER_RETURNS_EMPTY')
       AND customer_id IS NOT NULL AND supplier_id IS NULL)
    OR
    (kind IN ('DEPOT_RECEIVES_FULL', 'DEPOT_RETURNS_EMPTY')
       AND supplier_id IS NOT NULL AND customer_id IS NULL)
  )
);

CREATE INDEX idx_container_movements_customer
  ON container_movements(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_container_movements_supplier
  ON container_movements(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_container_movements_kind ON container_movements(kind);
CREATE INDEX idx_container_movements_created_at ON container_movements(created_at);
CREATE INDEX idx_container_movements_product ON container_movements(product_id);
