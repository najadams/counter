-- 0034_sync_workers_capture.sql
-- Phase 3c follow-up: the worker roster is HQ-owned and flows DOWN to shops.
--
-- Decision (see docs/phase3-network-and-sync.md, B14): rather than rewrite
-- catalog attribution to SYSTEM, we sync the roster itself. That way an
-- HQ-authored catalog row's created_by/updated_by -> workers(id) resolves on
-- every shop, because the referenced HQ worker has been pulled down first
-- (the global pull cursor preserves HQ's causal order: a worker is authored
-- before the catalog rows that reference it).
--
-- Capture is HQ-gated, exactly like the catalog tables (migration 0033): these
-- triggers fire only when device_config.sync_role = 'HQ', so a shop applying a
-- pulled worker never re-enqueues it. Shop-local workers (e.g. the first-run
-- OWNER) are not captured and stay local; the roster sync is additive (upsert
-- by id), so it never deletes a shop's own accounts.

CREATE TRIGGER trg_outbox_workers_mins AFTER INSERT ON workers
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('workers', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_workers_mupd AFTER UPDATE ON workers
WHEN (SELECT value FROM device_config WHERE key = 'sync_role') = 'HQ'
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('workers', NEW.id, 'UPDATE');
END;
