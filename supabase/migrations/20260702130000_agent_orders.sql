-- Counter central store — Phase 4: WhatsApp order agent.
--
-- Adds a THIRD kind of caller to the central store, alongside shops (push/pull
-- sync) and the admin secret (company bootstrap): an AGENT — a company-scoped,
-- read-mostly service that quotes prices/availability from the existing catalog
-- mirror and writes proforma orders for a shop to fulfil. An agent is never a
-- shop: it has no outbox, no seq, no ack watermark, and a narrower set of
-- allowed actions (`scopes`), so it gets its own table and its own token
-- namespace rather than reusing `shops`.
--
-- Design doc: docs/phase4-whatsapp-order-agent.md §3 (workstream A).
-- Security posture is identical to the rest of this store (CLAUDE.md §10): RLS
-- ON with NO policies on every new table — only the service-role Edge Functions
-- (agent, orders-feed) ever touch these, and each authenticates its own bearer
-- token before doing anything.

create extension if not exists pgcrypto;

-- 1. Agent identity. One row per deployed agent instance (usually one per
--    company, but the schema allows more — e.g. a staging agent alongside a
--    production one, each independently revocable).
create table if not exists agents (
  company_id    uuid not null references companies(id) on delete cascade,
  agent_id      text not null,
  token_hash    text not null,                          -- sha256 hex; plaintext never stored
  scopes        text[] not null default array['catalog:read','stock:read','orders:write'],
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  primary key (company_id, agent_id)
);
alter table agents enable row level security;  -- default deny, no policies

-- 2. Orders. A WhatsApp order is a PROFORMA — a quote the agent issued and the
--    customer confirmed — not a sale. It never touches money or stock directly;
--    it becomes a real sale only when a cashier rings it through Counter's
--    normal checkout (which re-applies the price floor, canonical stock
--    movements, receipt, and audit trail unchanged). See design doc §5 (C3).
--
--    subtotal/total are always SERVER-computed from the HQ catalog mirror at
--    quote time (create_order() below) — the agent's request carries only
--    product/unit ids and quantities, never a price. No order-level discount
--    exists in v1, hence the equality CHECK; adding promo pricing later means
--    lifting this CHECK alongside the code that introduces it, same discipline
--    as every other invariant CHECK in this system.
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  shop_id            text not null,                      -- the fulfilling branch
  status             text not null default 'QUOTED'
                        check (status in ('QUOTED','CONFIRMED','FULFILLED','EXPIRED','CANCELLED')),
  customer_phone     text not null,                       -- E.164; the WhatsApp identity
  customer_name      text,
  channel            text not null default 'WALK_IN'
                        check (channel in ('WALK_IN','WHOLESALE','ROUTE')),
  subtotal_pesewas   integer not null check (subtotal_pesewas >= 0),
  total_pesewas      integer not null check (total_pesewas >= 0),
  check (total_pesewas = subtotal_pesewas),               -- no order-level discounts in v1
  quote_expires_at   timestamptz not null,
  confirmed_at       timestamptz,
  fulfilled_at       timestamptz,
  fulfilled_sale_id  text,                                -- Counter's local sale id once rung (set by C, Phase 4b)
  created_by_agent   text not null,
  -- Caller-supplied dedup key (e.g. the inbound WhatsApp message id). A retried
  -- create-order call (webhook redelivery, agent-side network retry) with the
  -- same key returns the ALREADY-CREATED order instead of minting a duplicate.
  -- NULL = no key supplied, never collides with anything (partial index below).
  idempotency_key    text,
  -- Cursor for orders-feed (shop pull, DOWN direction) — assigned by
  -- confirm_order() the moment an order becomes CONFIRMED, i.e. the moment
  -- it becomes relevant to the fulfilling shop. NULL until then, so a QUOTED
  -- order never appears in the feed. Mirrors shop_events.seq's role in the
  -- catalog pull contract (src/shared/sync.ts PullResponse), but scoped to
  -- this table rather than the shared outbox sequence — orders aren't
  -- shop-authored events, so they don't belong in shop_events.
  seq                bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (company_id, shop_id) references shops (company_id, shop_id),
  foreign key (company_id, created_by_agent) references agents (company_id, agent_id)
);
alter table orders enable row level security;  -- default deny, no policies

create sequence if not exists orders_seq;

create index if not exists idx_orders_company_shop_status on orders (company_id, shop_id, status);
create index if not exists idx_orders_shop_seq on orders (company_id, shop_id, seq) where seq is not null;
create unique index if not exists idx_orders_agent_idempotency
  on orders (company_id, created_by_agent, idempotency_key)
  where idempotency_key is not null;

create table if not exists order_lines (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  product_id          text not null,                      -- shop-side product id, from the HQ catalog mirror
  unit_id             text,                                -- product_units id; null = canonical unit
  quantity            integer not null check (quantity > 0),
  unit_price_pesewas  integer not null check (unit_price_pesewas >= 0),
  line_total_pesewas  integer not null check (line_total_pesewas >= 0),
  check (line_total_pesewas = unit_price_pesewas * quantity)   -- same invariant style as sale_lines
);
alter table order_lines enable row level security;  -- default deny, no policies

create index if not exists idx_order_lines_order on order_lines (order_id);

-- 3. Stock mirror. Every shop's stock_movements rows already sync up into
--    shop_events (jsonb) — this just makes the on-hand read cheap and readable
--    without duplicating the shop's own truth. Plain view for now; the design
--    doc flags promoting this to an incrementally-maintained rollup fed by
--    ingest() if movement volume ever makes the aggregate slow. security_invoker
--    matches sales_central (20260630120000_multi_tenant.sql) — RLS-transparent,
--    reachable only via service role until dashboard policies exist.
create or replace view central_stock_on_hand
with (security_invoker = on) as
select company_id, shop_id,
       data->>'product_id' as product_id,
       sum((data->>'quantity')::bigint) as on_hand
  from shop_events
 where table_name = 'stock_movements'
 group by 1, 2, 3;

-- 4. Atomic order write. Pricing is computed by the Edge Function (TypeScript,
--    unit-tested — see supabase/functions/_shared/pricing.ts) from the same
--    catalog mirror `catalog`/`agent` read; this function ONLY persists the
--    already-priced lines, atomically (order + all lines in one transaction,
--    same discipline as completeSaleCore's single-transaction write). It never
--    re-derives a price, so it cannot silently disagree with what the customer
--    was quoted.
--
--    Idempotent when p_idempotency_key is supplied: a retried call with the
--    same (company, agent, key) returns the id of the order ALREADY created,
--    rather than raising the unique-index violation or minting a duplicate.
create or replace function create_order(
  p_company_id uuid, p_shop_id text, p_customer_phone text, p_customer_name text,
  p_channel text, p_created_by_agent text, p_quote_expires_at timestamptz,
  p_lines jsonb,  -- [{product_id, unit_id, quantity, unit_price_pesewas, line_total_pesewas}, ...]
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_order_id uuid;
  v_subtotal integer;
  v_line     jsonb;
begin
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'create_order: at least one line required';
  end if;

  if p_idempotency_key is not null then
    select id into v_order_id from orders
     where company_id = p_company_id and created_by_agent = p_created_by_agent
       and idempotency_key = p_idempotency_key;
    if v_order_id is not null then
      return v_order_id;   -- already created by an earlier (retried) call
    end if;
  end if;

  select coalesce(sum((l->>'line_total_pesewas')::integer), 0) into v_subtotal
    from jsonb_array_elements(p_lines) l;

  insert into orders (
    company_id, shop_id, status, customer_phone, customer_name, channel,
    subtotal_pesewas, total_pesewas, quote_expires_at, created_by_agent, idempotency_key
  ) values (
    p_company_id, p_shop_id, 'QUOTED', p_customer_phone, p_customer_name, p_channel,
    v_subtotal, v_subtotal, p_quote_expires_at, p_created_by_agent, p_idempotency_key
  ) returning id into v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into order_lines (
      order_id, product_id, unit_id, quantity, unit_price_pesewas, line_total_pesewas
    ) values (
      v_order_id,
      v_line->>'product_id',
      v_line->>'unit_id',
      (v_line->>'quantity')::integer,
      (v_line->>'unit_price_pesewas')::integer,
      (v_line->>'line_total_pesewas')::integer
    );
  end loop;

  return v_order_id;
end $$;

-- Atomic QUOTED -> CONFIRMED transition, incl. the expiry check and the seq
-- assignment that makes the order visible to orders-feed. `for update` locks
-- the row so two concurrent confirm calls for the same order can't both pass
-- the status check — the second sees the first's committed state. Returns the
-- resulting status; the caller (agent/index.ts) maps anything other than
-- 'CONFIRMED' to an error response rather than re-deriving the decision.
create or replace function confirm_order(p_company_id uuid, p_order_id uuid) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status  text;
  v_expires timestamptz;
begin
  select status, quote_expires_at into v_status, v_expires
    from orders where company_id = p_company_id and id = p_order_id
    for update;

  if v_status is null then
    return 'NOT_FOUND';
  end if;

  if v_status = 'QUOTED' and v_expires < now() then
    update orders set status = 'EXPIRED', updated_at = now()
     where company_id = p_company_id and id = p_order_id;
    return 'EXPIRED';
  end if;

  if v_status <> 'QUOTED' then
    return v_status;   -- already CONFIRMED/CANCELLED/FULFILLED — caller treats as conflict
  end if;

  update orders
     set status = 'CONFIRMED', confirmed_at = now(), updated_at = now(),
         seq = nextval('orders_seq')
   where company_id = p_company_id and id = p_order_id;

  return 'CONFIRMED';
end $$;

-- 5. Provisioning. Operator-only (same gate as bootstrap-company — the agent
--    Edge Function checks PROVISION_ADMIN_SECRET, not this function directly).
--    Token is generated HERE, never passed in, and shown to the operator
--    exactly once, matching provision_shop()'s pattern. 'cnta_' prefix (vs.
--    shops' 'cnt_') lets an operator tell the two token kinds apart at a
--    glance — both are still secrets.
create or replace function register_agent(
  p_company_code text, p_agent_id text,
  p_scopes text[] default array['catalog:read','stock:read','orders:write']
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_company uuid;
  v_token   text;
begin
  select id into v_company from companies where code = p_company_code;
  if v_company is null then
    raise exception 'company % not found — bootstrap it first', p_company_code;
  end if;

  v_token := 'cnta_' || encode(gen_random_bytes(24), 'hex');

  insert into agents (company_id, agent_id, token_hash, scopes, revoked_at)
  values (v_company, p_agent_id, encode(digest(v_token, 'sha256'), 'hex'), p_scopes, null)
  on conflict (company_id, agent_id) do update
    set token_hash = excluded.token_hash, scopes = excluded.scopes, revoked_at = null;

  return v_token;
end $$;

-- Revoke without deleting — keeps the row (and its FK'd orders) intact, just
-- makes authenticateAgent() refuse the token going forward. Use this if the
-- agent VPS is ever compromised, or to retire a staging agent.
create or replace function revoke_agent(p_company_code text, p_agent_id text) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_company uuid;
begin
  select id into v_company from companies where code = p_company_code;
  if v_company is null then
    raise exception 'company % not found', p_company_code;
  end if;
  update agents set revoked_at = now()
   where company_id = v_company and agent_id = p_agent_id;
end $$;
