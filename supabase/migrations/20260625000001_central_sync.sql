-- Counter central sync store — Phase 3b ingest (events UP).
--
-- This is the CENTRAL side (HQ / cloud Postgres on Supabase). The shop side is
-- already built (src/main/sync/*): each shop drains its append-only sync_outbox
-- and POSTs PushBatch { shopId, rows:[{seq,table,op,data}] } to <central>/ingest,
-- expecting { ackedSeq } back. This schema is what receives and stores those.
--
-- Conflict-free by construction: no two shops ever touch the same row, so the
-- central store is just the union of every shop's activity, keyed by
-- (shop_id, table_name, row_id). Re-sends upsert and are harmless.
--
-- Security posture (runbook §10): RLS is ON with NO policies, so the auto REST
-- API (anon/auth roles) can read NOTHING here. Only the Edge Functions, which
-- run with the service-role key (bypasses RLS) and authenticate a per-shop
-- bearer token themselves, ever touch these tables.

create extension if not exists pgcrypto;

-- Per-shop registration + bearer-token hash + ack high-water mark.
create table if not exists shops (
  shop_id        text primary key,
  name           text,
  token_hash     text not null,                       -- sha256 hex of the bearer token; plaintext never stored
  role           text not null default 'SHOP' check (role in ('SHOP','HQ')),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  last_acked_seq bigint not null default 0
);

-- The append-only union of every shop's event rows. Idempotent on
-- (shop_id, table_name, row_id): a re-sent row upserts, never duplicates.
create table if not exists shop_events (
  shop_id     text   not null references shops(shop_id),
  table_name  text   not null,
  row_id      text   not null,
  seq         bigint not null,
  op          text   not null check (op in ('INSERT','UPDATE')),
  data        jsonb  not null,                         -- the full source row; money stays integer pesewas
  ingested_at timestamptz not null default now(),
  primary key (shop_id, table_name, row_id)
);

-- Per-shop gap detection: a hole in the seq sequence means data went missing in
-- transit (same anti-shrinkage instinct as the rest of the app).
create index if not exists idx_shop_events_shop_seq on shop_events (shop_id, seq);

alter table shops       enable row level security;
alter table shop_events enable row level security;
-- Intentionally NO policies: service-role functions only. Do not add anon/auth
-- read policies without a deliberate review — this is shop financial data.

-- Register or rotate a shop's token in one call. Run from the SQL editor / RPC
-- as the OWNER provisions each shop:
--   select register_shop('OSU', 'Osu branch', '<the-per-shop-token>');
-- Then on that shop: Settings → Sync → shop_id OSU, central_url
-- https://<project>.supabase.co/functions/v1/ , token <the-per-shop-token>.
create or replace function register_shop(
  p_shop_id text, p_name text, p_token text, p_role text default 'SHOP'
) returns void
language sql
security definer
-- pgcrypto's digest() lives in the `extensions` schema on Supabase, not public,
-- so include it on the search_path.
set search_path = public, extensions
as $$
  insert into shops (shop_id, name, token_hash, role)
  values (p_shop_id, p_name, encode(digest(p_token, 'sha256'), 'hex'), p_role)
  on conflict (shop_id) do update
    set name = excluded.name, token_hash = excluded.token_hash, role = excluded.role;
$$;
