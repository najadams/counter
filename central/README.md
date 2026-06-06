# Counter — central sync store

The hub for multi-shop sync (Phase 3). Each shop sells offline against its own
SQLite and ships its activity **up** here; HQ's catalog/prices/roster flow
**down** to the shops. This is a downstream aggregate — **never** the system of
record. See [`../docs/phase3-network-and-sync.md`](../docs/phase3-network-and-sync.md) §B6 for the design.

It speaks the exact wire contract the shop already uses
([`../src/main/sync/httpTransport.ts`](../src/main/sync/httpTransport.ts)), so it
is a drop-in replacement for the dev `scripts/central-stub.ts` — point a shop's
`central_url` at this and it just works.

## Endpoints

| Method & path | Auth | Body / query | Returns |
|---|---|---|---|
| `POST /ingest` | `Bearer <token>` | `{ shopId, rows: [{ seq, table, op, data }] }` | `{ ackedSeq }` — highest **gap-free** seq for the shop |
| `GET /catalog` | `Bearer <token>` | `?since=<cursor>&limit=<n>` | `{ rows: [{ cursor, table, data }], cursor }` |
| `GET /health` | — | — | per-shop last-seen + seq-gap dashboard |
| `GET /` | — | — | liveness |

How it differs from the stub (and why): real per-shop **token auth** (the stub
trusts anyone), **gap-aware ack** (never acks past a seq it is missing, so a
lost batch is re-sent, not dropped), real **upserts** so HQ master `UPDATE`s
propagate, and durable Postgres storage with seq-hole detection.

## Quick start (local)

```bash
cd central
npm install
docker compose up -d                      # local Postgres on :5432
cp .env.example .env                       # DATABASE_URL points at that Postgres
npm run migrate                            # apply schema (idempotent)
npm run shop:add -- --id hq  --name "HQ" --hq    # mint HQ token  (prints once)
npm run shop:add -- --id osu --name "Osu Counter" # mint a shop token (prints once)
npm run dev                                # server on :4500
```

Then on the shop, under **Settings → Sync**, set the central URL
(`http://<host>:4500`) and paste that shop's token.

## Provisioning & revoking shops

```bash
npm run shop:add -- --id osu --name "Osu Counter"   # new shop, prints token once
npm run shop:add -- --id osu --revoke               # revoke (token stops working)
npm run shop:add -- --id osu --name "Osu"           # re-run rotates the token
```

Only the sha256 **hash** of each token is stored; the plaintext is shown once.

## Configuration

See [`.env.example`](.env.example). `DATABASE_URL` works with any Postgres —
local docker, or a managed host (Supabase / Neon / RDS), or a VPS. TLS is best
terminated at a reverse proxy; set `CENTRAL_TLS_KEY`/`CENTRAL_TLS_CERT` to have
the server speak HTTPS directly.

## Tests

The contract tests run against a real Postgres (they migrate + truncate, so use
a throwaway DB). With no `DATABASE_URL` they **skip**, so `npm test` stays green
anywhere:

```bash
docker compose up -d
DATABASE_URL=postgres://counter:counter@localhost:5432/counter_central npm test
```

## Production notes

```bash
npm run build && cp src/schema.sql dist/   # compile; migrate.ts reads schema.sql beside itself
DATABASE_URL=... npm run start:prod
```

- Connections always originate from the shop; central never dials out (shops sit
  behind NAT). Expose only `:4500` (or the proxy) and require HTTPS for traffic
  leaving the building.
- `sync_ingest_log` is the durable proof of each shop's contiguous stream and is
  never pruned. `ingested_rows`/`catalog` are the reporting + distribution views.

## Not yet built (scaffold boundaries)

- **Typed reporting tables.** Events land in a generic `ingested_rows(jsonb)`
  union, not per-table mirrors — enough for storage + a consolidated dashboard
  query, but a reporting layer (revenue/stock by shop) is a follow-up.
- **Owner web dashboard.** `/health` is JSON; no UI yet.
- **Open design questions** (`customers` ownership, inter-shop transfers,
  hosting) — see design §B14.
