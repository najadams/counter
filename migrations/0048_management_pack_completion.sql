-- 0048_management_pack_completion.sql
-- Stable gain/loss accounts used by the guided fixed-asset disposal workflow.

PRAGMA foreign_keys = ON;

INSERT INTO ledger_accounts (
  id, location_id, code, name, account_class, account_subtype, normal_balance,
  created_by, updated_by, device_id
)
SELECT 'la-' || l.id || '-GAIN_ASSET_DISPOSAL', l.id, 'GAIN_ASSET_DISPOSAL',
       'Gain on asset disposal', 'REVENUE', 'ASSET_DISPOSAL', 'CREDIT',
       'sys-system', 'sys-system', 'migration-0048'
FROM locations l
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_accounts la
   WHERE la.location_id = l.id AND la.code = 'GAIN_ASSET_DISPOSAL'
);

INSERT INTO ledger_accounts (
  id, location_id, code, name, account_class, account_subtype, normal_balance,
  created_by, updated_by, device_id
)
SELECT 'la-' || l.id || '-LOSS_ASSET_DISPOSAL', l.id, 'LOSS_ASSET_DISPOSAL',
       'Loss on asset disposal', 'EXPENSE', 'ASSET_DISPOSAL', 'DEBIT',
       'sys-system', 'sys-system', 'migration-0048'
FROM locations l
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_accounts la
   WHERE la.location_id = l.id AND la.code = 'LOSS_ASSET_DISPOSAL'
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_source_drilldown
  ON journal_entries(location_id, source_type, source_id, business_date, status);
CREATE INDEX IF NOT EXISTS idx_journal_entries_business_drilldown
  ON journal_entries(location_id, business_date, status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_location_status
  ON fixed_assets(location_id, disposed_at, acquired_date);
CREATE INDEX IF NOT EXISTS idx_saved_scenarios_location_active
  ON saved_scenarios(location_id, active, name);
CREATE INDEX IF NOT EXISTS idx_risk_assumptions_location_active
  ON risk_assumptions(location_id, active, driver);

CREATE TABLE management_ledger_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id),
  shadow_enabled INTEGER NOT NULL DEFAULT 0 CHECK (shadow_enabled IN (0,1)),
  shadow_started_at TEXT,
  shadow_started_by TEXT REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
INSERT INTO management_ledger_settings (
  location_id, updated_by, device_id
)
SELECT id, 'sys-system', 'migration-0048' FROM locations;

CREATE TRIGGER trg_outbox_management_ledger_settings_ins
AFTER INSERT ON management_ledger_settings
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('management_ledger_settings', NEW.location_id, 'INSERT');
END;
CREATE TRIGGER trg_outbox_management_ledger_settings_upd
AFTER UPDATE ON management_ledger_settings
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('management_ledger_settings', NEW.location_id, 'UPDATE');
END;
