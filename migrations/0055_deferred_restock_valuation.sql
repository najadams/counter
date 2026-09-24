-- Signed balances represent explicitly acknowledged unrecorded receipts.
-- Preserve existing rows and their identifiers, with no historical recalculation.
CREATE TABLE inventory_valuation_movements_new (
  id TEXT PRIMARY KEY,
  stock_movement_id TEXT UNIQUE REFERENCES stock_movements(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity_delta INTEGER NOT NULL,
  value_delta_pesewas INTEGER NOT NULL,
  balance_quantity INTEGER NOT NULL,
  balance_value_pesewas INTEGER NOT NULL,
  average_unit_cost_pesewas INTEGER NOT NULL CHECK (average_unit_cost_pesewas >= 0),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (quantity_delta != 0)
);

INSERT INTO inventory_valuation_movements_new SELECT * FROM inventory_valuation_movements ORDER BY rowid;
DROP TABLE inventory_valuation_movements;
ALTER TABLE inventory_valuation_movements_new RENAME TO inventory_valuation_movements;
CREATE INDEX idx_inventory_valuation_product ON inventory_valuation_movements(product_id, location_id, occurred_at, id);
CREATE TRIGGER trg_outbox_inventory_valuation_movements_ins AFTER INSERT ON inventory_valuation_movements
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('inventory_valuation_movements', NEW.id, 'INSERT'); END;

-- Snapshot the exact net-cost share so VAT partial returns also telescope.
ALTER TABLE customer_return_lines ADD COLUMN restored_net_cost_pesewas INTEGER
  CHECK (restored_net_cost_pesewas IS NULL OR restored_net_cost_pesewas >= 0);
