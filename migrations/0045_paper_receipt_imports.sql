-- 0045_paper_receipt_imports.sql
-- Photo-backed handwritten/paper receipt intake.
--
-- These rows are drafts, not sales. A paper receipt only affects money and
-- stock after a worker reviews the parsed lines and posts the draft through
-- the normal completeSale path.

PRAGMA foreign_keys = ON;

CREATE TABLE paper_receipt_imports (
  id                 TEXT PRIMARY KEY,
  shift_id           TEXT NOT NULL REFERENCES shifts(id),
  worker_id          TEXT NOT NULL REFERENCES workers(id),
  location_id        TEXT NOT NULL REFERENCES locations(id),
  status             TEXT NOT NULL CHECK (status IN ('REVIEW', 'POSTED', 'DISCARDED')),
  photo_url          TEXT NOT NULL,
  ocr_text           TEXT NOT NULL DEFAULT '',
  channel            TEXT NOT NULL CHECK (channel IN ('WALK_IN', 'WHOLESALE', 'ROUTE')),
  payment_method     TEXT NOT NULL REFERENCES payment_methods(code),
  payment_reference  TEXT,
  cash_given_pesewas INTEGER,
  customer_id        TEXT REFERENCES customers(id),
  posted_sale_id     TEXT REFERENCES sales(id),
  discarded_reason   TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by         TEXT NOT NULL REFERENCES workers(id),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by         TEXT NOT NULL REFERENCES workers(id),
  device_id          TEXT NOT NULL,
  synced_at          TEXT,
  CHECK ((status != 'POSTED' AND posted_sale_id IS NULL) OR (status = 'POSTED' AND posted_sale_id IS NOT NULL)),
  CHECK ((status != 'DISCARDED' AND discarded_reason IS NULL) OR (status = 'DISCARDED' AND discarded_reason IS NOT NULL))
);
CREATE INDEX idx_paper_receipt_imports_status ON paper_receipt_imports(status, created_at DESC);
CREATE INDEX idx_paper_receipt_imports_sale ON paper_receipt_imports(posted_sale_id) WHERE posted_sale_id IS NOT NULL;

CREATE TABLE paper_receipt_import_lines (
  id                    TEXT PRIMARY KEY,
  import_id             TEXT NOT NULL REFERENCES paper_receipt_imports(id) ON DELETE CASCADE,
  line_no               INTEGER NOT NULL,
  raw_text              TEXT NOT NULL,
  product_id            TEXT REFERENCES products(id),
  product_sku_snapshot  TEXT,
  product_name_snapshot TEXT,
  unit_id               TEXT REFERENCES product_units(id),
  unit_name_snapshot    TEXT,
  quantity              INTEGER,
  unit_price_pesewas    INTEGER,
  confidence            INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  review_note           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by            TEXT NOT NULL REFERENCES workers(id),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by            TEXT NOT NULL REFERENCES workers(id),
  device_id             TEXT NOT NULL,
  CHECK (quantity IS NULL OR quantity > 0),
  CHECK (unit_price_pesewas IS NULL OR unit_price_pesewas >= 0),
  UNIQUE(import_id, line_no)
);
CREATE INDEX idx_paper_receipt_import_lines_import ON paper_receipt_import_lines(import_id, line_no);
