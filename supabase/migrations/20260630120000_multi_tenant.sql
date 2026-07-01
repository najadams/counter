-- Counter central store — multi-tenant isolation (companies).
--
-- The base migration (20260625000001_central_sync.sql) was single-tenant: one
-- global shop_id namespace and one global HQ. This forward migration walls each
-- CLIENT COMPANY off so no shop ever sees another client's data:
--   * a `companies` table (one row per client),
--   * `company_id` on shops + shop_events, re-keyed so shop codes are unique
--     PER COMPANY (two clients can both have a shop 'OSU'),
--   * provisioning that mints a per-shop token bound to a company.
-- Isolation is enforced by the Edge Functions (which stamp company_id from the
-- token) AND by the keys here. RLS stays default-deny (service-role only).
--
-- Pre-tenant rows (from single-tenant testing) are backfilled into a 'DEFAULT'
-- company so the SET NOT NULL succeeds without data loss; that company can be
-- dropped once the real tenants are provisioned.

create extension if not exists pgcrypto;

-- 1. Tenants.
create table if not exists companies (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,        -- short client code, e.g. 'ACME'
  name       text not null,
  created_at timestamptz not null default now()
);
alter table companies enable row level security;  -- default deny (no policies)

-- 2. Add company_id (nullable first), then backfill any pre-tenant rows.
alter table shops       add column if not exists company_id uuid references companies(id) on delete cascade;
alter table shop_events add column if not exists company_id uuid references companies(id) on delete cascade;

do $$
declare v_default uuid;
begin
  if exists (select 1 from shops where company_id is null)
     or exists (select 1 from shop_events where company_id is null) then
    insert into companies (code, name) values ('DEFAULT', 'Default (pre-tenant data)')
      on conflict (code) do update set name = excluded.name
      returning id into v_default;
    update shops       set company_id = v_default where company_id is null;
    update shop_events set company_id = v_default where company_id is null;
  end if;
end $$;

-- 3. Re-key shops to (company_id, shop_id). Drop the dependent FK first.
alter table shop_events drop constraint if exists shop_events_shop_id_fkey;

alter table shops alter column company_id set not null;
alter table shops drop constraint if exists shops_pkey;
alter table shops add primary key (company_id, shop_id);

-- 4. Re-key shop_events to (company_id, shop_id, table_name, row_id); re-FK to shops.
alter table shop_events alter column company_id set not null;
alter table shop_events drop constraint if exists shop_events_pkey;
alter table shop_events add primary key (company_id, shop_id, table_name, row_id);
alter table shop_events add constraint shop_events_shop_fk
  foreign key (company_id, shop_id) references shops (company_id, shop_id) on delete cascade;

drop index if exists idx_shop_events_shop_seq;
create index if not exists idx_shop_events_company_seq on shop_events (company_id, shop_id, seq);

-- 5. Provisioning. The single-tenant register_shop() can no longer satisfy the
-- NOT NULL company_id, so replace it. provision_shop() upserts the company, mints
-- a fresh per-shop bearer token, stores only its hash, and returns the plaintext
-- ONCE (the only time it is ever visible):
--   select provision_shop('ACME', 'Acme Drinks Ltd', 'OSU', 'HQ');
drop function if exists register_shop(text, text, text, text);

create or replace function provision_shop(
  p_company_code text, p_company_name text, p_shop_id text, p_role text default 'SHOP'
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_company uuid;
  v_token   text;
begin
  insert into companies (code, name) values (p_company_code, p_company_name)
    on conflict (code) do update set name = excluded.name
    returning id into v_company;

  v_token := 'cnt_' || encode(gen_random_bytes(24), 'hex');

  insert into shops (company_id, shop_id, name, token_hash, role)
  values (v_company, p_shop_id, p_company_name,
          encode(digest(v_token, 'sha256'), 'hex'), coalesce(p_role, 'SHOP'))
  on conflict (company_id, shop_id) do update
    set token_hash = excluded.token_hash, role = excluded.role;

  return v_token;
end $$;

-- 6. Per-company consolidated sales reporting (typed projection over the JSONB
-- events). security_invoker so the underlying RLS applies once dashboard
-- policies exist; today it's reachable only via service role.
create or replace view sales_central with (security_invoker = on) as
select
  company_id,
  shop_id,
  row_id as sale_id,
  (data->>'total_pesewas')::bigint   as total_pesewas,
  (data->>'taxable_pesewas')::bigint as taxable_pesewas,
  (data->>'vat_pesewas')::bigint     as vat_pesewas,
  (data->>'channel')                 as channel,
  (data->>'created_at')              as created_at,
  data
from shop_events
where table_name = 'sales';
