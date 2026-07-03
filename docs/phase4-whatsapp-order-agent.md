# Phase 4 — WhatsApp order agent

> Status: **planned**. Nothing in this document is built. Companion to
> `docs/phase3-network-and-sync.md` (the sync rails this design rides on) and
> CLAUDE.md §10 (the central store, live).

An AI agent answers the business WhatsApp line: quotes prices, confirms
availability, and issues proforma invoices. Confirmed orders flow down the
existing sync rails into a queue on the till; a cashier rings each one through
the normal checkout. The agent never writes a sale, never holds money math,
and never connects to a shop PC.

---

## 1. Goal and non-goals

**Goal.** A customer messages the order line on WhatsApp, gets accurate prices
and availability, receives a proforma invoice, confirms, and the order appears
on the shop's till ready to ring — with every existing Counter control (price
floor, canonical stock movements, receipt, audit) applying unchanged at the
moment of sale.

**Non-goals (v1), each deliberate:**

- **The agent does not complete sales.** `completeSale` stays human-triggered.
  A wrong LLM parse must never move stock or money.
- **No inbound connection to any shop PC.** The shop's sync workers connect
  outbound only, exactly as today.
- **No hard stock reservation.** Stock truth lives in the shop's SQLite; a
  central "hold" would be fiction. A freshness buffer + short quote validity
  covers the gap (§6).
- **No payments over WhatsApp.** Payment happens at pickup/delivery through
  the normal till flow. (MoMo prepayment is Phase 4c, optional.)
- **Single fulfilling shop per order.** Multi-shop routing is a later decision.

## 2. Architecture

```
Customer (WhatsApp)
      │
OpenWA gateway  ──┐   one VPS, one docker-compose,
      │           │   OpenWA bound to localhost
Order agent  ─────┘   (repo: counter-agent, NEW)
      │  scoped agent token, HTTPS
Central store (Supabase — already live; additions live in THIS repo)
      │  ▲
      │  │  existing outbound-only sync (pull orders ↓, push events ↑)
Counter shop PC — pending-orders screen → cashier rings sale
```

Three workstreams, three homes:

| Workstream | Lives in | Ships as |
|---|---|---|
| A — central store additions | this repo (`supabase/`) | Supabase migration + Edge Function deploys |
| B — agent + gateway | new repo `counter-agent` | Docker compose on a VPS |
| C — till integration | this repo (`src/`, `migrations/`) | a normal Counter release |

A and B are independent of C: Phase 4a (quote + invoice over WhatsApp) works
with **zero Counter changes** — the shop reads confirmed orders from a phone
and re-keys them. C automates that last hop.

The seam between B and everything else is one versioned HTTP surface
(`/agent/v1/…`). Additive changes only, same discipline as the sync protocol.

## 3. Workstream A — central store (this repo)

### A1. Agent identity: `agents` table

Do **not** overload `shops` with an AGENT role — agents aren't shops (no seq,
no ack watermark, different scopes). New table, same token discipline
(sha256 only, plaintext never stored):

```sql
create table agents (
  agent_id    text not null,
  company_id  uuid not null references companies(id) on delete cascade,
  token_hash  text not null,             -- sha256 hex, like shops.token_hash
  scopes      text[] not null default '{catalog:read,stock:read,orders:write}',
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at  timestamptz,
  primary key (company_id, agent_id)
);
alter table agents enable row level security;   -- default deny, no policies
```

Provisioning is operator-only, mirroring `bootstrap-company`: a
`register_agent(company_code, agent_id, token)` security-definer function,
invoked from `scripts/provision-agent.ts` gated by `PROVISION_ADMIN_SECRET`.
Token shown once, recovery-code style.

### A2. Orders data model

```sql
create table orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  shop_id          text not null,          -- fulfilling branch
  status           text not null default 'QUOTED'
                   check (status in ('QUOTED','CONFIRMED','FULFILLED','EXPIRED','CANCELLED')),
  customer_phone   text not null,          -- E.164; the WhatsApp identity
  customer_name    text,
  channel          text not null default 'WALK_IN',
  subtotal_pesewas integer not null,       -- SERVER-computed, never client-supplied
  total_pesewas    integer not null,
  quote_expires_at timestamptz not null,
  confirmed_at     timestamptz,
  fulfilled_at     timestamptz,
  fulfilled_sale_id text,                  -- Counter's local sale id once rung
  created_by_agent text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (company_id, shop_id) references shops (company_id, shop_id)
);

create table order_lines (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id) on delete cascade,
  product_id         text not null,        -- the shop-side product id (from catalog)
  unit_id            text,                 -- product_units id; null = canonical
  quantity           integer not null check (quantity > 0),
  unit_price_pesewas integer not null,     -- server-computed from catalog at quote time
  line_total_pesewas integer not null
);
create index on orders (company_id, shop_id, status);
-- RLS on both, no policies.
```

All money integer pesewas (CLAUDE.md §5). The agent's create-order request
carries **only** `{productId, unitId, quantity}` per line; the Edge Function
re-reads prices from the company's HQ catalog rows in `shop_events` and
computes every total itself. Same philosophy as the till's price floor: the
layer in the middle is untrusted, the server owns the numbers.

### A3. Stock mirror view

On-hand per (shop, product) already exists implicitly — every
`stock_movements` row syncs up into `shop_events` as jsonb. Materialize the
read:

```sql
create view central_stock_on_hand
with (security_invoker = on) as
select company_id, shop_id,
       data->>'product_id'  as product_id,
       sum((data->>'quantity')::bigint) as on_hand
  from shop_events
 where table_name = 'stock_movements'
 group by 1, 2, 3;
```

Plain view first (shop-scale movement counts make this cheap); promote to an
incrementally-maintained rollup table fed by the ingest function only if
latency says so. Freshness signal = `shops.last_seen_at` (already maintained
by ingest).

### A4. Edge Function `agent` (`/functions/v1/agent/…`)

One function, path-routed, deployed `verify_jwt=false` like the others;
authenticates the bearer token against `agents` (reject if `revoked_at`),
stamps `company_id` from the token — the caller never asserts it. Endpoints:

| Route | Verb | Does |
|---|---|---|
| `/agent/v1/catalog?q=&since=` | GET | product + unit + price search over the HQ catalog rows (same source `catalog` fn serves shops) |
| `/agent/v1/availability?shopId=&productId=&unitId=&qty=` | GET | `{onHand, freshAsOf, verdict: IN_STOCK\|LOW\|UNKNOWN}` per §6 rules |
| `/agent/v1/orders` | POST | create QUOTED order; body is lines of ids+qty only; idempotency key header; returns server-priced order |
| `/agent/v1/orders/:id/confirm` | POST | QUOTED→CONFIRMED (rejects if expired) |
| `/agent/v1/orders/:id/cancel` | POST | →CANCELLED |
| `/agent/v1/orders/:id` | GET | status poll |

Hardening: per-agent rate limit (rows-per-minute counter in the function),
payload caps (≤ 20 lines, qty ≤ configurable max), and a `QUOTED` expiry
sweep — cheapest correct version is expiry-on-read (`status='QUOTED' and
quote_expires_at < now()` treated as EXPIRED everywhere it's read) plus a
weekly `pg_cron` tidy; no job infrastructure needed.

### A5. Orders feed DOWN + fulfilment UP (consumed by C, built in A)

- **Down:** `/functions/v1/orders-feed?since=<cursor>` — shop-token
  authenticated (existing `authenticate()`), returns this shop's
  CONFIRMED orders as `{ rows:[{cursor, data}], cursor }`, the exact wire
  contract `pull.ts` already speaks for catalog.
- **Up:** fulfilment rides the existing outbox. When C lands, the shop's
  local `pending_orders` row update syncs up through `/ingest` like any
  event; a small trigger on `shop_events` (insert/update where
  `table_name='pending_orders'`) copies status + `fulfilled_sale_id` onto
  `orders`. No new inbound path, no new auth.

### A6. Tests (workstream A)

Edge Functions are Deno; keep the pattern used by `ingest`: pure logic
(pricing computation, availability verdict, expiry-on-read) extracted into
plain functions with unit tests, plus one golden contract test per endpoint
(fixture request → exact JSON reply) so B can develop against fixtures.
Definition of done: a `curl` script in `scripts/` demonstrating the full
quote→confirm lifecycle against a staging project.

## 4. Workstream B — agent app (new repo `counter-agent`)

### B1. Shape

Node/TypeScript service. One `docker-compose.yml` runs two containers:
`openwa` (session volume persisted, dashboard NOT published, API bound to the
compose network only) and `agent`. Config via env: central URL + agent token,
OpenWA URL + API key + webhook HMAC secret, LLM endpoint + model, shop id,
quote validity, stock buffer, language list.

### B2. Gateway adapter — the swappable seam

```ts
interface WaGateway {
  onMessage(handler: (m: InboundMessage) => Promise<void>): void; // webhook receiver
  sendText(to: string, text: string): Promise<void>;
  sendDocument(to: string, pdf: Buffer, filename: string): Promise<void>;
}
```

`OpenWaGateway` implements it (HMAC-verified webhook, REST send). If the
number is ever banned or volume outgrows OpenWA, a `CloudApiGateway` is a
one-file swap. **No OpenWA type leaks past this interface.**

### B3. Conversation engine — menu-first, model-last

> Setup/wiring procedure for the local-model fallback in step 3 below:
> `docs/phase4-local-model-setup.md`.

A deterministic state machine per chat (`IDLE → BROWSING → BUILDING_ORDER →
AWAITING_CONFIRM → DONE/HANDED_OFF`), state in a local SQLite file on the
same volume. The happy path costs **zero** model calls:

1. Greeting → send the numbered price list (rendered from a cached
   `/agent/v1/catalog` pull, refreshed every few minutes).
2. Customer replies in the structured form (`2x4, 1x7` or "2 crates star") —
   a deterministic parser handles the numbered form and exact product-name
   matches, including unit words mapped to `product_units` names.
3. Parse success → availability check → **confirmation echo**:
   "2 CRATE Star Beer — ₵360.00, 1 PACK Voltic — ₵33.00. Total ₵393.00.
   Reply YES to confirm." Nothing proceeds without an explicit yes. With a
   small model this echo IS the safety mechanism, not politeness.
4. YES → `/orders/:id/confirm` → proforma PDF rendered **from the
   server-returned totals** (the agent never computes a price) → sent.

The LLM enters only when the parser fails: one tool-use call
(OpenAI-compatible endpoint, so Ollama-local and hosted models are a config
line apart), temperature 0, tools limited to `match_products(text)` and
`handoff()`, output schema-validated; any validation failure → handoff. The
dumber the model, the more the menu carries — that is the design, not a
compromise.

### B4. Handoff

Triggers: parser+model both fail, unrecognized product, any complaint
keyword, quantity above cap, availability UNKNOWN, or customer asks for a
human. Action: message the customer ("the shop will reply shortly"), notify
the owner's personal WhatsApp number via the same gateway, and **mute the
agent for that chat** until a human clears it (a flag in the state store).
Handoff rate is the primary health metric (§8).

### B5. Ops

- OpenWA session volume backed up (losing it = re-scanning the QR, not data
  loss — orders live centrally).
- Number discipline runbook in the repo README: dedicated order SIM (never
  the primary business number), reply-only (no broadcasts, no cold sends),
  two-week manual warm-up before enabling the agent, OpenWA rate limiting on.
- Structured logs; every order id traceable from WhatsApp message id →
  central order → (later) Counter sale id.

### B6. Tests (workstream B)

The parser is the riskiest pure code — table-driven tests over real message
shapes (numbered, name+unit words, mixed, garbage). Gateway adapter tested
against recorded OpenWA webhook fixtures (HMAC included). State machine
tested as pure transitions. One end-to-end script driving a fake gateway
through greet→order→confirm against the A-workstream staging function.

## 5. Workstream C — till integration (this repo, Phase 4b)

### C1. Local migration `0039_pending_orders.sql`

Local mirror of confirmed orders + fulfilment state:

```sql
CREATE TABLE pending_orders (
  id TEXT PRIMARY KEY,                    -- central orders.id
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','FULFILLED','CANCELLED')),
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  channel TEXT NOT NULL,
  total_pesewas INTEGER NOT NULL,
  quote_expires_at TEXT,
  lines_json TEXT NOT NULL,               -- [{productId, unitId, quantity, unitPricePesewas}]
  fulfilled_sale_id TEXT REFERENCES sales(id),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id TEXT NOT NULL,
  synced_at TEXT
);
```

Plus the outbox INSERT/UPDATE triggers (pattern of migration 0032) and the
table added to the whitelist in `src/main/sync/outbox.ts` — fulfilment then
flows up with zero new transport code (A5).

### C2. Pull worker

`src/main/sync/pull.ts` gains a second feed: `orders-feed` with its own
cursor in `state.ts`, applying rows by upsert into `pending_orders`. Same
retry/backoff as catalog.

### C3. Till UI

- Home screen badge: "N WhatsApp orders" (count of local CONFIRMED).
- `PendingOrdersScreen`: list → detail → **Ring it**. Prefill reuses the
  duplicate-as-new-sale mechanics (`cart.loadLines` + the reprice call), with
  one difference: quoted prices are loaded as-is first.
- **Price-drift handling** (the floor interplay): quotes were at list price,
  so normally the floor passes. If a price rose between quote and pickup,
  `completeSale` rejects the stale price — the screen catches the floor
  error and offers two honest paths: *reprice to today* (customer pays new
  price) or *honor the quote* (difference recorded as a discount, supervisor
  gate + audit apply, reason pre-filled `WHATSAPP_QUOTE_HONORED <order-id>`).
  Silent price drift is impossible by construction.
- On completion: mark `pending_orders` FULFILLED with the sale id (audit row
  `WHATSAPP_ORDER_FULFILLED`); the outbox carries it up; the agent (polling
  order status or nudged by a webhook later) messages the customer.
- VAT build note: the proforma is **not** a tax invoice; the fiscal record
  remains the receipt printed at sale time. One line on the proforma states
  this.

### C4. Tests (workstream C)

Same harness as the rest of the suite: pull-apply upsert test, fulfilment
outbox row test, and an integration test — pending order → prefilled cart →
`completeSale` → floor-rejection path when list price raised → discount path
honors quote with supervisor PIN.

## 6. Availability honesty rules (shared contract)

The availability verdict is computed centrally (A4) and rendered by the
agent verbatim:

```
fresh   = now - shops.last_seen_at < FRESH_WINDOW   (default 2h)
covered = on_hand >= qty_canonical + BUFFER          (default: product's
          reorder_threshold, min 1 crate-equivalent)

fresh && covered      → IN_STOCK   "available"
fresh && !covered     → LOW        "only N left — shop will confirm"  (handoff)
!fresh                → UNKNOWN    "let me confirm with the shop"     (handoff)
```

The agent promises what the mirror knows and hedges what it doesn't. Both
constants are per-company config, not code.

## 7. Sequencing and milestones

| # | Milestone | Depends on | Done when |
|---|---|---|---|
| M1 | Central slice: `agents`, orders schema, stock view, `agent` fn, provisioning script | — | lifecycle curl script green on staging |
| M2 | Agent skeleton: repo, compose (OpenWA+agent), gateway adapter, webhook in / send out | — (parallel with M1) | echo bot on the warmed-up test number |
| M3 | Order flow end-to-end (Phase 4a live): menu, parser, confirm gate, proforma PDF, handoff | M1+M2 | real order placed by a test customer; shop re-keys manually |
| M4 | Model fallback: LLM behind the parser, schema validation, handoff on failure | M3 | wrong-parse rate measured on 50 real messages |
| M5 | Till integration (Phase 4b): 0039, pull feed, screen, fulfilment up | M1, Counter release train | order rung from the queue; customer notified; audit trail complete |
| M6 | Pilot review | M3 (or M5) | two weeks on one shop; metrics reviewed (§8); go/no-go on wider rollout |

M1–M4 never block on a Counter release; M5 ships as an ordinary tagged
release when ready.

## 8. Metrics (pilot exit criteria)

- **Handoff rate** — target < 40% in week two (menu design is working).
- **Wrong-parse rate** — confirmed orders later disputed at pickup; target ~0
  (the confirm echo should make this structural).
- **Quote→fulfilment conversion** and time-to-fulfil.
- **Mirror accuracy** — orders confirmed IN_STOCK that the shop couldn't
  fill; tunes `BUFFER`/`FRESH_WINDOW`.

## 9. Risks

| Risk | Mitigation |
|---|---|
| WhatsApp bans the number (unofficial client) | dedicated SIM, reply-only, warm-up, rate limits; gateway adapter makes Cloud API a one-file swap; orders/customers live centrally so nothing is lost with the number |
| Small model misparses an order | menu-first flow (model rarely runs), temperature 0 + schema validation, confirm-before-invoice gate, handoff on any doubt |
| Stock mirror stale → overpromise | §6 verdict rules; LOW/UNKNOWN always hand off |
| Price changes between quote and pickup | till price floor rejects stale price; explicit reprice-or-discount choice, audited |
| OpenWA server compromise (holds a live WA session) | dashboard unpublished, API on compose network only, HMAC webhooks, dedicated number limits blast radius |
| `/agent` endpoint abuse | token sha256 + revocation, per-agent rate limits, payload caps, RLS default-deny beneath everything |

## 10. Decisions needed before M1 (owner input)

1. Which branch fulfils WhatsApp orders in the pilot (v1 hardcodes one
   `shop_id` per agent config).
2. Channel pricing for WhatsApp orders: `WALK_IN` or `WHOLESALE`?
3. Quote validity window (proposal: 48h).
4. The dedicated order number (new SIM) and the owner's handoff number.
5. Languages the menu ships in (English only vs English+Twi).
