-- 0033_sync_master_capture.sql
-- Phase 3c: capture HQ-authored catalog edits so they can flow DOWN to shops.
--
-- These triggers fire ONLY on the HQ install (device_config.sync_role = 'HQ').
-- That single guard is also the anti-feedback-loop mechanism: on a shop, where
-- sync_role is unset or 'SHOP', applying a pulled catalog row does NOT enqueue
-- it, so the shop never pushes HQ's own edits back up. HQ's captured rows ride
-- the same sync_outbox -> push path to the central store; shops then PULL them
-- from central and upsert by id (see src/main/sync/pull.ts).
--
-- SCOPE: catalog tables only — products, product_units, pricing_tiers,
-- promotions, suppliers. Deliberately excluded for now (see
-- docs/phase3-network-and-sync.md, B14 open questions):
--   * workers, customers, customer_price_overrides  (ownership undecided)
--   * locations, routes, route_customer_links        (shop/customer-scoped)
--   * code-keyed lookup tables                        (static, migration-seeded)
--
-- NOTE: catalog rows carry created_by/updated_by -> workers(id). They apply
-- cleanly on a shop only if that worker exists there (the migration-seeded
-- SYSTEM worker always does). Human-authored HQ edits need the worker-roster
-- ownership decision (B14) before they apply across shops.

CREATE TRIGGER trg_outbox_products_mins AFTER INSERT ON products
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('products', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_products_mupd AFTER UPDATE ON products
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('products', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_product_units_mins AFTER INSERT ON product_units
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('product_units', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_product_units_mupd AFTER UPDATE ON product_units
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('product_units', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_pricing_tiers_mins AFTER INSERT ON pricing_tiers
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('pricing_tiers', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_pricing_tiers_mupd AFTER UPDATE ON pricing_tiers
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('pricing_tiers', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_promotions_mins AFTER INSERT ON promotions
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('promotions', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_promotions_mupd AFTER UPDATE ON promotions
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('promotions', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_suppliers_mins AFTER INSERT ON suppliers
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('suppliers', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_suppliers_mupd AFTER UPDATE ON suppliers
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('suppliers', NEW.id, 'UPDATE');
END;
