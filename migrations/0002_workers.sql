-- 0002_workers.sql
-- Workers + the SYSTEM bootstrap row that owns all migration/seed writes.
--
-- Pushback fix #4: terminated_at and deleted_at are DIFFERENT concerns.
--   terminated_at  = legitimate departure (preserves attribution forever)
--   deleted_at     = row created in error (e.g. duplicate)
-- A worker who quits gets terminated_at set; their historical sales/shifts
-- stay attributed. Never set deleted_at on a worker who actually existed.

PRAGMA foreign_keys = ON;

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL CHECK (phone GLOB '+233[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  role TEXT NOT NULL CHECK (role IN (
    'OWNER', 'FOUNDER', 'SUPERVISOR', 'COUNTER', 'DRIVER', 'STOCKMASTER', 'SYSTEM'
  )),
  pin_hash TEXT NOT NULL,                -- bcryptjs, 12 rounds (see PIN_BCRYPT_ROUNDS)
  base_salary_pesewas INTEGER NOT NULL DEFAULT 0,
  consumption_allowance_units INTEGER NOT NULL DEFAULT 8,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  hired_at TEXT NOT NULL,                -- 'YYYY-MM-DD'
  terminated_at TEXT,                    -- 'YYYY-MM-DD'
  termination_reason TEXT,
  notes TEXT,
  -- provenance (every business row has these six)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  -- soft delete (use only for created-in-error; use terminated_at for departures)
  deleted_at TEXT,
  deleted_by TEXT REFERENCES workers(id),
  deleted_reason TEXT,
  -- terminated_at requires a reason (if one is set, the other must be too)
  CHECK ((terminated_at IS NULL AND termination_reason IS NULL) OR
         (terminated_at IS NOT NULL AND termination_reason IS NOT NULL)),
  -- deleted_at requires a reason
  CHECK ((deleted_at IS NULL AND deleted_reason IS NULL AND deleted_by IS NULL) OR
         (deleted_at IS NOT NULL AND deleted_reason IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX idx_workers_active ON workers(active) WHERE deleted_at IS NULL;
CREATE INDEX idx_workers_role ON workers(role) WHERE active = 1 AND deleted_at IS NULL;

-- SYSTEM bootstrap row.
-- Self-references created_by/updated_by — SQLite checks the FK after the row
-- is materialised, so this single-statement INSERT resolves cleanly.
-- pin_hash is set to a sentinel that no real bcrypt output can match
-- (length is wrong); the auth service rejects logins for role = 'SYSTEM'.
INSERT INTO workers (
  id, full_name, phone, role, pin_hash,
  base_salary_pesewas, consumption_allowance_units, active,
  hired_at, created_by, updated_by, device_id
) VALUES (
  'sys-system',
  'SYSTEM',
  '+233000000000',
  'SYSTEM',
  '!SYSTEM_NO_LOGIN!',
  0, 0, 1,
  '2026-01-01',
  'sys-system', 'sys-system', 'bootstrap'
);
