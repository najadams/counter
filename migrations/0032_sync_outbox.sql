-- 0032_sync_outbox.sql
-- Phase 3b foundation: the change-capture layer for multi-shop sync.
--
-- sync_outbox is an append-only, monotonically-numbered log of "this row needs
-- to go up to the central store". A background sync worker (later commit) reads
-- unacked rows in seq order, ships them, and stamps acked_at. The seq is
-- INTEGER PRIMARY KEY AUTOINCREMENT on purpose: it is strictly increasing and
-- never reused (unlike a plain rowid), so the central side can detect a GAP in
-- a shop's seq stream — i.e. data lost in transit, itself a shrinkage signal.
--
-- SCOPE: this migration captures only the append-only EVENT tables (sales,
-- payments, stock moves, audit, etc.). These are shop-owned and flow UP, with
-- no two shops ever writing the same row, so there is nothing to merge.
--
-- Master/catalog tables (products, prices, workers, ...) are deliberately NOT
-- captured here. They flow DOWN from HQ (Phase 3c). If we enqueued them now,
-- the pull-apply step on a shop would re-enqueue HQ's own edits and push them
-- back up — a feedback loop. Master capture lands in 3c together with the
-- HQ/shop role flag and an "applying remote" guard that suppresses it.
--
-- See docs/phase3-network-and-sync.md (B2-B4) for the full model.

CREATE TABLE sync_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,   -- strictly increasing, never reused
  table_name  TEXT    NOT NULL,
  row_pk      TEXT    NOT NULL,                     -- the row's TEXT/UUID id
  op          TEXT    NOT NULL CHECK (op IN ('INSERT','UPDATE')),
  enqueued_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acked_at    TEXT                                  -- set once the central store confirms
);
-- Partial index: the sync worker only ever scans the unacked tail.
CREATE INDEX idx_outbox_unacked ON sync_outbox(seq) WHERE acked_at IS NULL;

-- Per-install sync bookkeeping (push watermark, pull cursor, last-sync time).
-- Keyed key/value so new cursors can be added without a schema change.
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- --- Capture triggers: one per append-only event table ---------------------
-- Each fires AFTER INSERT and enqueues (table, row id, 'INSERT'). Event rows
-- are immutable, so no UPDATE/DELETE triggers are needed.

CREATE TRIGGER trg_outbox_sales_ins AFTER INSERT ON sales
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('sales', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_sale_lines_ins AFTER INSERT ON sale_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('sale_lines', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_sale_payments_ins AFTER INSERT ON sale_payments
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('sale_payments', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_stock_movements_ins AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('stock_movements', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_breakage_log_ins AFTER INSERT ON breakage_log
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('breakage_log', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_worker_consumption_log_ins AFTER INSERT ON worker_consumption_log
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('worker_consumption_log', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_audit_log_ins AFTER INSERT ON audit_log
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('audit_log', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_customer_payments_ins AFTER INSERT ON customer_payments
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('customer_payments', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_customer_payment_allocations_ins AFTER INSERT ON customer_payment_allocations
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('customer_payment_allocations', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_supplier_payments_ins AFTER INSERT ON supplier_payments
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('supplier_payments', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_supplier_payment_allocations_ins AFTER INSERT ON supplier_payment_allocations
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('supplier_payment_allocations', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_purchase_orders_ins AFTER INSERT ON purchase_orders
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('purchase_orders', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_purchase_order_lines_ins AFTER INSERT ON purchase_order_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('purchase_order_lines', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_cash_counts_ins AFTER INSERT ON cash_counts
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('cash_counts', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_shifts_ins AFTER INSERT ON shifts
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('shifts', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_stocktake_events_ins AFTER INSERT ON stocktake_events
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('stocktake_events', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_stocktake_lines_ins AFTER INSERT ON stocktake_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('stocktake_lines', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_period_closes_ins AFTER INSERT ON period_closes
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('period_closes', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_petty_cash_expenses_ins AFTER INSERT ON petty_cash_expenses
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('petty_cash_expenses', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_container_movements_ins AFTER INSERT ON container_movements
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('container_movements', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_customer_returns_ins AFTER INSERT ON customer_returns
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('customer_returns', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_customer_return_lines_ins AFTER INSERT ON customer_return_lines
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('customer_return_lines', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_route_runs_ins AFTER INSERT ON route_runs
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('route_runs', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_route_stops_ins AFTER INSERT ON route_stops
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('route_stops', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_daily_summaries_ins AFTER INSERT ON daily_summaries
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('daily_summaries', NEW.id, 'INSERT');
END;
