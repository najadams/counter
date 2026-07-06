-- 0042_price_customer_delivery_intelligence.sql
-- Price intelligence, landed-cost allocation, and delivery operations.

PRAGMA foreign_keys = ON;

ALTER TABLE products ADD COLUMN minimum_price_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (minimum_price_pesewas >= 0);
ALTER TABLE products ADD COLUMN competitor_price_pesewas INTEGER
  CHECK (competitor_price_pesewas IS NULL OR competitor_price_pesewas >= 0);
ALTER TABLE products ADD COLUMN competitor_name TEXT;
ALTER TABLE products ADD COLUMN competitor_checked_at TEXT;

CREATE TABLE price_history (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  field_name TEXT NOT NULL CHECK (field_name IN (
    'COST','WALK_IN','WHOLESALE','ROUTE','MINIMUM','COMPETITOR'
  )),
  old_pesewas INTEGER,
  new_pesewas INTEGER,
  competitor_name TEXT,
  reason TEXT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  changed_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (old_pesewas IS NULL OR old_pesewas >= 0),
  CHECK (new_pesewas IS NULL OR new_pesewas >= 0)
);
CREATE INDEX idx_price_history_product ON price_history(product_id, changed_at DESC);
CREATE INDEX idx_price_history_changed_at ON price_history(changed_at DESC);

ALTER TABLE supplier_invoices ADD COLUMN transport_cost_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (transport_cost_pesewas >= 0);
ALTER TABLE supplier_invoices ADD COLUMN loading_cost_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (loading_cost_pesewas >= 0);

ALTER TABLE supplier_invoice_lines ADD COLUMN allocated_transport_cost_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (allocated_transport_cost_pesewas >= 0);
ALTER TABLE supplier_invoice_lines ADD COLUMN allocated_loading_cost_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (allocated_loading_cost_pesewas >= 0);
ALTER TABLE supplier_invoice_lines ADD COLUMN landed_line_total_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (landed_line_total_pesewas >= 0);

-- Keep order-decision status (CONFIRMED/FULFILLED/REJECTED) separate from the
-- delivery lifecycle so the central order writeback remains stable.
ALTER TABLE pending_orders ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
  CHECK (delivery_status IN ('NOT_STARTED','PACKED','DISPATCHED','DELIVERED','FAILED'));
ALTER TABLE pending_orders ADD COLUMN packed_at TEXT;
ALTER TABLE pending_orders ADD COLUMN packed_by TEXT REFERENCES workers(id);
ALTER TABLE pending_orders ADD COLUMN dispatched_at TEXT;
ALTER TABLE pending_orders ADD COLUMN dispatched_by TEXT REFERENCES workers(id);
ALTER TABLE pending_orders ADD COLUMN driver_id TEXT REFERENCES workers(id);
ALTER TABLE pending_orders ADD COLUMN delivery_fee_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_fee_pesewas >= 0);
ALTER TABLE pending_orders ADD COLUMN delivery_cost_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_cost_pesewas >= 0);
ALTER TABLE pending_orders ADD COLUMN delivered_at TEXT;
ALTER TABLE pending_orders ADD COLUMN delivered_by TEXT REFERENCES workers(id);
ALTER TABLE pending_orders ADD COLUMN delivery_failed_at TEXT;
ALTER TABLE pending_orders ADD COLUMN delivery_failure_reason TEXT;
ALTER TABLE pending_orders ADD COLUMN delivery_confirmation_code TEXT;
ALTER TABLE pending_orders ADD COLUMN delivery_confirmation_name TEXT;
ALTER TABLE pending_orders ADD COLUMN delivery_profit_pesewas INTEGER;

CREATE TRIGGER trg_outbox_price_history_ins AFTER INSERT ON price_history
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('price_history', NEW.id, 'INSERT');
END;
