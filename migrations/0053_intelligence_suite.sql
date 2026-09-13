-- 0053_intelligence_suite.sql
-- Explainable, advisory decision queue. Source transactions remain the truth;
-- intelligence rows only describe conditions and record the human response.

PRAGMA foreign_keys = ON;

-- Ship the exact, deterministic controls first. Predictive and HQ evaluators
-- are present but remain a deliberate promotion/rollback setting.
INSERT OR IGNORE INTO device_config (key, value) VALUES ('intelligence_stage', 'FOUNDATION');

CREATE TABLE intelligence_items (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  episode INTEGER NOT NULL DEFAULT 1 CHECK (episode > 0),
  location_id TEXT NOT NULL REFERENCES locations(id),
  scope TEXT NOT NULL DEFAULT 'LOCAL' CHECK (scope IN ('LOCAL','COMPANY')),
  source_shop_id TEXT,
  model_key TEXT NOT NULL,
  model_version TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'CONTROL','INVENTORY','CREDIT','PRICING','CASH','CUSTOMER','CONCENTRATION'
  )),
  audience TEXT NOT NULL CHECK (audience IN ('SUPERVISOR','OWNER')),
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED','RESOLVED','DISMISSED','EXPIRED'
  )),
  control_override INTEGER NOT NULL DEFAULT 0 CHECK (control_override IN (0,1)),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 180),
  recommendation TEXT NOT NULL CHECK (length(trim(recommendation)) BETWEEN 3 AND 600),
  cedi_impact_pesewas INTEGER CHECK (cedi_impact_pesewas IS NULL OR cedi_impact_pesewas >= 0),
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  due_at TEXT,
  valid_until TEXT,
  source_data_through TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  rationale_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rationale_json)),
  source_entity_type TEXT,
  source_entity_id TEXT,
  assigned_to TEXT REFERENCES workers(id),
  snoozed_until TEXT,
  resolution_note TEXT,
  dismissal_reason TEXT,
  condition_cleared_at TEXT,
  detected_at TEXT NOT NULL,
  last_evaluated_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK ((status = 'SNOOZED' AND snoozed_until IS NOT NULL) OR status <> 'SNOOZED'),
  CHECK ((status = 'RESOLVED' AND length(trim(COALESCE(resolution_note, ''))) >= 3) OR status <> 'RESOLVED'),
  CHECK ((status = 'DISMISSED' AND length(trim(COALESCE(dismissal_reason, ''))) >= 3) OR status <> 'DISMISSED')
);

CREATE UNIQUE INDEX idx_intelligence_active_fingerprint
  ON intelligence_items(location_id, scope, fingerprint)
  WHERE status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED');
CREATE INDEX idx_intelligence_queue
  ON intelligence_items(location_id, audience, status, control_override DESC, severity, due_at, detected_at DESC);
CREATE INDEX idx_intelligence_assignee
  ON intelligence_items(assigned_to, status, due_at);
CREATE INDEX idx_intelligence_source
  ON intelligence_items(source_entity_type, source_entity_id);

CREATE TABLE intelligence_item_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES intelligence_items(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'GENERATED','UPDATED','ACKNOWLEDGED','ASSIGNED','SNOOZED','DISMISSED',
    'RESOLVED','AUTO_RESOLVED','EXPIRED','REOPENED'
  )),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  actor_worker_id TEXT NOT NULL REFERENCES workers(id),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT NOT NULL
);
CREATE INDEX idx_intelligence_events_timeline
  ON intelligence_item_events(item_id, occurred_at, id);

CREATE TABLE intelligence_runs (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  model_family TEXT NOT NULL,
  model_version TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('BOOT','LOGIN','DAILY','EVENT','MANUAL','HQ_PULL')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_data_through TEXT,
  generated_count INTEGER NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  resolved_count INTEGER NOT NULL DEFAULT 0 CHECK (resolved_count >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error TEXT,
  device_id TEXT NOT NULL
);
CREATE INDEX idx_intelligence_runs_latest
  ON intelligence_runs(location_id, model_family, started_at DESC);

CREATE TRIGGER trg_intelligence_events_no_update
BEFORE UPDATE ON intelligence_item_events
BEGIN SELECT RAISE(ABORT, 'intelligence events are append-only'); END;
CREATE TRIGGER trg_intelligence_events_no_delete
BEFORE DELETE ON intelligence_item_events
BEGIN SELECT RAISE(ABORT, 'intelligence events cannot be deleted'); END;

CREATE TRIGGER trg_outbox_intelligence_items_ins
AFTER INSERT ON intelligence_items
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('intelligence_items', NEW.id, 'INSERT');
END;
CREATE TRIGGER trg_outbox_intelligence_items_upd
AFTER UPDATE ON intelligence_items
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('intelligence_items', NEW.id, 'UPDATE');
END;
CREATE TRIGGER trg_outbox_intelligence_item_events_ins
AFTER INSERT ON intelligence_item_events
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('intelligence_item_events', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_daily_summaries_upd
AFTER UPDATE ON daily_summaries
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('daily_summaries', NEW.id, 'UPDATE');
END;
