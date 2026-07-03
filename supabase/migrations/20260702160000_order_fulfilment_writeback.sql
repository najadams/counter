-- Counter central store — Phase 4 workstream C: shop accept/reject writeback.
--
-- The prior migration (20260702130000_agent_orders.sql) built the agent-facing
-- half of the order lifecycle: QUOTED -> CONFIRMED. This migration adds the
-- SHOP-facing half — a cashier viewing a CONFIRMED order in Counter can either
-- Accept it (which, in Counter's model, means ringing it through the normal
-- Sale screen; there is no separate "accepted but not yet sold" status,
-- deliberately — Counter's only real commitment point is completeSale, and a
-- hard reservation state would contradict the "no hard stock reservation" call
-- in docs/phase4-whatsapp-order-agent.md §1) or Reject it (decline, with a
-- reason, no stock/money effect).
--
-- REJECTED is a genuinely new status, distinct from CANCELLED: CANCELLED means
-- the customer/agent backed out before or after confirming; REJECTED means the
-- SHOP looked at a confirmed order and declined to fulfil it (out of stock in
-- reality, closed, etc). Different information, different message back to the
-- customer, so they get different values rather than reusing one.
--
-- The shop's decision travels up the EXISTING outbox/ingest pipeline as a
-- pending_orders row (Counter migration 0039) — no new ingress endpoint. This
-- migration adds the piece that was only narratively described in the design
-- doc: a trigger on shop_events that, when a pending_orders row lands, copies
-- its terminal status back onto the authoritative `orders` row.

-- 1. REJECTED joins the status vocabulary. Column-level CHECK constraints get
--    an auto-generated name (orders_status_check); look it up rather than
--    hardcoding it, so this migration doesn't silently no-op if Postgres ever
--    names it differently.
do $$
declare
  v_conname text;
begin
  select conname into v_conname
    from pg_constraint
   where conrelid = 'orders'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%QUOTED%CONFIRMED%';
  if v_conname is not null then
    execute format('alter table orders drop constraint %I', v_conname);
  end if;
end $$;

alter table orders add constraint orders_status_check
  check (status in ('QUOTED','CONFIRMED','FULFILLED','EXPIRED','CANCELLED','REJECTED'));

alter table orders add column if not exists reject_reason text;

-- 2. Writeback trigger. Fires on every shop_events insert/update, but only
--    ACTS when the row is a pending_orders row — cheap early-out for every
--    other event table this shop pushes (sales, stock_movements, ...).
--
--    The `and status = 'CONFIRMED'` guard makes this idempotent: a retried or
--    duplicate pending_orders sync (the shop's own outbox already dedupes,
--    but defense in depth costs nothing here) matches zero rows the second
--    time, because the order is no longer CONFIRMED after the first write.
--    It also means this can never move an order BACKWARD out of a terminal
--    state — only CONFIRMED -> {FULFILLED, REJECTED, CANCELLED} is possible.
create or replace function sync_pending_order_writeback() returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_new_status text;
begin
  if new.table_name <> 'pending_orders' then
    return new;
  end if;

  v_new_status := new.data->>'status';
  if v_new_status not in ('FULFILLED', 'REJECTED', 'CANCELLED') then
    return new;   -- the initial CONFIRMED mirror-write — nothing to change centrally
  end if;

  update orders
     set status = v_new_status,
         fulfilled_sale_id = coalesce(new.data->>'fulfilled_sale_id', fulfilled_sale_id),
         fulfilled_at = case when v_new_status = 'FULFILLED' then now() else fulfilled_at end,
         reject_reason = coalesce(new.data->>'reject_reason', reject_reason),
         updated_at = now()
   where company_id = new.company_id
     and id = (new.row_id)::uuid
     and status = 'CONFIRMED';

  return new;
end $$;

drop trigger if exists trg_pending_order_writeback on shop_events;
create trigger trg_pending_order_writeback
  after insert or update on shop_events
  for each row
  when (new.table_name = 'pending_orders')
  execute function sync_pending_order_writeback();
