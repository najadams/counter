-- 0001_lookup_tables.sql
-- Closed-vocabulary lookup tables and their seed data.
-- Every status, type, and reason field in the rest of the schema FKs into one
-- of these. No free-text categorization anywhere.

PRAGMA foreign_keys = ON;

-- reason_codes ---------------------------------------------------------------
-- Why every stock movement happens. The category column auto-signs the
-- quantity in insertStockMovement(): inflow positive, outflow negative,
-- neutral zero-net.
CREATE TABLE reason_codes (
  code TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('inflow', 'outflow', 'neutral')),
  description TEXT NOT NULL,
  affects_cash INTEGER NOT NULL CHECK (affects_cash IN (0, 1)),
  requires_photo INTEGER NOT NULL DEFAULT 0 CHECK (requires_photo IN (0, 1)),
  requires_supervisor INTEGER NOT NULL DEFAULT 0 CHECK (requires_supervisor IN (0, 1)),
  display_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

INSERT INTO reason_codes (code, category, description, affects_cash, requires_photo, requires_supervisor, display_order) VALUES
  ('RECEIVED_FROM_SUPPLIER',     'inflow',  'Goods received from supplier',                0, 0, 1, 10),
  ('RETURN_FROM_CUSTOMER',       'inflow',  'Customer returned goods',                     0, 0, 0, 20),
  ('RETURN_FROM_ROUTE',          'inflow',  'Stock returned from delivery route unsold',   0, 0, 0, 30),
  ('OPENING_STOCK',              'inflow',  'Initial stocktake entry',                     0, 0, 1, 40),
  ('STOCK_FOUND',                'inflow',  'Stocktake adjustment, stock found',           0, 0, 1, 50),
  ('SALE_WALK_IN',               'outflow', 'Sale at counter',                             1, 0, 0, 100),
  ('SALE_ROUTE',                 'outflow', 'Sale on delivery route',                      1, 0, 0, 110),
  ('SALE_CREDIT',                'outflow', 'Sale on customer credit',                     0, 0, 0, 120),
  ('BREAKAGE',                   'outflow', 'Bottle/item broken',                          0, 1, 0, 200),
  ('WORKER_CONSUMED_FREE',       'outflow', 'Worker drank within allowance',               0, 0, 0, 210),
  ('WORKER_CONSUMED_PAID',       'outflow', 'Worker drank beyond allowance, deducted',     0, 0, 1, 220),
  ('OWNER_TAKE',                 'outflow', 'Owner took for personal use',                 0, 0, 0, 230),
  ('EXPIRED',                    'outflow', 'Product expired',                             0, 1, 1, 240),
  ('LOAD_TO_ROUTE',              'outflow', 'Stock loaded onto delivery vehicle',          0, 0, 0, 250),
  ('RETURN_TO_SUPPLIER',         'outflow', 'Faulty/expired stock returned to supplier',   0, 0, 1, 260),
  ('THEFT_CONFIRMED',            'outflow', 'Confirmed theft, evidence on file',           0, 0, 1, 270),
  ('STOCKTAKE_VARIANCE_LOSS',    'outflow', 'Stocktake found less than system',            0, 0, 1, 280),
  ('OPENING_BALANCE_CORRECTION', 'neutral', 'One-time correction during initial setup',    0, 0, 1, 900);

-- void_sale reverses a sale; not in the seed because it's emitted by the
-- void flow, not the operator. Leaving it out keeps the dropdown clean.

-- deletion_reasons ----------------------------------------------------------
CREATE TABLE deletion_reasons (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applies_to TEXT NOT NULL  -- comma-separated table names
);

INSERT INTO deletion_reasons (code, description, applies_to) VALUES
  ('DUPLICATE',         'Duplicate of another row',          'workers,products,customers,suppliers,routes'),
  ('MISTAKE',           'Created in error',                  'workers,products,customers,suppliers,routes'),
  ('TEST_DATA',         'Was test data, should not exist',   'workers,products,customers,suppliers,routes'),
  ('OBSOLETE',          'No longer relevant',                'products,routes'),
  ('MERGED_INTO_OTHER', 'Merged into another row',           'customers,suppliers');

-- payment_methods -----------------------------------------------------------
CREATE TABLE payment_methods (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  requires_reference INTEGER NOT NULL DEFAULT 0 CHECK (requires_reference IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

INSERT INTO payment_methods (code, description, requires_reference) VALUES
  ('CASH',             'Cash',                       0),
  ('MOMO_MTN',         'MTN Mobile Money',           1),
  ('MOMO_VODAFONE',    'Telecel Cash (ex-Vodafone)', 1),
  ('MOMO_AIRTELTIGO',  'AirtelTigo Money',           1),
  ('BANK_TRANSFER',    'Bank transfer',              1),
  ('CREDIT',           'On customer credit account', 0);
