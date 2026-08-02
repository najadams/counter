-- 0047_owner_management_pack.sql
-- Management-accounting foundation: immutable double-entry journal,
-- configurable money-location accounts, exact inventory valuation,
-- obligations/assets, controlled cutover, and risk/scenario settings.
--
-- Existing operational rows remain untouched.  The ledger stays inactive
-- until an OWNER/FOUNDER posts a balanced cutover entry.

PRAGMA foreign_keys = ON;

CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_class TEXT NOT NULL CHECK (account_class IN (
    'ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE'
  )),
  account_subtype TEXT NOT NULL,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  system_managed INTEGER NOT NULL DEFAULT 1 CHECK (system_managed IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, code)
);
CREATE INDEX idx_ledger_accounts_class ON ledger_accounts(location_id, account_class, active);

-- Stable account codes make future company consolidation independent of
-- shop-specific display names.
INSERT INTO ledger_accounts (
  id, location_id, code, name, account_class, account_subtype, normal_balance,
  created_by, updated_by, device_id
)
SELECT
  'la-' || l.id || '-' || a.code, l.id, a.code, a.name, a.class, a.subtype, a.normal,
  'sys-system', 'sys-system', 'migration-0047'
FROM locations l
CROSS JOIN (
  SELECT 'AR' code, 'Customer receivables' name, 'ASSET' class, 'CURRENT_ASSET' subtype, 'DEBIT' normal
  UNION ALL SELECT 'INVENTORY', 'Inventory', 'ASSET', 'INVENTORY', 'DEBIT'
  UNION ALL SELECT 'DEPOSITS_PREPAIDS', 'Deposits and prepayments', 'ASSET', 'OTHER_ASSET', 'DEBIT'
  UNION ALL SELECT 'FIXED_ASSETS', 'Fixed assets', 'ASSET', 'FIXED_ASSET', 'DEBIT'
  UNION ALL SELECT 'ACCUM_DEPRECIATION', 'Accumulated depreciation', 'ASSET', 'CONTRA_ASSET', 'CREDIT'
  UNION ALL SELECT 'AP_TRADE', 'Supplier payables', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'
  UNION ALL SELECT 'AP_BILLS', 'Operating bills payable', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'
  UNION ALL SELECT 'TAX_PAYABLE', 'Tax payable', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'
  UNION ALL SELECT 'CUSTOMER_CREDITS', 'Customer credits and prepayments', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'
  UNION ALL SELECT 'LOANS_PAYABLE', 'Loans payable', 'LIABILITY', 'LOAN', 'CREDIT'
  UNION ALL SELECT 'OWNER_CAPITAL', 'Owner capital', 'EQUITY', 'CAPITAL', 'CREDIT'
  UNION ALL SELECT 'RETAINED_EARNINGS', 'Retained earnings', 'EQUITY', 'RETAINED_EARNINGS', 'CREDIT'
  UNION ALL SELECT 'OWNER_DRAWINGS', 'Owner drawings', 'EQUITY', 'CONTRA_EQUITY', 'DEBIT'
  UNION ALL SELECT 'OPENING_EQUITY', 'Opening balance equity', 'EQUITY', 'OPENING_BALANCE', 'CREDIT'
  UNION ALL SELECT 'SALES_NET', 'Net sales', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT'
  UNION ALL SELECT 'DELIVERY_INCOME', 'Delivery income', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT'
  UNION ALL SELECT 'OTHER_INCOME', 'Other income', 'REVENUE', 'OTHER_INCOME', 'CREDIT'
  UNION ALL SELECT 'INVENTORY_GAIN', 'Inventory gain', 'REVENUE', 'INVENTORY_GAIN', 'CREDIT'
  UNION ALL SELECT 'COGS', 'Cost of goods sold', 'COGS', 'COGS', 'DEBIT'
  UNION ALL SELECT 'EXP_RENT', 'Rent expense', 'EXPENSE', 'RENT', 'DEBIT'
  UNION ALL SELECT 'EXP_UTILITIES', 'Utilities expense', 'EXPENSE', 'UTILITIES', 'DEBIT'
  UNION ALL SELECT 'EXP_TRANSPORT', 'Transport expense', 'EXPENSE', 'TRANSPORT', 'DEBIT'
  UNION ALL SELECT 'EXP_SUPPLIES', 'Supplies expense', 'EXPENSE', 'SUPPLIES', 'DEBIT'
  UNION ALL SELECT 'EXP_COMMS', 'Communications expense', 'EXPENSE', 'COMMS', 'DEBIT'
  UNION ALL SELECT 'EXP_REPAIRS', 'Repairs expense', 'EXPENSE', 'REPAIRS', 'DEBIT'
  UNION ALL SELECT 'EXP_BANK_FEES', 'Bank fees', 'EXPENSE', 'BANK_FEES', 'DEBIT'
  UNION ALL SELECT 'EXP_STAFF_WAGES', 'Staff wages', 'EXPENSE', 'STAFF_WAGES', 'DEBIT'
  UNION ALL SELECT 'EXP_STAFF_ADVANCE', 'Staff advances', 'EXPENSE', 'STAFF_ADVANCE', 'DEBIT'
  UNION ALL SELECT 'EXP_COMMISSION', 'Commission expense', 'EXPENSE', 'COMMISSION', 'DEBIT'
  UNION ALL SELECT 'EXP_STAFF_WELFARE', 'Staff welfare', 'EXPENSE', 'STAFF_WELFARE', 'DEBIT'
  UNION ALL SELECT 'EXP_OTHER', 'Other operating expense', 'EXPENSE', 'OTHER', 'DEBIT'
  UNION ALL SELECT 'LOSS_BREAKAGE', 'Breakage loss', 'EXPENSE', 'INVENTORY_LOSS', 'DEBIT'
  UNION ALL SELECT 'LOSS_EXPIRY', 'Expiry loss', 'EXPENSE', 'INVENTORY_LOSS', 'DEBIT'
  UNION ALL SELECT 'LOSS_THEFT', 'Theft loss', 'EXPENSE', 'INVENTORY_LOSS', 'DEBIT'
  UNION ALL SELECT 'LOSS_SHRINKAGE', 'Stocktake shrinkage', 'EXPENSE', 'INVENTORY_LOSS', 'DEBIT'
  UNION ALL SELECT 'LOSS_CONSUMPTION', 'Staff consumption', 'EXPENSE', 'INVENTORY_LOSS', 'DEBIT'
  UNION ALL SELECT 'BAD_DEBT', 'Bad debt expense', 'EXPENSE', 'BAD_DEBT', 'DEBIT'
  UNION ALL SELECT 'INTEREST_EXPENSE', 'Interest expense', 'EXPENSE', 'FINANCE_COST', 'DEBIT'
  UNION ALL SELECT 'DEPRECIATION_EXPENSE', 'Depreciation expense', 'EXPENSE', 'DEPRECIATION', 'DEBIT'
  UNION ALL SELECT 'INCOME_TAX_EXPENSE', 'Income tax expense', 'EXPENSE', 'INCOME_TAX', 'DEBIT'
  UNION ALL SELECT 'CASH_OVER_SHORT', 'Cash over or short', 'EXPENSE', 'CASH_VARIANCE', 'DEBIT'
) a;

CREATE TABLE financial_accounts (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  ledger_account_id TEXT NOT NULL UNIQUE REFERENCES ledger_accounts(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('TILL','SAFE','BANK','MOMO','OTHER_CASH')),
  provider TEXT,
  masked_identifier TEXT,
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, name)
);
CREATE INDEX idx_financial_accounts_kind ON financial_accounts(location_id, kind, active);

-- Practical defaults; the owner confirms/renames these during cutover.
INSERT INTO ledger_accounts (
  id, location_id, code, name, account_class, account_subtype, normal_balance,
  created_by, updated_by, device_id
)
SELECT 'la-' || l.id || '-' || x.code, l.id, x.code, x.name, 'ASSET', 'CASH', 'DEBIT',
       'sys-system', 'sys-system', 'migration-0047'
FROM locations l
CROSS JOIN (
  SELECT 'CASH_TILL_DEFAULT' code, 'Counter till' name
  UNION ALL SELECT 'CASH_SAFE_DEFAULT', 'Shop safe'
  UNION ALL SELECT 'CASH_BANK_DEFAULT', 'Primary bank'
  UNION ALL SELECT 'CASH_MOMO_MTN', 'MTN MoMo'
  UNION ALL SELECT 'CASH_MOMO_TELECEL', 'Telecel Cash'
  UNION ALL SELECT 'CASH_MOMO_AT', 'AT Money'
) x;

INSERT INTO financial_accounts (
  id, location_id, ledger_account_id, name, kind, provider,
  created_by, updated_by, device_id
)
SELECT 'fa-' || l.id || '-' || x.suffix, l.id, 'la-' || l.id || '-' || x.code,
       x.name, x.kind, x.provider, 'sys-system', 'sys-system', 'migration-0047'
FROM locations l
CROSS JOIN (
  SELECT 'till' suffix, 'CASH_TILL_DEFAULT' code, 'Counter till' name, 'TILL' kind, NULL provider
  UNION ALL SELECT 'safe', 'CASH_SAFE_DEFAULT', 'Shop safe', 'SAFE', NULL
  UNION ALL SELECT 'bank', 'CASH_BANK_DEFAULT', 'Primary bank', 'BANK', NULL
  UNION ALL SELECT 'mtn', 'CASH_MOMO_MTN', 'MTN MoMo', 'MOMO', 'MTN'
  UNION ALL SELECT 'telecel', 'CASH_MOMO_TELECEL', 'Telecel Cash', 'MOMO', 'TELECEL'
  UNION ALL SELECT 'at', 'CASH_MOMO_AT', 'AT Money', 'MOMO', 'AT'
) x;

CREATE TABLE payment_account_mappings (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, payment_method, direction)
);
INSERT INTO payment_account_mappings (
  id, location_id, payment_method, direction, financial_account_id,
  created_by, updated_by, device_id
)
SELECT 'pam-' || l.id || '-' || pm.code || '-' || d.direction,
       l.id, pm.code, d.direction,
       CASE pm.code
         WHEN 'CASH' THEN 'fa-' || l.id || '-till'
         WHEN 'MOMO_MTN' THEN 'fa-' || l.id || '-mtn'
         WHEN 'MOMO_VODAFONE' THEN 'fa-' || l.id || '-telecel'
         WHEN 'MOMO_AIRTELTIGO' THEN 'fa-' || l.id || '-at'
         ELSE 'fa-' || l.id || '-bank'
       END,
       'sys-system', 'sys-system', 'migration-0047'
FROM locations l
JOIN payment_methods pm ON pm.code IN (
  'CASH','MOMO_MTN','MOMO_VODAFONE','MOMO_AIRTELTIGO','BANK_TRANSFER'
)
CROSS JOIN (SELECT 'IN' direction UNION ALL SELECT 'OUT') d;

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  business_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  posting_type TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','VOID')),
  reversal_of_id TEXT REFERENCES journal_entries(id),
  reversed_by_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, source_type, source_id, posting_type)
);
CREATE INDEX idx_journal_entries_period ON journal_entries(location_id, business_date, status);
CREATE INDEX idx_journal_entries_source ON journal_entries(source_type, source_id);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  debit_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (debit_pesewas >= 0),
  credit_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (credit_pesewas >= 0),
  memo TEXT,
  counterparty_type TEXT,
  counterparty_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (
    (debit_pesewas > 0 AND credit_pesewas = 0)
    OR (credit_pesewas > 0 AND debit_pesewas = 0)
  )
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(ledger_account_id, journal_entry_id);

CREATE TRIGGER trg_journal_entries_immutable_update
BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable');
END;
CREATE TRIGGER trg_journal_entries_immutable_delete
BEFORE DELETE ON journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries cannot be deleted');
END;
CREATE TRIGGER trg_journal_lines_immutable_update
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal lines are immutable');
END;
CREATE TRIGGER trg_journal_lines_immutable_delete
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal lines cannot be deleted');
END;

CREATE TABLE financial_cutovers (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL UNIQUE REFERENCES locations(id),
  cutover_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE')),
  opening_journal_entry_id TEXT REFERENCES journal_entries(id),
  activated_at TEXT,
  activated_by TEXT REFERENCES workers(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE account_transfers (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  from_financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  to_financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  occurred_at TEXT NOT NULL,
  reference TEXT,
  notes TEXT,
  journal_entry_id TEXT UNIQUE REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (from_financial_account_id != to_financial_account_id)
);

CREATE TABLE account_reconciliations (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  reconciled_at TEXT NOT NULL,
  expected_pesewas INTEGER NOT NULL,
  observed_pesewas INTEGER NOT NULL CHECK (observed_pesewas >= 0),
  variance_pesewas INTEGER NOT NULL,
  reference TEXT,
  evidence_url TEXT,
  notes TEXT,
  adjustment_journal_entry_id TEXT REFERENCES journal_entries(id),
  approved_by TEXT NOT NULL REFERENCES workers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (variance_pesewas = observed_pesewas - expected_pesewas)
);
CREATE INDEX idx_account_reconciliations_account
  ON account_reconciliations(financial_account_id, reconciled_at DESC);

CREATE TABLE inventory_valuation_movements (
  id TEXT PRIMARY KEY,
  stock_movement_id TEXT UNIQUE REFERENCES stock_movements(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity_delta INTEGER NOT NULL,
  value_delta_pesewas INTEGER NOT NULL,
  balance_quantity INTEGER NOT NULL,
  balance_value_pesewas INTEGER NOT NULL,
  average_unit_cost_pesewas INTEGER NOT NULL CHECK (average_unit_cost_pesewas >= 0),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (quantity_delta != 0),
  CHECK (balance_quantity >= 0),
  CHECK (balance_value_pesewas >= 0)
);
CREATE INDEX idx_inventory_valuation_product
  ON inventory_valuation_movements(product_id, location_id, occurred_at, id);

ALTER TABLE sale_lines ADD COLUMN line_cogs_pesewas INTEGER NOT NULL DEFAULT 0
  CHECK (line_cogs_pesewas >= 0);
UPDATE sale_lines SET line_cogs_pesewas = unit_cost_pesewas * quantity
 WHERE line_cogs_pesewas = 0;

ALTER TABLE shifts ADD COLUMN financial_account_id TEXT REFERENCES financial_accounts(id);
ALTER TABLE customer_payments ADD COLUMN financial_account_id TEXT REFERENCES financial_accounts(id);
ALTER TABLE supplier_payments ADD COLUMN financial_account_id TEXT REFERENCES financial_accounts(id);
ALTER TABLE tax_payments ADD COLUMN financial_account_id TEXT REFERENCES financial_accounts(id);
CREATE UNIQUE INDEX idx_open_shift_financial_account
  ON shifts(financial_account_id)
  WHERE closed_at IS NULL AND financial_account_id IS NOT NULL;

CREATE TABLE business_expenses (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  category TEXT NOT NULL CHECK (category IN (
    'RENT','UTILITIES','TRANSPORT','SUPPLIES','COMMS','REPAIRS','BANK_FEES',
    'STAFF_WAGES','STAFF_ADVANCE','COMMISSION','STAFF_WELFARE','OTHER',
    'INTEREST','DEPRECIATION','INCOME_TAX'
  )),
  payee TEXT,
  incurred_date TEXT NOT NULL,
  due_date TEXT,
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('UNPAID','PARTIALLY_PAID','PAID','VOID')),
  total_paid_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (total_paid_pesewas >= 0),
  fixed_or_variable TEXT NOT NULL DEFAULT 'VARIABLE' CHECK (fixed_or_variable IN ('FIXED','VARIABLE')),
  photo_url TEXT,
  notes TEXT,
  legacy_expense_id TEXT UNIQUE REFERENCES petty_cash_expenses(id),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (due_date IS NULL OR due_date >= incurred_date),
  CHECK (total_paid_pesewas <= amount_pesewas)
);
CREATE INDEX idx_business_expenses_period ON business_expenses(location_id, incurred_date, category);

CREATE TABLE expense_payments (
  id TEXT PRIMARY KEY,
  business_expense_id TEXT NOT NULL REFERENCES business_expenses(id),
  financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
  paid_at TEXT NOT NULL,
  payment_reference TEXT,
  notes TEXT,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX idx_expense_payments_expense ON expense_payments(business_expense_id, paid_at);

CREATE TABLE liability_agreements (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('BANK_LOAN','OWNER_LOAN','LEASE','OTHER')),
  creditor_name TEXT NOT NULL,
  original_principal_pesewas INTEGER NOT NULL CHECK (original_principal_pesewas > 0),
  received_financial_account_id TEXT REFERENCES financial_accounts(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SETTLED','VOID')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE obligations (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  obligation_type TEXT NOT NULL CHECK (obligation_type IN (
    'SUPPLIER_INVOICE','OPERATING_BILL','TAX','LOAN_INSTALLMENT','OWNER_LOAN_INSTALLMENT','OTHER'
  )),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  creditor_name TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  principal_pesewas INTEGER NOT NULL CHECK (principal_pesewas >= 0),
  interest_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (interest_pesewas >= 0),
  total_paid_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (total_paid_pesewas >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','PARTIALLY_PAID','PAID','DISPUTED','VOID'
  )),
  liability_agreement_id TEXT REFERENCES liability_agreements(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, source_type, source_id),
  CHECK (total_paid_pesewas <= principal_pesewas + interest_pesewas)
);
CREATE INDEX idx_obligations_due ON obligations(location_id, status, due_date);

CREATE TABLE obligation_allocations (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  payment_source_type TEXT NOT NULL,
  payment_source_id TEXT NOT NULL,
  financial_account_id TEXT REFERENCES financial_accounts(id),
  principal_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (principal_pesewas >= 0),
  interest_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (interest_pesewas >= 0),
  paid_at TEXT NOT NULL,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (principal_pesewas + interest_pesewas > 0),
  UNIQUE (obligation_id, payment_source_type, payment_source_id)
);

CREATE TABLE fixed_assets (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  acquired_date TEXT NOT NULL,
  cost_pesewas INTEGER NOT NULL CHECK (cost_pesewas > 0),
  residual_value_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (residual_value_pesewas >= 0),
  useful_life_months INTEGER CHECK (useful_life_months IS NULL OR useful_life_months > 0),
  accumulated_depreciation_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_depreciation_pesewas >= 0),
  disposed_at TEXT,
  disposal_proceeds_pesewas INTEGER,
  source_financial_account_id TEXT REFERENCES financial_accounts(id),
  notes TEXT,
  acquisition_journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  CHECK (residual_value_pesewas <= cost_pesewas),
  CHECK (accumulated_depreciation_pesewas <= cost_pesewas - residual_value_pesewas)
);

CREATE TABLE risk_thresholds (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  dimension TEXT NOT NULL CHECK (dimension IN ('CUSTOMER','PRODUCT','SUPPLIER','CATEGORY','PAYMENT_RAIL')),
  warning_bps INTEGER NOT NULL CHECK (warning_bps BETWEEN 0 AND 10000),
  danger_bps INTEGER NOT NULL CHECK (danger_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, dimension),
  CHECK (danger_bps >= warning_bps)
);
INSERT INTO risk_thresholds (
  id, location_id, dimension, warning_bps, danger_bps,
  created_by, updated_by, device_id
)
SELECT 'rt-' || l.id || '-' || x.dimension, l.id, x.dimension, x.warning, x.danger,
       'sys-system', 'sys-system', 'migration-0047'
FROM locations l
CROSS JOIN (
  SELECT 'CUSTOMER' dimension, 2000 warning, 3500 danger
  UNION ALL SELECT 'PRODUCT', 2500, 4000
  UNION ALL SELECT 'SUPPLIER', 4000, 6000
  UNION ALL SELECT 'CATEGORY', 5000, 7000
  UNION ALL SELECT 'PAYMENT_RAIL', 7000, 8500
) x;

CREATE TABLE risk_assumptions (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  driver TEXT NOT NULL,
  baseline_bps INTEGER NOT NULL DEFAULT 0,
  downside_bps INTEGER NOT NULL DEFAULT 0,
  rationale TEXT,
  owner_worker_id TEXT REFERENCES workers(id),
  review_date TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE saved_scenarios (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK (horizon_days IN (30,90,180)),
  drivers_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (location_id, name)
);

-- Shop -> central capture.  The central ingest table is generic JSON, so no
-- central schema migration is required for these rows.
CREATE TRIGGER trg_outbox_ledger_accounts_ins AFTER INSERT ON ledger_accounts
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('ledger_accounts', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_ledger_accounts_upd AFTER UPDATE ON ledger_accounts
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('ledger_accounts', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_financial_accounts_ins AFTER INSERT ON financial_accounts
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('financial_accounts', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_financial_accounts_upd AFTER UPDATE ON financial_accounts
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('financial_accounts', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_payment_account_mappings_ins AFTER INSERT ON payment_account_mappings
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('payment_account_mappings', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_payment_account_mappings_upd AFTER UPDATE ON payment_account_mappings
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('payment_account_mappings', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_journal_entries_ins AFTER INSERT ON journal_entries
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('journal_entries', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_journal_entries_upd AFTER UPDATE ON journal_entries
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('journal_entries', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_journal_lines_ins AFTER INSERT ON journal_lines
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('journal_lines', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_financial_cutovers_ins AFTER INSERT ON financial_cutovers
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('financial_cutovers', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_financial_cutovers_upd AFTER UPDATE ON financial_cutovers
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('financial_cutovers', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_account_transfers_ins AFTER INSERT ON account_transfers
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('account_transfers', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_account_reconciliations_ins AFTER INSERT ON account_reconciliations
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('account_reconciliations', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_inventory_valuation_movements_ins AFTER INSERT ON inventory_valuation_movements
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('inventory_valuation_movements', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_business_expenses_ins AFTER INSERT ON business_expenses
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('business_expenses', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_business_expenses_upd AFTER UPDATE ON business_expenses
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('business_expenses', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_expense_payments_ins AFTER INSERT ON expense_payments
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('expense_payments', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_liability_agreements_ins AFTER INSERT ON liability_agreements
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('liability_agreements', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_liability_agreements_upd AFTER UPDATE ON liability_agreements
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('liability_agreements', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_obligations_ins AFTER INSERT ON obligations
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('obligations', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_obligations_upd AFTER UPDATE ON obligations
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('obligations', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_obligation_allocations_ins AFTER INSERT ON obligation_allocations
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('obligation_allocations', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_fixed_assets_ins AFTER INSERT ON fixed_assets
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('fixed_assets', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_fixed_assets_upd AFTER UPDATE ON fixed_assets
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('fixed_assets', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_risk_thresholds_ins AFTER INSERT ON risk_thresholds
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('risk_thresholds', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_risk_thresholds_upd AFTER UPDATE ON risk_thresholds
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('risk_thresholds', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_risk_assumptions_ins AFTER INSERT ON risk_assumptions
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('risk_assumptions', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_risk_assumptions_upd AFTER UPDATE ON risk_assumptions
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('risk_assumptions', NEW.id, 'UPDATE'); END;
CREATE TRIGGER trg_outbox_saved_scenarios_ins AFTER INSERT ON saved_scenarios
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('saved_scenarios', NEW.id, 'INSERT'); END;
CREATE TRIGGER trg_outbox_saved_scenarios_upd AFTER UPDATE ON saved_scenarios
BEGIN INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('saved_scenarios', NEW.id, 'UPDATE'); END;
