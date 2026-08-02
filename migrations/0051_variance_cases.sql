-- 0051_variance_cases.sql
-- Investigation workflow for material reconciliation differences. Source
-- records remain the accounting truth; a case records ownership, evidence,
-- cause and resolution without rewriting that truth.

PRAGMA foreign_keys = ON;

CREATE TABLE variance_case_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id),
  till_amount_threshold_pesewas INTEGER NOT NULL DEFAULT 1000
    CHECK (till_amount_threshold_pesewas >= 0),
  till_threshold_bps INTEGER NOT NULL DEFAULT 50
    CHECK (till_threshold_bps BETWEEN 0 AND 10000),
  stock_amount_threshold_pesewas INTEGER NOT NULL DEFAULT 5000
    CHECK (stock_amount_threshold_pesewas >= 0),
  stock_threshold_bps INTEGER NOT NULL DEFAULT 100
    CHECK (stock_threshold_bps BETWEEN 0 AND 10000),
  due_days INTEGER NOT NULL DEFAULT 3 CHECK (due_days BETWEEN 1 AND 90),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL
);

INSERT INTO variance_case_settings (
  location_id, created_by, updated_by, device_id
)
SELECT id, 'sys-system', 'sys-system', 'migration-0051' FROM locations;

CREATE TABLE variance_cases (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  case_type TEXT NOT NULL CHECK (case_type IN (
    'TILL_CASH','FINANCIAL_ACCOUNT','STOCK_SHORTAGE','STOCK_FOUND',
    'CUSTOMER_BALANCE','MANUAL'
  )),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','INVESTIGATING','AWAITING_EVIDENCE','RESOLVED','WRITTEN_OFF'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('WARNING','DANGER')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 160),
  detected_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  amount_pesewas INTEGER NOT NULL,
  expected_pesewas INTEGER,
  observed_pesewas INTEGER,
  threshold_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (threshold_pesewas >= 0),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  subject_worker_id TEXT REFERENCES workers(id),
  financial_account_id TEXT REFERENCES financial_accounts(id),
  stocktake_event_id TEXT REFERENCES stocktake_events(id),
  customer_id TEXT REFERENCES customers(id),
  assigned_to TEXT REFERENCES workers(id),
  cause_code TEXT CHECK (cause_code IS NULL OR cause_code IN (
    'WRONG_CHANGE','MISSED_SALE','WRONG_PAYMENT_RAIL','UNRECORDED_EXPENSE',
    'UNRECORDED_CASH_DROP','COUNTING_ERROR','BREAKAGE','EXPIRY','THEFT',
    'BANK_MOMO_TIMING','CUSTOMER_ALLOCATION','SYSTEM_DATA_ERROR','OTHER'
  )),
  root_cause_notes TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES workers(id),
  adjustment_journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  UNIQUE (case_type, source_type, source_id),
  CHECK (
    (status IN ('OPEN','INVESTIGATING','AWAITING_EVIDENCE')
      AND resolved_at IS NULL AND resolved_by IS NULL)
    OR
    (status IN ('RESOLVED','WRITTEN_OFF')
      AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND cause_code IS NOT NULL
      AND length(trim(COALESCE(resolution_note, ''))) >= 3)
  )
);
CREATE INDEX idx_variance_cases_queue
  ON variance_cases(location_id, status, due_at, detected_at DESC);
CREATE INDEX idx_variance_cases_assignee
  ON variance_cases(assigned_to, status, due_at);
CREATE INDEX idx_variance_cases_subject_worker
  ON variance_cases(subject_worker_id, status, detected_at DESC);
CREATE INDEX idx_variance_cases_account
  ON variance_cases(financial_account_id, status, detected_at DESC);
CREATE INDEX idx_variance_cases_customer
  ON variance_cases(customer_id, status, detected_at DESC);

CREATE TABLE variance_case_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES variance_cases(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'OPENED','STATUS_CHANGED','ASSIGNED','NOTE_ADDED','EVIDENCE_ADDED',
    'CAUSE_SET','RESOLVED','WRITTEN_OFF','REOPENED'
  )),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  cause_code TEXT,
  evidence_reference TEXT,
  evidence_url TEXT,
  actor_worker_id TEXT NOT NULL REFERENCES workers(id),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT NOT NULL
);
CREATE INDEX idx_variance_case_events_timeline
  ON variance_case_events(case_id, occurred_at, id);

CREATE TRIGGER trg_variance_cases_identity_immutable
BEFORE UPDATE ON variance_cases
WHEN NEW.id <> OLD.id
  OR NEW.location_id <> OLD.location_id
  OR NEW.case_type <> OLD.case_type
  OR NEW.detected_at <> OLD.detected_at
  OR NEW.amount_pesewas <> OLD.amount_pesewas
  OR COALESCE(NEW.expected_pesewas, -1) <> COALESCE(OLD.expected_pesewas, -1)
  OR COALESCE(NEW.observed_pesewas, -1) <> COALESCE(OLD.observed_pesewas, -1)
  OR NEW.threshold_pesewas <> OLD.threshold_pesewas
  OR NEW.source_type <> OLD.source_type
  OR NEW.source_id <> OLD.source_id
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
  OR NEW.device_id <> OLD.device_id
BEGIN
  SELECT RAISE(ABORT, 'variance case source facts are immutable');
END;

CREATE TRIGGER trg_variance_cases_no_delete
BEFORE DELETE ON variance_cases
BEGIN
  SELECT RAISE(ABORT, 'variance cases cannot be deleted');
END;

CREATE TRIGGER trg_variance_case_events_no_update
BEFORE UPDATE ON variance_case_events
BEGIN
  SELECT RAISE(ABORT, 'variance case events are append-only');
END;

CREATE TRIGGER trg_variance_case_events_no_delete
BEFORE DELETE ON variance_case_events
BEGIN
  SELECT RAISE(ABORT, 'variance case events cannot be deleted');
END;

CREATE TRIGGER trg_outbox_variance_case_settings_ins
AFTER INSERT ON variance_case_settings
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('variance_case_settings', NEW.location_id, 'INSERT');
END;
CREATE TRIGGER trg_outbox_variance_case_settings_upd
AFTER UPDATE ON variance_case_settings
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('variance_case_settings', NEW.location_id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_variance_cases_ins
AFTER INSERT ON variance_cases
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('variance_cases', NEW.id, 'INSERT');
END;
CREATE TRIGGER trg_outbox_variance_cases_upd
AFTER UPDATE ON variance_cases
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('variance_cases', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_variance_case_events_ins
AFTER INSERT ON variance_case_events
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('variance_case_events', NEW.id, 'INSERT');
END;

-- Bootstrap settings are fixed defaults rather than user activity.
DELETE FROM sync_outbox
 WHERE acked_at IS NULL
   AND table_name = 'variance_case_settings'
   AND op = 'INSERT'
   AND row_pk IN (SELECT location_id FROM variance_case_settings WHERE device_id = 'migration-0051');
