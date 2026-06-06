# Counter — Phase 3: network sharing & multi-location sync (design)

**Status:** design only. Nothing here ships yet. This doc records the plan so
the schema decisions already baked into the single-shop build (every table
carries `device_id` and a nullable `synced_at`; `sales` carries `location_id`;
all PKs are UUID `TEXT`) stay coherent as we grow to many shops.

**Audience:** whoever implements Phase 3. Companion to the operator runbook
(`CLAUDE.md` §9 LAN access, §10 multi-location).

## Goals

- Multiple devices inside one shop (already shipped in `feat/network-transport`
  — see §9). Phase 3a only polishes the join/UX/resilience.
- Multiple shops, each fully operational **offline**, syncing asynchronously to
  a central store so the owner gets consolidated reporting and a single catalog.

## Non-goals (v1)

- A central database as the *system of record*. Internet in Ghana is not
  reliable enough to gate selling on it — a shop must keep ringing sales when
  the line is down. The central store is a downstream aggregate, never the
  authority for live operations.
- Real-time cross-shop consistency. Sync is eventual; seconds-to-hours of lag is
  fine.
- Cross-shop customer credit identity (one customer owing money across shops).
  Flagged as an open question, not built.
- Peer-to-peer shop-to-shop links. Topology is strictly hub-and-spoke
  (shops <-> central).

---

# Part A — Phase 3a: in-shop polish (LAN)

Small, independent improvements to the LAN transport that already exists. Ship
these first; none depends on the sync work.

## A1. QR-code to join

**Problem.** Typing `http://192.168.1.20:4317` on a phone is the worst part of
the flow.

**Approach.** `src/main/http/server.ts` already computes reachable LAN addresses
(`lanAddresses()`) and logs them. Surface them to the renderer over a new IPC
channel (e.g. `NET_LAN_URLS`) and render the best URL as a QR on the host home
screen. Cashiers scan and go.

**Implementation sketch.**
- Main: add a handler returning `{ urls: string[], mdns?: string }` built from
  `lanAddresses()` + the bound port (and the `counter.local` name from A2).
- Renderer: render the QR with a tiny generator (`qrcode`), client-side, no
  network. Show it only when the server is LAN-exposed (`COUNTER_HTTP_HOST`
  is `0.0.0.0`).

**Effort:** small. Reuses existing code.

## A2. Stable address via mDNS (`counter.local`)

**Problem.** The LAN URL breaks when DHCP hands the host a new IP.

**Approach.** Advertise the HTTP service over mDNS/Bonjour on server start when
LAN-exposed, so phones can use `http://counter.local:4317` regardless of IP.

**Implementation sketch.**
- Publish with `bonjour-service` (or `ciao`) from `startHttpServer()` when
  `host` is `0.0.0.0`; unpublish on `server.close`.
- Feed the `counter.local` URL into the A1 QR as the preferred address.

**Caveats.**
- Android browser `.local` resolution is historically spotty; iOS/macOS are
  fine. Keep the IP-based QR as the robust fallback.
- A Windows host needs an mDNS responder. Apple's Bonjour service is frequently
  already present (many printer drivers install it); document this in the
  runbook.

**Effort:** small-medium.

## A3. Persist sessions across host restart

**Problem.** `src/main/ipc/session.ts` keeps bearer tokens in an in-memory
`Map`, so a host reboot logs every device out. Ghana's load-shedding makes
mid-shift reboots routine, so this bites daily.

**Approach.** Back the token store with SQLite, keeping the existing idle (2h)
and absolute (12h) caps. On boot, load the non-expired tokens; on
mint/revoke/refresh, write through. Keep the in-memory map as the hot path and
the table as durable backing.

**Schema (migration `0031` or later).**
```sql
CREATE TABLE auth_tokens (
  token      TEXT PRIMARY KEY,                 -- opaque random (randomUUID)
  worker_id  TEXT    NOT NULL REFERENCES workers(id),
  full_name  TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,                 -- remote device the token was issued to
  created_at INTEGER NOT NULL,                 -- epoch ms; absolute-age cap
  last_seen  INTEGER NOT NULL                  -- epoch ms; idle cap
);
CREATE INDEX idx_auth_tokens_lastseen ON auth_tokens(last_seen);
```

**Notes.**
- The token is now a bearer secret at rest. That is the same trust level as the
  DB already holds (PIN hashes, all sales) — acceptable.
- To avoid a DB write on every request, throttle `last_seen` persistence (e.g.
  only persist when >60s since the last persisted value); the in-memory map
  still tracks exact last-seen for expiry.
- Sweep expired rows on the same timer that already sweeps the rate limiter.

**Effort:** small-medium. Touches `mintToken`/`resolveToken`/`revokeToken` plus
one migration. The transport code above it is unchanged.

## A4. TLS without cert pain

**Problem.** Self-signed certs with IP SANs must be installed on every phone and
still throw browser warnings, so in practice operators run plain HTTP.

**Position.** Don't chase LAN TLS. For in-shop traffic on a trusted private
access point the threat is low; the high-value encryption need is anything
*leaving the building*, which Part B routes over real HTTPS to the central host
(a cloud machine with a real CA cert) — sidestepping the self-signed problem
entirely.

**Guidance.**
- Lock down the AP: WPA2/WPA3, unique password, no open guest network.
- If a shop insists on LAN TLS, a `mkcert`-style local CA (install the CA once
  per device, then `counter.local` gets a trusted cert — pairs with A2) is less
  painful than per-IP self-signed certs. Optional helper script; not core.

**Effort:** mostly documentation + AP guidance.

---

# Part B — multi-location sync

## B1. Architecture decision

Each shop is one Counter install = one local SQLite DB = one receipt printer,
exactly as today. It serves its own LAN devices (Part A / §9) and **never**
depends on the internet to sell. A background sync worker moves data
asynchronously to/from a central store when a connection is available.

Rejected alternative: shops as thin clients of a central DB. That makes a shop
with no internet a shop that can't sell — unacceptable here — and throws away
the offline-first design we already have.

## B2. Data classification — the move that removes conflict resolution

Split every table by *who writes it*. This is what lets us avoid CRDTs and
merge logic entirely.

**Bucket 1 — append-only event data (push UP, never edited).** No two shops ever
write the same row, so there is nothing to merge. UUID PKs mean no cross-shop PK
collision.

> sales, sale_lines, sale_payments, stock_movements, breakage_log,
> worker_consumption_log, audit_log, customer_payments,
> customer_payment_allocations, supplier_payments,
> supplier_payment_allocations, purchase_orders, purchase_order_lines,
> cash_counts, shifts, stocktake_events, stocktake_lines, period_closes,
> petty_cash_expenses, container_movements, customer_returns,
> customer_return_lines, route_runs, route_stops, daily_summaries

**Bucket 2 — HQ-owned master data (pull DOWN, single writer = HQ).** The owner
maintains one catalog/price book; shops consume it read-mostly. A single writer
means there is no conflict to resolve.

> products, product_units, pricing_tiers, promotions, suppliers, locations,
> payment_methods, routes, route_customer_links, reason_codes,
> deletion_reasons

**Bucket 3 — partly decided.** `customers` and `customer_price_overrides`
remain open: shop-owned (push up) or HQ-owned (pull down)? That choice affects
credit identity across shops. `workers` is **decided — HQ-owned, flows down**
(migration 0034): PINs/roles/recovery are managed centrally, and crucially the
roster arriving first is what lets HQ-authored catalog rows (which reference
`workers(id)`) apply on a shop. Roster sync is additive (upsert by id); a
shop's first-run OWNER and any shop-local accounts are never deleted.

## B3. Change tracking — outbox + watermark

Incremental sync needs "what changed here since I last synced, and in what
order." Use a single **outbox** table fed by triggers, rather than relying on
`synced_at IS NULL`.

**Why an outbox beats `synced_at`:**
- Captures **order**, so the central store can apply rows in an FK-safe sequence.
- Captures **UPDATEs** to already-synced master rows (a plain `synced_at` flag
  can't represent "changed again").
- Gives **gap detection** for free: the seq is monotonic and never reused, so a
  hole in the seq stream central received from a shop = missing data (itself a
  shrinkage signal, which is the app's whole reason to exist).
- Keeps event rows **immutable** — we never rewrite `synced_at` on a posted sale.

**Migration `0031_sync_outbox.sql`.**
```sql
CREATE TABLE sync_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- strictly increasing, never reused
  table_name  TEXT    NOT NULL,
  row_pk      TEXT    NOT NULL,                    -- the row's TEXT/UUID id
  op          TEXT    NOT NULL CHECK (op IN ('INSERT','UPDATE')),
  enqueued_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acked_at    TEXT                                  -- set once central confirms
);
CREATE INDEX idx_outbox_unacked ON sync_outbox(seq) WHERE acked_at IS NULL;
```

> `AUTOINCREMENT` is deliberate: plain `rowid` can be **reused** after deletes,
> which would break gap detection. `AUTOINCREMENT` never reuses a value.

**Triggers (generated from the Bucket 1 / Bucket 2 lists).** Event tables
enqueue on INSERT only; master tables enqueue on INSERT and UPDATE. Examples:
```sql
-- Bucket 1: insert-only
CREATE TRIGGER trg_outbox_sales_ins AFTER INSERT ON sales BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('sales', NEW.id, 'INSERT');
END;

-- Bucket 2: insert + update (HQ side; on shop side these are applied, see B5)
CREATE TRIGGER trg_outbox_products_ins AFTER INSERT ON products BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('products', NEW.id, 'INSERT');
END;
CREATE TRIGGER trg_outbox_products_upd AFTER UPDATE ON products BEGIN
  INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('products', NEW.id, 'UPDATE');
END;
```

**Watermark + cursors (migration, same file).**
```sql
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,    -- 'push_last_acked_seq', 'pull_last_cursor', ...
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

> **Foundation scope (built in migration `0032`):** the outbox, `sync_state`,
> and the INSERT triggers exist for the append-only **event** tables only.
> Master-table capture is intentionally deferred to 3c, where it ships with
> the HQ/shop role flag and an *applying-remote* guard — otherwise a shop
> would re-enqueue (and push back up) the catalog edits it just pulled down.

## B4. Shop identity — why there is NO `shop_id` column locally

Every row in shop X's database belongs to shop X by definition, so we do **not**
add a `shop_id` column to ~30 local tables. The only place shop identity lives
locally is `device_config` (the existing KV store):

| key             | meaning                                                     |
|-----------------|-------------------------------------------------------------|
| `shop_id`       | stable UUID for this install (issued at provisioning)       |
| `shop_code`     | short human code, e.g. `OSU`, `MADINA`                      |
| `central_url`   | base URL of the central sync endpoint                       |
| `central_token` | per-shop bearer credential for the central endpoint         |

The central store stamps `shop_id` on every row at ingest — it knows which
shop's outbox it authenticated as. This keeps the local migration tiny (one new
table + triggers, zero `ALTER`s on existing tables).

## B5. Sync worker

**Push (up).** When online:
1. Read `shop_id` / `central_url` / `central_token` from `device_config`.
2. `SELECT * FROM sync_outbox WHERE acked_at IS NULL ORDER BY seq LIMIT <batch>`.
3. Hydrate each referenced row from its table.
4. `POST central_url/ingest` with `{ shop_id, rows: [{ seq, table, op, data }] }`.
5. Central upserts by `(shop_id, id)` (idempotent), records the max contiguous
   seq, returns `acked_seq`.
6. `UPDATE sync_outbox SET acked_at = now() WHERE seq <= acked_seq`.
7. Backoff and repeat. Re-sending is always safe (idempotent), so a dropped
   connection mid-batch just re-sends.

**Pull (down, master data).** When online:
1. `GET central_url/catalog?since=<pull_last_cursor>`.
2. Apply rows by upsert on PK; HQ is the authority (last writer = HQ).
3. Advance `pull_last_cursor`.
4. At non-HQ shops, the UI **disables** editing Bucket 2 tables (or queues
   edits as change-requests to HQ) so the one-writer rule holds.

## B6. Central store (Postgres)

Mirror each synced table, add `shop_id`, and make the PK composite so ingest is
idempotent and "which shop" is free:
```sql
CREATE TABLE sales (
  shop_id     text NOT NULL,
  id          text NOT NULL,             -- the shop's local UUID
  location_id text,
  -- ... mirror of the SQLite columns; money stays bigint pesewas ...
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)              -- idempotent upsert target
);

CREATE TABLE sync_ingest_log (
  shop_id     text   NOT NULL,
  seq         bigint NOT NULL,
  table_name  text   NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, seq)             -- MAX(seq) + hole detection per shop
);
```

**Idempotency / money safety.**
- Events: `INSERT ... ON CONFLICT (shop_id, id) DO NOTHING` — immutable, so a
  double-send cannot double-count revenue.
- Master: `... DO UPDATE` — HQ edits propagate.
- The composite `(shop_id, id)` PK removes even the astronomically unlikely
  cross-shop UUID collision.
- Money stays integer pesewas, stock stays canonical units, in the JSON payload.
  No float anywhere on the wire.

## B7. Inter-shop stock transfers

Model a transfer as two **paired append-only** movements, linked by a shared
`transfer_id` minted by the initiating shop:
- Shop A: a `stock_movements` (or `container_movements`) row, out, with
  `transfer_id` and counterparty = B.
- Shop B: a matching row, in, same `transfer_id`.

Each shop authors its own leg, so there is still no conflict; central links the
two by `transfer_id`. Implementation choice (Open question): carry
`transfer_id`/counterparty in the existing `notes`/metadata to avoid schema
churn, or add a small `stock_transfers` table.

## B8. Transport & security

- Shop -> central over **HTTPS**. TLS terminates at central (a real cloud host
  with a real CA cert), which is what makes A4 a non-issue for cross-site data.
- Per-shop **bearer credential** (`central_token`), revocable per shop. Bind the
  `shop_id <-> token` mapping server-side so a leaked token from shop A can't
  impersonate shop B.
- Central is **pull/push only**; it never dials into shops (they sit behind NAT
  with no inbound). All connections originate from the shop.

## B9. Provisioning a new shop

1. Install Counter; run the first-run wizard (creates the local OWNER as today).
2. Owner enters `shop_code` + `central_url` + `central_token` under
   Settings -> Sync.
3. App registers with central on first handshake; central issues (or confirms)
   `shop_id`, stored in `device_config`.
4. Initial catalog pull seeds Bucket 2 tables (products, prices, workers).
5. Background sync starts.

## B10. Sync health (mirror the backup heartbeat, runbook §4)

- `sync_state` records last successful push and pull timestamps.
- Home-screen banner when sync is stale: warning >24h, danger >72h — the same
  pattern as the backup banner, dismissible with "remind tomorrow."
- Central dashboard shows per-shop last-seen and **seq-gap detection**
  ("shop 3: up to seq 4012, seen 2h ago, no gaps"). A gap is a missing-data /
  shrinkage signal.

## B11. Reporting

- Central Postgres is the consolidated reporting store; the owner dashboard
  (web) reads it — revenue by shop, stock by shop, cross-shop audit.
- Per-shop local reports keep working offline against the local DB, unchanged.

## B12. Failure modes

- **Shop offline for days:** outbox grows, every sale still completes, drains on
  reconnect.
- **Central down:** pushes retry; shops unaffected.
- **Double-send:** idempotent upsert; no double-count.
- **Clock skew between shops:** ordering uses the monotonic `seq`, never
  timestamps.
- **Outbox growth:** prune `acked_at` rows older than a retention window (e.g.
  14 days, mirroring the backup roll); central holds the durable copy.

## B13. Phasing

- **3a** — in-shop polish (Part A). Small; ship first, independent of sync.
- **3b** — push + central store + read-only consolidated reporting. ~80% of the
  value ("owner sees all shops").
- **3c** — pull (HQ catalog/price/worker distribution; stop maintaining the
  catalog N times).
- **3d** — inter-shop transfers.

## B14. Open questions

- `customers` / `workers` ownership (Bucket 2 vs 3) — drives cross-shop credit
  identity. Catalog rows carry `created_by`/`updated_by` -> `workers(id)`, so a
  shop can only apply an HQ-authored catalog row if that worker exists locally.
  **Resolved for workers:** the roster syncs HQ->shop (migration 0034, option
  a), and the global pull cursor delivers a worker before the catalog rows that
  reference it, so apply succeeds. `customers`/`customer_price_overrides` stay
  open. Provisioning follow-up: reconcile each shop's first-run OWNER with the
  central roster (today both coexist; ids never collide).
- `shop_id` issuance: app-generated vs central-issued at handshake.
- Transfer modeling: reuse `stock_movements` + metadata vs a new
  `stock_transfers` table.
- Central hosting: managed Postgres (Supabase/Neon) vs a small VPS vs a machine
  at the main "HQ" shop.
