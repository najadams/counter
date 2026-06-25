# Counter central sync store (Supabase)

This is the **central / HQ side** of Phase 3 sync. The shop side is already built
(`src/main/sync/*`): each shop drains its append-only `sync_outbox` and pushes
`PushBatch` to `<central_url>/ingest`, expecting `{ ackedSeq }` back. This folder is
the thing that receives those batches.

Status: **push-only first slice.** `ingest` stores events UP; `catalog` (master
data DOWN to shops) is a stub that returns an empty page. Nothing here is deployed
yet — it deploys into a **dedicated Counter Supabase project** (do NOT reuse a
project that hosts another app).

## What's here

- `migrations/20260625000001_central_sync.sql` — `shops` (per-shop token hash +
  ack high-water) and `shop_events` (the append-only union, idempotent on
  `(shop_id, table_name, row_id)`). RLS is ON with **no policies** — only the
  service-role Edge Functions touch these tables.
- `functions/ingest/` — `POST` PushBatch → `{ ackedSeq }`. Per-shop bearer-token
  auth (sha256 of the token, matched against `shops.token_hash`); the token's
  shop must equal the batch's `shopId`. Idempotent upsert.
- `functions/catalog/` — `GET ?since&limit` → `{ rows, cursor }`. Stub (empty)
  until the catalog-down slice is built.
- `functions/_shared/auth.ts` — token hashing + shop lookup.

## Deploy (once a dedicated project exists)

1. Create a new Supabase project for Counter and point the CLI / MCP at it.
2. Apply the migration (`supabase db push`, or the MCP `apply_migration`).
3. Deploy both functions **with JWT verification OFF** — they do their own
   per-shop token auth, they are not called with a Supabase JWT:
   ```
   supabase functions deploy ingest  --no-verify-jwt
   supabase functions deploy catalog --no-verify-jwt
   ```
4. Register each shop and hand it a token (run in the SQL editor):
   ```sql
   select register_shop('OSU', 'Osu branch', '<generate-a-long-random-token>');
   ```
   Keep the token secret; only its sha256 hash is stored.
5. On that shop: **Settings → Sync** →
   - shop_id: `OSU`
   - central_url: `https://<project>.supabase.co/functions/v1/`  (trailing slash)
   - token: the token from step 4

The shop's push worker starts on next boot and drains its outbox. Re-sends are
idempotent; the shop keeps selling whether or not the central store is reachable.

## Security

- Real sales/customer data leaves the building here. The transport is HTTPS to
  Supabase. Each shop has its own revocable token (`register_shop` again rotates
  it). The central never dials into shops.
- RLS-on/no-policies means the public REST API exposes nothing; only the
  service-role functions read/write. Run `get_advisors(security)` after deploy.

## Not built yet (next slices)

- `catalog` real implementation (master data DOWN): serve HQ-owned
  `SYNCED_MASTER_TABLES` ordered by a central cursor.
- A `register`/provisioning endpoint (today registration is a SQL call).
- Per-shop sequence-gap alerting on the central side.
