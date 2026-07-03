-- Self-service branch onboarding: add a SIBLING shop to a company that already
-- exists, without re-asserting the company by name (the caller already proved
-- membership via its own bearer token — see supabase/functions/add-shop).
--
-- Mirrors provision_shop() (20260630120000_multi_tenant.sql) minus the company
-- upsert: company_id is supplied by the authenticated caller's own shop row, not
-- typed in by the client. Only mints tokens for role='SHOP' — a second HQ per
-- company would make the catalog function's `.limit(1)` pick arbitrarily, so
-- that stays a deliberate operator-side choice (provision_shop's role param).

create or replace function add_shop_to_company(
  p_company_id uuid, p_shop_id text, p_role text default 'SHOP'
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
begin
  if p_role not in ('SHOP', 'HQ') then
    raise exception 'role must be SHOP or HQ';
  end if;

  v_token := 'cnt_' || encode(gen_random_bytes(24), 'hex');

  insert into shops (company_id, shop_id, name, token_hash, role)
  values (p_company_id, p_shop_id, p_shop_id, encode(digest(v_token, 'sha256'), 'hex'), p_role)
  on conflict (company_id, shop_id) do update
    set token_hash = excluded.token_hash, role = excluded.role;

  return v_token;
end $$;
