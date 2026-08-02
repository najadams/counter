-- 0046_paper_receipt_till_tracking.sql
-- Track paper receipts that have been opened in the till but not yet posted.

ALTER TABLE paper_receipt_imports ADD COLUMN till_opened_at TEXT;
ALTER TABLE paper_receipt_imports ADD COLUMN till_opened_by TEXT REFERENCES workers(id);

CREATE INDEX idx_paper_receipt_imports_till_opened
  ON paper_receipt_imports(till_opened_at DESC)
  WHERE till_opened_at IS NOT NULL;
