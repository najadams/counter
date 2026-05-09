-- 0020_period_close.sql
-- Day-lock / period close.
--
-- Without a posted_at flag, the audit log captures the *who* of a backdated
-- edit but the system never refuses one. A period_close row says "this day
-- at this location is sealed; no more inserts/updates that touch this date."
--
-- Reopening a sealed day is OWNER-only and leaves an audit entry.
-- Service-level guards (voidSale, breakage, etc.) consult this table.

CREATE TABLE period_closes (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  business_date TEXT NOT NULL,                           -- YYYY-MM-DD
  sealed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sealed_by TEXT NOT NULL REFERENCES workers(id),
  reopened_at TEXT,                                      -- NULL = currently sealed
  reopened_by TEXT REFERENCES workers(id),
  reopened_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT NOT NULL,
  CHECK (
    (reopened_at IS NULL AND reopened_by IS NULL AND reopened_reason IS NULL)
    OR (reopened_at IS NOT NULL AND reopened_by IS NOT NULL AND reopened_reason IS NOT NULL)
  )
);

-- Only one currently-sealed row per (location, date). After a reopen the
-- old row stays for audit; a new seal creates a new row. The partial index
-- enforces uniqueness only on the *active* (non-reopened) closes.
CREATE UNIQUE INDEX idx_period_closes_active
  ON period_closes(location_id, business_date)
  WHERE reopened_at IS NULL;

CREATE INDEX idx_period_closes_lookup
  ON period_closes(location_id, business_date, sealed_at DESC);
