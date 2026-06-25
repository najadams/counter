-- Sale correction (Approach A). A correction VOIDs the original sale and
-- re-rings it pre-filled (original lines at snapshot prices) + the added items,
-- producing ONE superseding sale with a fresh "CORRECTED" receipt. The original
-- is reversed, never edited (immutability preserved, two-sided audit).
--
-- Bidirectional links so the door/exit clearance and revenue de-dup can tell
-- which sale is authoritative cheaply, without parsing audit JSON:
--   - the original gets superseded_by_sale_id = <replacement>
--   - the replacement gets supersedes_sale_id   = <original>
-- (Plain TEXT, no inline FK: SQLite ALTER TABLE ADD COLUMN forbids adding a
--  REFERENCES clause; the app enforces the link.)

ALTER TABLE sales ADD COLUMN superseded_by_sale_id TEXT;
ALTER TABLE sales ADD COLUMN supersedes_sale_id    TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_superseded_by
  ON sales(superseded_by_sale_id) WHERE superseded_by_sale_id IS NOT NULL;
