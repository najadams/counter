-- 0011_auth_and_shift.sql
-- pin_attempts: per-(worker, device) PIN failure tracker for rate-limiting.
-- Reset to 0 on success. Locked when count >= PIN_MAX_ATTEMPTS, until
-- locked_until is in the past.
--
-- One open shift per worker is enforced at the application layer (we check
-- before INSERT). A unique partial index also enforces it at the DB level
-- as a safety net.

PRAGMA foreign_keys = ON;

CREATE TABLE pin_attempts (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(worker_id, device_id)
);
CREATE INDEX idx_pin_attempts_worker_device ON pin_attempts(worker_id, device_id);
CREATE INDEX idx_pin_attempts_locked ON pin_attempts(locked_until)
  WHERE locked_until IS NOT NULL;

-- Belt and suspenders: at most one open shift per worker.
-- A worker with shift A still open cannot have shift B open simultaneously.
CREATE UNIQUE INDEX idx_shifts_one_open_per_worker
  ON shifts(worker_id) WHERE closed_at IS NULL;
