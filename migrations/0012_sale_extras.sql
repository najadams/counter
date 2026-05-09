-- 0012_sale_extras.sql
-- Adds the SALE_VOID_REVERSAL reason (consumed by voidSale in Session 4)
-- and a real device_config table seeded with shop_name for receipts.

PRAGMA foreign_keys = ON;

INSERT INTO reason_codes
  (code, category, description, affects_cash, requires_photo, requires_supervisor, display_order)
VALUES
  ('SALE_VOID_REVERSAL', 'inflow', 'Stock returned to inventory by sale void', 0, 0, 0, 130);

-- device_config: deviceId.ts creates this lazily, but having it as a real
-- migration documents the schema and lets us seed defaults.
CREATE TABLE IF NOT EXISTS device_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed the receipt header. Owner can change later via settings.
INSERT OR IGNORE INTO device_config (key, value) VALUES
  ('shop_name', 'COUNTER SHOP'),
  ('shop_subtitle', 'Accra, Ghana');
