-- Door-printer support: tag each queued reprint with the print station it
-- failed at ('counter' or 'door'), so a retry fires on the SAME printer rather
-- than the default. Existing rows predate multi-station printing and all
-- belong to the counter, so they backfill to 'counter'.
ALTER TABLE pending_receipt_reprints
  ADD COLUMN station_id TEXT NOT NULL DEFAULT 'counter';
