-- 0049_queued_voids.sql
-- Same-business-day void requests reviewed asynchronously by a senior worker.
-- A request has no operational/accounting effect until it is APPROVED.

CREATE TABLE sale_void_requests (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  requested_by TEXT NOT NULL REFERENCES workers(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN')),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  request_device_id TEXT NOT NULL,
  reviewed_by TEXT REFERENCES workers(id),
  reviewed_at TEXT,
  review_note TEXT,
  review_device_id TEXT,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL REFERENCES workers(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL REFERENCES workers(id),
  CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_device_id IS NULL AND withdrawn_at IS NULL)
    OR
    (status IN ('APPROVED', 'DECLINED') AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL AND review_device_id IS NOT NULL
      AND withdrawn_at IS NULL)
    OR
    (status = 'WITHDRAWN' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_device_id IS NULL AND withdrawn_at IS NOT NULL)
  ),
  CHECK (status <> 'DECLINED' OR length(trim(COALESCE(review_note, ''))) >= 3)
);

CREATE UNIQUE INDEX idx_sale_void_requests_one_pending
  ON sale_void_requests(sale_id) WHERE status = 'PENDING';
CREATE INDEX idx_sale_void_requests_queue
  ON sale_void_requests(location_id, status, requested_at);
CREATE INDEX idx_sale_void_requests_shift
  ON sale_void_requests(shift_id, status);
CREATE INDEX idx_sale_void_requests_requester
  ON sale_void_requests(requested_by, requested_at DESC);

-- Request identity/evidence is immutable. Resolution may only move a pending
-- request to one terminal state; a terminal decision can never be reopened.
CREATE TRIGGER trg_sale_void_requests_identity_immutable
BEFORE UPDATE ON sale_void_requests
WHEN NEW.sale_id <> OLD.sale_id
  OR NEW.location_id <> OLD.location_id
  OR NEW.shift_id <> OLD.shift_id
  OR NEW.requested_by <> OLD.requested_by
  OR NEW.reason <> OLD.reason
  OR NEW.requested_at <> OLD.requested_at
  OR NEW.request_device_id <> OLD.request_device_id
BEGIN
  SELECT RAISE(ABORT, 'sale void request identity is immutable');
END;

CREATE TRIGGER trg_sale_void_requests_terminal_immutable
BEFORE UPDATE ON sale_void_requests
WHEN OLD.status <> 'PENDING'
BEGIN
  SELECT RAISE(ABORT, 'resolved sale void requests are immutable');
END;

CREATE TRIGGER trg_sale_void_requests_transition
BEFORE UPDATE OF status ON sale_void_requests
WHEN OLD.status = 'PENDING' AND NEW.status NOT IN ('APPROVED', 'DECLINED', 'WITHDRAWN')
BEGIN
  SELECT RAISE(ABORT, 'invalid sale void request transition');
END;

CREATE TRIGGER trg_sale_void_requests_no_delete
BEFORE DELETE ON sale_void_requests
BEGIN
  SELECT RAISE(ABORT, 'sale void requests cannot be deleted');
END;

CREATE TRIGGER trg_outbox_sale_void_requests_ins
AFTER INSERT ON sale_void_requests
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('sale_void_requests', NEW.id, 'INSERT');
END;

CREATE TRIGGER trg_outbox_sale_void_requests_upd
AFTER UPDATE ON sale_void_requests
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('sale_void_requests', NEW.id, 'UPDATE');
END;

-- Sales are normally append-mostly, but voids, correction links, and printer
-- state legitimately update their header. Capture the current row centrally.
CREATE TRIGGER trg_outbox_sales_upd
AFTER UPDATE ON sales
BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op)
  VALUES ('sales', NEW.id, 'UPDATE');
END;
