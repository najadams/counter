-- 0039_pending_orders.sql
-- Local mirror of confirmed WhatsApp orders (Phase 4 workstream C).
--
-- Populated by the pull worker from the central orders-feed the moment an
-- order is CONFIRMED (customer and agent already agreed on lines and price —
-- see docs/phase4-whatsapp-order-agent.md §C2). A cashier then either:
--   - Accepts it: rings it through the normal Sale screen, quoted prices
--     loaded as-is. There is no separate "accepted but not sold" status —
--     completeSale is Counter's only real commitment point, and a hard
--     reservation state would contradict the "no hard stock reservation"
--     decision in the design doc §1. The row moves CONFIRMED -> FULFILLED
--     only once a real sale exists.
--   - Rejects it: declines with a reason. No stock/money effect — nothing
--     was ever rung, so there's nothing to reverse. Distinct from a customer/
--     agent-side CANCELLED, so the agent can give the customer an honest
--     reason ("the shop couldn't fulfil this") rather than a generic one.
--
-- Unlike the append-only event tables (0032), THIS row is mutated in place
-- (CONFIRMED -> FULFILLED|REJECTED|CANCELLED), so it needs an UPDATE capture
-- trigger in addition to INSERT — mirrors the master-capture pattern in 0033,
-- minus the HQ-only guard: this is shop-owned state that always flows up,
-- not HQ-owned catalog data.
--
-- The central side's writeback trigger (supabase/migrations/
-- 20260702160000_order_fulfilment_writeback.sql) is what turns an UPDATE here
-- into the authoritative `orders.status` change the agent reads to notify
-- the customer.

CREATE TABLE pending_orders (
  id                 TEXT PRIMARY KEY,          -- central orders.id (uuid, as text)
  status             TEXT NOT NULL CHECK (status IN ('CONFIRMED','FULFILLED','CANCELLED','REJECTED')),
  customer_phone     TEXT NOT NULL,
  customer_name      TEXT,
  channel            TEXT NOT NULL,
  subtotal_pesewas   INTEGER NOT NULL,
  total_pesewas      INTEGER NOT NULL,
  quote_expires_at   TEXT,
  confirmed_at       TEXT,
  -- [{productId, unitId, quantity, unitPricePesewas, lineTotalPesewas}, ...] —
  -- denormalized JSON rather than a child table: this row is read-mostly (one
  -- screen renders it, one action consumes it) and never queried per-line, so
  -- a second synced table would add outbox/trigger machinery for no benefit.
  lines_json         TEXT NOT NULL,
  fulfilled_sale_id  TEXT REFERENCES sales(id),
  reject_reason      TEXT,
  received_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- NULL on the initial pull-created row (no human actor yet); set when a
  -- cashier accepts/rejects it.
  updated_by         TEXT REFERENCES workers(id),
  device_id          TEXT NOT NULL,
  synced_at          TEXT
);
CREATE INDEX idx_pending_orders_status ON pending_orders(status);

CREATE TRIGGER trg_outbox_pending_orders_ins AFTER INSERT ON pending_orders
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('pending_orders', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_pending_orders_upd AFTER UPDATE ON pending_orders
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('pending_orders', NEW.id, 'UPDATE');
END;
