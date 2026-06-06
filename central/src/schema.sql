-- Counter central sync store — Postgres schema (Phase 3, design §B6).
--
-- The central store is a downstream AGGREGATE, never the system of record: a
-- shop sells offline against its own SQLite and ships events up here when it
-- has a line. Every statement is idempotent (IF NOT EXISTS / composite PKs) so
-- `npm run migrate` is safe to re-run.

-- --- Shop registry + auth -----------------------------------------------------
-- One row per provisioned shop. The bearer token the shop presents is stored
-- ONLY as a sha256 hash; the plaintext is shown once at provisioning time and
-- never persisted. The shop_id <-> token binding lives here so a leaked token
-- from shop A can never impersonate shop B (design §B8).
CREATE TABLE IF NOT EXISTS shops (
  shop_id      text PRIMARY KEY,
  name         text,
  token_hash   text NOT NULL,
  role         text NOT NULL DEFAULT 'SHOP' CHECK (role IN ('SHOP', 'HQ')),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_token ON shops (token_hash);

-- --- Per-shop seq log: MAX(seq) + hole detection -----------------------------
-- One row per pushed outbox seq. The shop's seq is a gap-free AUTOINCREMENT, so
-- a HOLE in what central received = data lost in transit = a shrinkage signal
-- (design §B6/§B10). This table is never pruned; it is the durable proof of the
-- contiguous stream and the source of the ack watermark.
CREATE TABLE IF NOT EXISTS sync_ingest_log (
  shop_id     text   NOT NULL,
  seq         bigint NOT NULL,
  table_name  text   NOT NULL,
  op          text   NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, seq)
);

-- --- Event union (flows UP) --------------------------------------------------
-- The union of every shop's append-only activity (sales, payments, stock moves,
-- audit, ...). Idempotent by (shop_id, table, id); events are immutable, so a
-- double-send DO NOTHINGs and can never double-count revenue. Money stays
-- integer pesewas and stock stays canonical units inside the JSONB payload —
-- no float anywhere on the wire.
CREATE TABLE IF NOT EXISTS ingested_rows (
  shop_id     text  NOT NULL,
  table_name  text  NOT NULL,
  row_id      text  NOT NULL,
  op          text  NOT NULL,
  data        jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, table_name, row_id)
);
CREATE INDEX IF NOT EXISTS idx_ingested_table ON ingested_rows (table_name);

-- --- Catalog (flows DOWN) ----------------------------------------------------
-- HQ-authored master/catalog rows (products, prices, suppliers, workers, ...)
-- deduped by (table, id). Each write stamps a fresh monotonic cursor so shops
-- pulling `?since=<cursor>` always converge on the latest. One writer (HQ), so
-- last-writer-wins is conflict-free by construction.
CREATE SEQUENCE IF NOT EXISTS catalog_cursor_seq;
CREATE TABLE IF NOT EXISTS catalog (
  table_name     text   NOT NULL,
  row_id         text   NOT NULL,
  data           jsonb  NOT NULL,
  cursor         bigint NOT NULL,
  source_shop_id text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_cursor ON catalog (cursor);
