# Autonomous Wholesale Compatibility Audit

Date: 2026-07-14  
Repository: `/Users/a./Projects/counter`  
Scope: static repository inspection plus safe validation commands. No production code was modified.

## 1. Executive Summary

Counter is **partially compatible and requires major architectural work** before it can become an autonomous transaction-truth, dispatch-verification, computer-vision-assisted wholesale operating system.

Estimated readiness: **58%**

The strongest foundation is the existing local-first retail core: SQLite with WAL and foreign keys, integer pesewa money, append-oriented stock movements, atomic sale completion, split tenders, credit ledgers, cash close, audit logging, stocktake, customer returns, supplier invoices, and a real Supabase-backed multi-tenant sync layer. This is more than a cashier screen. It already behaves like an evidence-producing POS with anti-shrinkage instincts.

The main blocker is not UI polish. The blocker is that the application does **not yet have a single immutable business event ledger, observation/evidence model, or exception workflow** that can correlate human actions, inventory movements, payments, camera observations, delivery state, and supervisor decisions into one authoritative truth graph. Some operations are additive and well-audited; others still mutate operational tables in place or rely on app-level discipline rather than database-enforced immutability.

The future autonomous system should be built as an extension of the current architecture, not as a rewrite. The current service layer, shared IPC/HTTP RPC surface, sync outbox, central edge functions, role gates, and transaction boundaries are useful structural anchors. The recommended path is to add a separate event/observation/exception layer, then route high-value workflows such as dispatch verification through it.

Top 10 first tasks:

1. Add a local immutable `business_events` ledger with correlation IDs, idempotency keys, actor, device, location, source, and causation links.
2. Add `observations`, `observation_media`, and `observation_links` tables for camera/OCR/barcode/manual evidence.
3. Add an `exceptions` workflow table with severity, status, assignment, evidence links, comments, and resolution events.
4. Add local idempotency keys to sale, stock, return, payment, order, and dispatch commands.
5. Model dispatch explicitly: pick, pack, verify, load, depart, deliver, fail, return.
6. Add stock reservation and goods-in-transit ledgers for orders and dispatch.
7. Make audit coverage systematic, including stocktake draft counts, customer price overrides, container movements, and all admin mutations.
8. Add external payment reconciliation imports for MoMo/bank references, duplicates, and settlement matching.
9. Add edge-device security: signed observation payloads, device registry, replay windows, and HTTPS requirement for autonomous devices.
10. Pilot camera-assisted dispatch verification without blocking sales: compare packed items against confirmed order and create exceptions only.

## 2. Current Application Architecture

### Runtime Shape

Counter is an Electron + React + SQLite application with a local-first architecture.

Evidence:

- `package.json:1-4` identifies the app as `counter`, version `0.2.4`.
- `package.json:13-25` defines core workflows: `dev`, `build`, `db:reset`, `test`, and `typecheck`.
- `package.json:45-58` shows runtime dependencies including `better-sqlite3`, `electron-log`, `node-thermal-printer`, `react`, `recharts`, `zustand`, `uuid`, `bonjour-service`, and `qrcode.react`.
- `package.json:59-78` shows Electron, Vite, TypeScript, Vitest, and electron-builder.
- `vite.config.ts:1-3` uses Vite, React, and `vite-plugin-electron`.
- `vite.config.ts:15-18` injects build flags `__COUNTER_VAT__` and `__COUNTERS_DECOY__`.
- `vite.config.ts:30-55` configures Electron main, preload, and renderer builds.

### Main Process and Handler Registry

The main process owns the database, migrations, service registration, HTTP server, and sync workers.

Evidence:

- `src/main/index.ts:85-130` imports the database, migrations, handlers, sync services, and HTTP server, then resolves DB and migration paths and runs migrations.
- `src/main/index.ts:133-154` initializes the device ID and durable session token store.
- `src/main/index.ts:176-207` registers many IPC handlers through `HandlerRegistry`.
- `src/main/index.ts:209-236` starts the embedded HTTP/LAN server when configured.
- `src/main/index.ts:238-250` starts background push, pull, and order workers when the shop is provisioned.
- `src/main/ipc/registry.ts:1-8` describes the registry as the way to register IPC handlers while teeing the same handlers to HTTP.
- `src/main/ipc/registry.ts:17-32` stores handlers in a map and guards duplicate registration.

### Renderer and API Surface

The renderer calls one shared Counter API surface. The same command vocabulary is available through Electron IPC and the optional LAN HTTP server.

Evidence:

- `src/main/preload.ts:1-16` exposes `window.counter` via `createCounterApi`.
- `src/shared/counterApi.ts:1-10` says the file is the single source of truth for the Counter RPC surface shared by IPC and HTTP.
- `src/shared/counterApi.ts:23-260` exposes authentication, shifts, sales, voids, breakage, stock receipts, stocktake, reports, cash drops, workers, products, suppliers, receipt config, sync, and pending-order operations.
- `src/main/http/server.ts:159-218` dispatches HTTP API calls into the same registered handlers.

### Data Layer

The local database is SQLite through `better-sqlite3`. The app uses migrations and explicit transaction blocks for important workflows.

Evidence:

- `src/main/db/connection.ts:24-42` creates a singleton connection, enables WAL, foreign keys, and a busy timeout.
- `src/main/db/migrations.ts:25-75` applies SQL migrations transactionally with checksums.
- `migrations/0004_operational.sql:49-84` defines `stock_movements` as the single source of inventory with signed quantities and an instruction not to update rows.
- `migrations/0009_audit_reporting.sql:9-24` defines an append-style `audit_log` table with JSON before/after values and no updated columns.
- `migrations/0032_sync_outbox.sql:23-40` defines a `sync_outbox` and `sync_state` for central synchronization.

### Deployment and Build

The project already treats deployment seriously: Electron installers, native module caveats, platform-specific builds, and VAT/no-VAT variants are documented and automated.

Evidence:

- `package.json:83-202` contains electron-builder configuration, ASAR settings, unpacking for `better-sqlite3`, and platform targets.
- `.github/workflows/release.yml:25-61` defines a three-OS by two-variant matrix.
- `.github/workflows/release.yml:83-90` runs `npm ci` and typecheck.
- `.github/workflows/release.yml:91-147` builds installers, including a macOS retry path.
- `.github/workflows/release.yml:180-215` publishes release metadata and notes the unsigned installer behavior and VAT/no-VAT variants.

### Architecture Map

```text
React renderer / LAN browser
  -> window.counter / HTTP POST /api/:channel
  -> HandlerRegistry shared IPC handlers
  -> main-process services
  -> SQLite migrations and operational tables
  -> printer, photos, backups
  -> sync_outbox triggers
  -> sync workers
  -> Supabase Edge Functions
  -> central shop_events, catalog, orders, agents
```

## 3. Current Feature Inventory

### POS and Sales

Implemented:

- Atomic sale completion with sale header, lines, payments, stock movements, receipt, and audit.
- Split tender support through `sale_payments`.
- Cash, MoMo, bank transfer, and credit payment methods.
- VAT-inclusive extraction in VAT builds.
- Sale void as reversal rather than deletion.
- Additive sale correction as void plus re-ring plus bidirectional links.
- Receipt reprint queue on print failure.

Evidence:

- `migrations/0004_operational.sql:97-132` defines `sales`.
- `migrations/0004_operational.sql:146-165` defines `sale_lines`.
- `migrations/0019_sale_payments.sql:18-33` defines split tender rows and notes the service-level invariant that tenders sum to the sale total.
- `src/main/services/sales.ts:1-6` describes sale completion as safety-critical and atomic.
- `src/main/services/sales.ts:198-230` starts the synchronous atomic sale core.
- `src/main/services/sales.ts:272-280` requires MoMo tender references.
- `src/main/services/sales.ts:283-291` routes credit sales through customer state.
- `src/main/services/sales.ts:343-465` resolves product units, canonical quantity, list price, tiers, overrides, and price floors.
- `src/main/services/sales.ts:476-486` computes VAT-inclusive tax components.
- `src/main/services/sales.ts:531-552` validates tender sums.
- `src/main/services/sales.ts:557-570` checks credit limits against true balance.
- `src/main/services/sales.ts:605-722` inserts sales, sale payments, sale lines, and stock movements in one transaction.
- `src/main/services/voids.ts:1-7` states that voids mark a sale voided and append reversal movements instead of deleting.
- `src/main/services/voids.ts:138-208` creates reversal movements, reverses credit, updates void fields, and audits.
- `src/main/services/correctSale.ts:1-18` documents the additive-only correction model.
- `src/main/services/correctSale.ts:136-194` voids the original sale, re-rings the corrected sale, links them, purges stale reprints, and writes `SALE_CORRECTED`.
- `migrations/0036_sale_correction.sql:13-17` adds sale supersession links.

### Inventory

Implemented:

- Stock movements as inventory truth.
- Canonical units and product units.
- Opening stock and stock receiving.
- Stocktake drafts and variance movements.
- Breakage with photo evidence.
- Customer returns.
- Worker consumption.
- Returnable container/empties tracking.
- Negative stock reporting.

Evidence:

- `migrations/0004_operational.sql:49-84` defines signed stock movements.
- `migrations/0015_units.sql:1-13` introduces canonical units and unit conversion.
- `migrations/0015_units.sql:21-39` defines product units.
- `src/main/services/stockMovements.ts:1-6` says `insertStockMovement` is the sanctioned way to write movement rows.
- `src/main/services/stockMovements.ts:56-157` validates quantity, reason code, photo requirements, supervisor requirements, signed direction, and inserts the movement.
- `src/main/services/stockMovements.ts:159-174` calculates on-hand stock as `SUM(quantity)`.
- `src/main/services/stockReceipts.ts:136-180` converts receipt units to canonical stock and validates line totals.
- `src/main/services/stockReceipts.ts:256-282` writes receiving movements.
- `src/main/services/stocktake.ts:44-58` snapshots expected quantity and cost for stocktake.
- `src/main/services/stocktake.ts:299-378` emits variance movements and completes the stocktake.
- `src/main/services/breakage.ts:1-4` requires a photo for every breakage event.
- `src/main/services/breakage.ts:48-155` saves the photo, inserts the breakage movement, logs breakage, and audits.
- `src/main/services/customerReturns.ts:154-201` inserts return records and stock movements.
- `src/main/services/consumption.ts:87-198` records worker consumption, splits free versus paid consumption, writes stock movements, and audits.
- `src/main/services/empties.ts:1-18` describes customer and depot container movement tracking.
- `src/main/services/exceptionReports.ts:250-268` reports negative stock and notes that sales deliberately do not block on stock.

### Purchasing, Supplier Accounting, and Replenishment

Implemented:

- Suppliers and products.
- Purchase orders and purchase order lines.
- Supplier payments and allocations.
- Supplier invoices and invoice lines.
- Simple reorder suggestions and draft PO creation.

Evidence:

- `migrations/0007_purchasing.sql:8-34` defines purchase orders.
- `migrations/0007_purchasing.sql:39-59` defines purchase order lines.
- `migrations/0007_purchasing.sql:65-81` defines supplier payments.
- `migrations/0007_purchasing.sql:84-98` defines supplier payment allocations.
- `migrations/0041_drawings_supplier_invoices.sql:62-82` defines supplier invoices.
- `migrations/0041_drawings_supplier_invoices.sql:88-104` defines supplier invoice lines.
- `migrations/0041_drawings_supplier_invoices.sql:110-123` defines supplier invoice payment allocations.
- `src/main/services/stockReceipts.ts:302-361` creates supplier invoice headers and lines during stock receiving.
- `src/main/services/stockReceipts.ts:363-404` updates PO line/order state.
- `src/main/services/stockReceipts.ts:431-441` updates supplier current balance.
- `src/main/services/reorderSuggestions.ts:1-18` describes simple reorder suggestions and draft PO creation.
- `src/main/services/reorderSuggestions.ts:67-127` calculates low-stock suggestions.
- `src/main/services/reorderSuggestions.ts:151-225` creates a draft purchase order and audits it.
- `src/main/services/supplierPaymentsAdmin.ts:256-445` records supplier payments, allocations, balance updates, and audit.

### Customer Credit

Implemented:

- Customer credit limits, terms, and current balance.
- True balance computation from credit sales and allocations.
- Customer payments and allocations.
- Due/aging support.

Evidence:

- `migrations/0003_master_data.sql:109-138` defines customers with type, credit limit, terms, current balance, and blocked flag.
- `migrations/0008_credit.sql:6-23` defines customer payments.
- `migrations/0008_credit.sql:26-38` defines customer payment allocations.
- `src/main/services/customerCredit.ts:1-9` states that truth is credit sales minus allocations and `current_balance` is a cache.
- `src/main/services/customerCredit.ts:96-112` computes true balance.
- `src/main/services/customerCredit.ts:115-153` finds open credit sales with due and aging.
- `src/main/services/customerCredit.ts:155-174` reconciles the cached balance.
- `src/main/services/customerCredit.ts:287-416` records customer payments, allocations, cached balance updates, and audit.

### Cash Control and Shifts

Implemented:

- Opening shifts.
- Blind closing count.
- Expected cash formula with split tender awareness.
- Cash drops and variance.
- Daily summaries.

Evidence:

- `migrations/0004_operational.sql:12-43` defines shifts.
- `migrations/0004_operational.sql:173-199` defines cash counts.
- `src/main/services/shifts.ts:1-8` describes blind cash close.
- `src/main/services/shifts.ts:46-123` opens a shift, creates opening cash count, and audits.
- `src/main/services/shifts.ts:150-193` submits counted closing cash.
- `src/main/services/shifts.ts:205-213` documents expected cash.
- `src/main/services/shifts.ts:251-306` calculates expected cash from sales, debt payments, drops, expenses, and tax payments.
- `src/main/services/shifts.ts:328-373` closes the shift and audits.
- `src/main/services/dailySummaries.ts:75-181` calculates sales, COGS, breakage, expenses, cash variance, and credit summary.
- `src/main/services/dailySummaries.ts:183-192` calculates stocktake shrinkage from the latest completed stocktake.
- `src/main/services/dailySummaries.ts:250-313` upserts the summary.

### Authentication, Roles, and Security

Implemented:

- Worker PIN hashes.
- Role-gated worker, product, supplier, stock receipt, and price override administration.
- PIN attempt lockout per worker/device.
- LAN HTTP API with bearer tokens and login throttling.
- Central RLS isolation in Supabase.

Evidence:

- `migrations/0002_workers.sql:12-44` defines worker roles, bcrypt `pin_hash`, soft delete, and termination fields.
- `src/main/services/workers.ts:1-3` uses bcrypt for PINs.
- `src/main/services/workers.ts:51-204` verifies PINs, rejects `SYSTEM`, applies lockouts, and audits success/failure/lockout.
- `src/main/ipc/handlers.ts:86-97` defines worker and open-shift requirements.
- `src/main/ipc/handlers.ts:118-127` allows only OWNER/FOUNDER to change phone access.
- `src/main/ipc/handlers.ts:392-438` gates stock receive with supervisor/owner PIN checks.
- `src/main/services/workerAdmin.ts:46-102` gates worker creation to owner/founder and audits.
- `src/main/services/productsAdmin.ts:1-4` gates product admin to owner/founder.
- `src/main/services/suppliersAdmin.ts:1-4` gates supplier admin to owner/founder.
- `src/main/http/server.ts:30-37` defines token/device headers, body limit, and login throttle constants.
- `src/main/http/rateLimit.ts:1-37` implements in-memory sliding window rate limiting.
- `supabase/migrations/20260630120000_multi_tenant.sql:20-27` enables RLS for companies.
- `supabase/migrations/20260625000001_central_sync.sql:43-50` enables RLS on shops and shop events with no public policies.

### Multi-Branch and Central Sync

Implemented:

- Local shop outbox.
- Background push/pull workers.
- Central Supabase store.
- Multi-tenant company/shop isolation.
- Catalog pull from HQ shop.
- Agent-facing order APIs.

Evidence:

- `src/shared/sync.ts:1-6` states the shop is the only writer for append-only event rows.
- `src/shared/sync.ts:10-24` lists synced event tables.
- `src/shared/sync.ts:28-33` lists mutable event tables such as pending orders, supplier invoices, and drawing policies.
- `src/shared/sync.ts:65-70` lists master tables including products, product units, pricing tiers, promotions, suppliers, and workers.
- `src/main/sync/outbox.ts:24-38` hydrates source rows into sync batches.
- `src/main/sync/outbox.ts:40-43` marks acknowledged outbox rows by sequence.
- `src/main/sync/push.ts:1-7` says re-sending is harmless and ack only happens after central confirms.
- `src/main/sync/push.ts:45-72` retries in a background loop while the shop keeps selling.
- `src/main/sync/pull.ts:1-6` describes shop-side catalog pull with no feedback loop.
- `src/main/sync/status.ts:8-29` reports sync configuration, role, pending count, and last sync.
- `supabase/migrations/20260625000001_central_sync.sql:19-28` defines central shops and token hashes.
- `supabase/migrations/20260625000001_central_sync.sql:30-41` defines central `shop_events`.
- `supabase/migrations/20260630120000_multi_tenant.sql:1-12` explains multi-tenant isolation.
- `supabase/migrations/20260630120000_multi_tenant.sql:29-57` adds `company_id` to shops and events.
- `supabase/functions/_shared/auth.ts:30-45` resolves shop identity by token hash and returns `company_id` server-side.
- `supabase/functions/ingest/index.ts:42-63` validates rows and stamps/upserts shop events under the resolved company.
- `supabase/functions/catalog/index.ts:41-64` serves HQ catalog scoped to the same company.

### Orders and Agent Automation

Implemented:

- Central agent records.
- Central order creation, confirmation, cancellation.
- Idempotent central order creation.
- Shop-side feed into local `pending_orders`.
- Pending order listing, rejection, cart resolution, fulfillment marking, and delivery statuses.

Evidence:

- `supabase/migrations/20260702130000_agent_orders.sql:22-32` defines agents.
- `supabase/migrations/20260702130000_agent_orders.sql:46-81` defines orders and notes that proforma orders have no stock or money effect.
- `supabase/migrations/20260702130000_agent_orders.sql:84-90` adds sequence and idempotency constraints.
- `supabase/migrations/20260702130000_agent_orders.sql:92-104` defines order lines.
- `supabase/migrations/20260702130000_agent_orders.sql:113-120` defines a central stock-on-hand view.
- `supabase/migrations/20260702130000_agent_orders.sql:133-186` defines `create_order`.
- `supabase/migrations/20260702130000_agent_orders.sql:194-227` defines `confirm_order`.
- `supabase/functions/agent/index.ts:15-20` exposes catalog, availability, orders, confirm, and cancel routes.
- `supabase/functions/agent/index.ts:193-269` validates and creates an order with rate limits and computed prices.
- `supabase/functions/agent/index.ts:283-298` confirms an order.
- `supabase/functions/orders-feed/index.ts:31-48` allows a shop token to read its own confirmed orders.
- `src/main/services/pendingOrders.ts:1-15` says accepting a pending order uses normal `completeSale`.
- `src/main/services/pendingOrders.ts:157-165` lists pending orders.
- `src/main/services/pendingOrders.ts:193-225` rejects with reason, optimistic concurrency, and audit.
- `src/main/services/pendingOrders.ts:247-291` resolves an order into cart lines.
- `src/main/services/pendingOrders.ts:300-330` marks an order fulfilled after sale.
- `src/main/services/pendingOrders.ts:332-443` manages packed, dispatched, delivered, and failed delivery status transitions.

### Computer Vision and Physical Evidence

Not implemented as a production subsystem.

Evidence:

- The repository contains breakage photo capture and storage, but no production camera feed, OCR, object detection, observation table, or media evidence graph.
- Product barcodes exist in product master data and sale lookup paths, but barcode use is not the same as camera verification.
- `migrations/0003_master_data.sql:62-100` includes product barcode and product metadata.
- `src/main/services/sales.ts:90-101` supports barcode lookup while resolving product input.
- `migrations/0005_accountability.sql:10-32` defines `breakage_log` with required `photo_url`.
- `docs/phase4-local-model-setup.md` appears to describe future local model setup, but the production schema and services for observations are absent.

## 4. Evidence-Based Compatibility Analysis

### Transaction Truth

Assessment: good base, incomplete for autonomous truth.

Counter has strong sale and inventory transaction boundaries. `completeSaleCore` creates a coherent sale atomically, and voids are reversals rather than deletes. Sale correction is especially well aligned with autonomous audit needs because it does not edit the original sale; it voids and re-rings.

However, the system lacks a unified business event ledger. Transaction truth is currently reconstructed from a blend of `sales`, `sale_lines`, `sale_payments`, `stock_movements`, `cash_counts`, `customer_payments`, `supplier_payments`, `audit_log`, and service-specific tables. That is workable for reports, but it is not enough for computer-vision reconciliation where every camera observation, dispatch action, payment update, and exception decision needs a common correlation spine.

Key compatibility evidence:

- Strong: `src/main/services/sales.ts:605-722` inserts sale, tenders, lines, and stock movements transactionally.
- Strong: `src/main/services/voids.ts:138-208` reverses rather than deletes.
- Strong: `src/main/services/correctSale.ts:136-194` wraps void plus re-ring plus audit in one transaction.
- Weak: `migrations/0009_audit_reporting.sql:9-24` creates app-level audit, but there are no database triggers preventing update/delete or guaranteeing every mutation emits an audit event.
- Weak: `src/main/services/stocktake.ts:158-160` explicitly says draft stocktake count mutation currently emits no audit row.
- Weak: `src/shared/sync.ts:28-33` identifies some "event" tables as mutable.

### Inventory Accuracy

Assessment: strong ledger foundation, but not yet warehouse-grade.

Counter stores stock in canonical units and treats stock movements as the source of truth. This is the right foundation for wholesale. It supports receiving, sale outflow, breakage, returns, stocktake variance, and worker consumption.

The missing parts are important for autonomous wholesale: reservation, batch/expiry, lot-level traceability, bin/zone/rack location, dispatch load state, goods in transit, route inventory, and inter-branch transfers. Negative inventory is intentionally allowed, which is operationally useful for a shop but dangerous for autonomous dispatch unless paired with exception creation.

Key compatibility evidence:

- Strong: `src/main/services/stockMovements.ts:159-174` calculates stock from stock movement sum.
- Strong: `migrations/0015_units.sql:1-13` and `migrations/0015_units.sql:21-39` provide canonical unit conversion.
- Strong: `src/main/services/stockReceipts.ts:136-180` validates unit conversion and line totals.
- Weak: `src/main/services/exceptionReports.ts:250-254` states that sales deliberately do not block on stock and negative stock means outflows exceed inflows.
- Weak: `migrations/0003_master_data.sql:62-100` has `shelf_life_days`, but inspected stock movement and supplier invoice schemas do not model batch or expiry.
- Weak: central and local orders have no reservation ledger; `supabase/migrations/20260702130000_agent_orders.sql:46-81` explicitly says proforma orders have no stock/money effect.

### Auditability

Assessment: many good audit hooks, not comprehensive enough.

The repository has a meaningful audit log and many services call it. But audit coverage is uneven. Some workflows update state without audit rows or depend on comments that say a future audit should be wired.

Key compatibility evidence:

- Strong: `migrations/0009_audit_reporting.sql:9-24` defines audit fields including before/after JSON and device ID.
- Strong: `src/main/services/workers.ts:51-204` audits authentication success, failure, and lockout.
- Strong: `src/main/services/sales.ts:739-760` audits sale completion and discounts.
- Strong: `src/main/services/reorderSuggestions.ts:151-225` audits draft PO creation.
- Weak: `src/main/services/stocktake.ts:158-160` says draft count updates emit no audit row.
- Weak: `src/main/services/customerPriceOverrides.ts` has admin-gated writes but no `logAudit` match in inspection.
- Weak: `src/main/services/empties.ts:9` says it writes an audit row, but inspected functions insert/update records without importing or calling `logAudit`.

### Payment Reconciliation

Assessment: good internal accounting, weak external reconciliation.

Counter validates tender sums and stores payment references for MoMo/bank-like methods. It supports customer payments, supplier payments, and split tender. It also computes expected cash from detailed sources. This is a solid base.

The autonomous future needs external payment feeds and settlement matching. There is no inspected ingestion for MoMo statements, bank settlement files, duplicate reference detection, webhook idempotency, card settlement, or exception generation when a claimed payment is not confirmed externally.

Key compatibility evidence:

- Strong: `src/main/services/sales.ts:272-280` requires MoMo references.
- Strong: `src/main/services/sales.ts:531-552` validates exact tender sums.
- Strong: `migrations/0019_sale_payments.sql:18-33` stores split tender rows.
- Strong: `src/main/services/shifts.ts:251-306` calculates expected cash from split-tender-aware sources.
- Weak: no external payment statement ingestion or settlement reconciliation modules found.
- Weak: no unique constraint found for duplicate external payment references.

### Credit and Customer Order Automation

Assessment: credit is solid for POS; order automation is early but real.

Credit management is notably better than a basic shop POS. It computes truth from open credit sales and allocations, treats `current_balance` as a cache, and supports aging. The central agent order subsystem is also promising: central agents can create and confirm orders, shops pull them, and local pending orders become normal sales.

The gap is fulfillment truth. Pending orders do not reserve stock. They are not automatically reconciled to packed items, dispatch photos, payment confirmations, route driver inventory, or delivery evidence.

Key compatibility evidence:

- Strong: `src/main/services/customerCredit.ts:1-9` identifies true balance versus cached balance.
- Strong: `src/main/services/customerCredit.ts:96-112` computes true balance.
- Strong: `supabase/migrations/20260702130000_agent_orders.sql:133-186` implements idempotent central order creation.
- Strong: `src/main/services/pendingOrders.ts:247-291` resolves orders to cart lines.
- Weak: `supabase/migrations/20260702130000_agent_orders.sql:46-81` says central orders are proforma and have no stock/money effect.
- Weak: no reservation or autonomous fulfillment verification tables found.

### Supplier and Replenishment Automation

Assessment: accounting exists; automation is basic.

The system can receive stock, update supplier invoices, record supplier payments, and create simple reorder suggestions. That is sufficient for operator-driven purchasing.

Autonomous wholesale replenishment requires more: demand forecasting, supplier lead times, MOQ/order multiples, supplier-specific price lists, substitution, shortage handling, receiving discrepancy workflows, invoice matching, and camera/barcode-assisted receiving verification.

Key compatibility evidence:

- Strong: `src/main/services/stockReceipts.ts:302-361` creates supplier invoices and lines.
- Strong: `src/main/services/supplierPaymentsAdmin.ts:256-445` records payments and allocations.
- Strong: `src/main/services/reorderSuggestions.ts:67-127` calculates low-stock suggestions.
- Weak: `src/main/services/reorderSuggestions.ts:1-18` describes the current model as simple suggestions and owner confirmation.
- Weak: no supplier ASN, OCR invoice ingestion, price contract, MOQ, or receiving exception workflow found.

### Computer Vision Readiness

Assessment: integration-ready shape, no CV domain model.

The app has useful entry points for CV: local HTTP API, shared service handlers, device IDs, location IDs, central sync, and breakage photo handling. These are enough to build a pilot alongside the app.

But CV cannot be bolted onto the current schema as a few columns. It needs a first-class observation model. The repository currently lacks camera devices, zones, media object store, frame timestamps, model versions, confidence scores, observation-event links, and exception resolution.

Key compatibility evidence:

- Strong: `src/main/http/server.ts:159-218` allows non-renderer devices to call the same business API.
- Strong: `src/main/ipc/session.ts:58-65` supports HTTP bearer token session resolution.
- Strong: `migrations/0005_accountability.sql:10-32` shows photo-backed accountability precedent.
- Weak: no production tables found for camera feeds, frame references, detected objects, OCR readings, or observation confidence.
- Weak: no service found that compares physical observations to expected sale/order/stock state.

### Offline and Multi-Branch Readiness

Assessment: one of the strongest areas.

Counter is local-first, can sell without internet, and syncs later. Central multi-tenant isolation exists and the central edge functions stamp `company_id` based on token identity. This is a very useful architecture for Ghanaian retail environments where power and connectivity can be unreliable.

The autonomous future will need more conflict and correlation infrastructure for multi-device and edge-camera environments. The current shop is still essentially one authoritative SQLite node plus LAN clients. That is acceptable, but autonomous services must be treated as authenticated devices submitting idempotent events, not as informal local scripts.

Key compatibility evidence:

- Strong: local SQLite app core and `src/main/sync/push.ts:45-72` retry loop.
- Strong: `supabase/functions/_shared/auth.ts:30-45` resolves company/shop identity server-side.
- Strong: `supabase/functions/ingest/index.ts:42-63` stamps central events with scoped company ID.
- Weak: local commands generally lack explicit client-generated idempotency keys.
- Weak: local HTTP can run without TLS on LAN.

## 5. Scoring Table

Scale: 0 = absent, 5 = production-ready for autonomous wholesale.

| Capability | Score | Rationale |
|---|---:|---|
| Transaction integrity | 3 | Atomic sales, void reversals, correction model, and stock ledger are strong. No unified business event ledger or local idempotency. |
| Inventory accuracy | 3 | Canonical units and stock movements are good. Negative inventory, no reservation, no batch/expiry, no zones, no dispatch/goods-in-transit ledger. |
| Auditability | 3 | Audit log exists and many flows use it. Coverage is uneven and immutability is not database-enforced. |
| Payment reconciliation | 3 | Split tenders, cash close, references, customer/supplier payments. No external payment feed matching or duplicate reference controls. |
| Credit management | 3 | True balance, aging, limits, payments, allocations. No risk scoring, guarantors, customer dedupe, or automated reminder workflow. |
| Customer-order automation | 3 | Central agent orders and local pending orders exist. No stock reservation or autonomous fulfillment verification. |
| Supplier/replenishment readiness | 2 | PO, supplier invoice, payments, and basic reorder suggestions exist. Forecasting and supplier automation are missing. |
| CV integration readiness | 2 | HTTP/sync/device foundations exist. No camera/observation/evidence schema or matching engine. |
| Exception-management readiness | 2 | Exception reports and breakage review exist. No durable case workflow with status, assignment, and evidence links. |
| Offline readiness | 4 | Local-first design and retrying sync are strong. Edge devices and multi-terminal idempotency need more work. |
| Security | 3 | PIN hashing, roles, lockout, rate limits, central RLS. Plain LAN HTTP option, plaintext local bearer tokens, no DB encryption, no edge-device signing. |
| Multi-branch readiness | 3 | Real central store and tenant isolation. Unresolved worker/customer ownership, location model, inter-shop transfers. |
| Multi-tenant readiness | 3 | Central `company_id` scoping is strong. Tenant dashboards and operational boundaries are still incomplete. |
| Fraud-detection readiness | 3 | Audit, exception reports, void/discount/negative-stock reports. Needs richer event stream, CV, and payment feeds. |
| Reporting/analytics | 3 | Reports, daily summaries, and central views exist. No BI-grade warehouse, metrics, or exception analytics. |
| Maintainability | 4 | Typed TypeScript, migrations, service separation, tests. Large handler file and mixed mutable/additive patterns remain. |
| Test coverage | 3 | Large Vitest suite exists, but local run failed from native ABI mismatch; no CV/pilot/external reconciliation coverage. |
| Deployment reliability | 3 | Cross-platform CI matrix and installer config exist. Native module rebuild caveat and unsigned installers remain. |

Overall: **58% readiness**.

## 6. Critical Architectural Risks

### Risk 1: No Unified Immutable Business Event Ledger

Current transaction truth is split across domain tables and `audit_log`. This is manageable for a POS, but not for autonomous reconciliation.

Required future capability:

- Every sale, stock, payment, order, delivery, observation, exception, and supervisor decision should create or link to immutable event records.
- Events need `event_id`, `event_type`, `correlation_id`, `causation_id`, `idempotency_key`, `actor_type`, `actor_id`, `device_id`, `location_id`, `source`, `occurred_at`, `recorded_at`, and payload hash.

Evidence:

- `migrations/0009_audit_reporting.sql:9-24` is audit-oriented, not a business event store.
- `src/shared/sync.ts:28-33` still treats some synced event tables as mutable.

### Risk 2: Audit Coverage Is Uneven

Several important operations are audited, but not all. Autonomous systems fail when unexplained state changes exist.

Evidence:

- `src/main/services/stocktake.ts:158-160` explicitly says draft count updates emit no audit row.
- `src/main/services/customerPriceOverrides.ts` was inspected for `logAudit` and none was found.
- `src/main/services/empties.ts:9` claims audit rows are written, but inspected functions do not call `logAudit`.

### Risk 3: Negative Inventory Is Intentional

Allowing sales to continue despite stock going negative is practical for a cashier-first shop. For dispatch automation, it must create exceptions and potentially stop physical release.

Evidence:

- `src/main/services/exceptionReports.ts:250-254` states sales deliberately do not block on stock.
- `src/main/services/sales.ts:605-722` writes sale outflows without an inspected stock-on-hand guard.

### Risk 4: Computer Vision Has No Domain Boundary

The app has no production-ready schema for camera devices, observations, media, detection confidence, model versioning, or evidence linking.

Evidence:

- No camera/observation production tables were found during inspection.
- Existing photo support is limited to breakage accountability via `migrations/0005_accountability.sql:10-32` and `src/main/services/breakage.ts:48-155`.

### Risk 5: Local HTTP Security Is Not Enough for Autonomous Devices

The LAN API is useful, but autonomous edge devices need stronger guarantees than a browser session token.

Evidence:

- `src/main/http/server.ts:274-315` starts HTTP/HTTPS, logs cleartext LAN warnings, and advertises mDNS.
- `migrations/0031_auth_tokens.sql:9-17` stores local auth tokens as plaintext opaque bearer tokens.
- `src/main/ipc/session.ts:119-127` mints random UUID tokens and stores them.

### Risk 6: Orders Do Not Reserve Stock

Confirmed central orders become local pending orders, but there is no stock reservation or goods-in-transit model.

Evidence:

- `supabase/migrations/20260702130000_agent_orders.sql:46-81` says proforma orders have no stock or money effect.
- `src/main/services/pendingOrders.ts:247-291` resolves an order to cart lines, but stock effect occurs only when normal sale completion runs.

### Risk 7: Returns and Unit Cost Edge Case

Customer returns use stock movements directly and appear to calculate unit cost incorrectly for multi-unit returns.

Evidence:

- `src/main/services/customerReturns.ts:118-145` resolves unit conversion and then uses `Math.floor(product.cost_price_pesewas / factor)` at line 142, while product cost is canonical elsewhere.
- `src/main/services/customerReturns.ts:154-201` inserts `stock_movements` manually instead of using `insertStockMovement`, bypassing central movement validation.

### Risk 8: No Durable Exception Workflow

The system reports anomalies, but it does not manage investigations as durable cases.

Evidence:

- `src/main/services/exceptionReports.ts:1-15` derives anti-shrinkage exception reports.
- `src/main/services/breakage.ts:199-299` exposes breakage review listing/filtering, but no status/assignment/resolution workflow was found.

## 7. Gap Register

| Gap | Severity | Evidence | Recommendation |
|---|---|---|---|
| Unified event ledger absent | Critical | Audit log exists, but no `business_events`; sync hydrates separate source tables. | Add immutable event store and link existing service transactions to it. |
| Observation model absent | Critical | No camera/observation tables or services found. | Add `observations`, `observation_media`, device registry, and event links. |
| Exception workflow absent | Critical | Exception reports are derived lists, not cases. | Add `exceptions`, `exception_events`, assignment, status, resolution, evidence. |
| Local idempotency absent | High | Central orders have idempotency; local sale/stock commands generally do not. | Require idempotency keys for external/edge command submissions. |
| Stock reservation absent | High | Orders are proforma until sale. | Add reservations and release/consume paths. |
| Dispatch ledger absent | High | Pending order delivery statuses exist, but no pick/pack/verify/load/depart chain. | Add dispatch events and goods-in-transit stock state. |
| Batch/expiry absent | High | Products have `shelf_life_days`, no movement-level lot/expiry. | Add lots/batches, expiry dates, receiving and sale allocation. |
| Negative stock allowed without automated case | High | Exception report notes sales do not block. | Keep POS permissive if needed, but create immediate exception and require review. |
| Audit gaps | High | Stocktake draft count, customer price overrides, empties. | Make audit/event emission mandatory through shared mutation helpers. |
| CV security absent | High | LAN tokens are browser-style; no signed device payloads. | Add edge device credentials, request signing, nonce/replay protection. |
| Payment feed reconciliation absent | High | Internal references only. | Add MoMo/bank import/webhook tables and reconciliation jobs. |
| Duplicate external payment references unconstrained | Medium | No inspected unique reference constraint. | Add normalized payment reference table with uniqueness per provider/account. |
| Supplier automation shallow | Medium | Reorder suggestions are simple. | Add lead times, MOQ, order multiples, supplier contracts, forecasting. |
| Customer identity/risk shallow | Medium | Credit basics exist. | Add dedupe, risk score, guarantor/contact, automated reminders. |
| Multi-branch transfers absent | Medium | Design docs mention open question; production transfer model absent. | Add inter-shop transfer orders and in-transit ledger. |
| Observability limited | Medium | Logs/status exist, no metrics/alerts queue dashboard. | Add structured logs, sync/exception metrics, operator dashboard. |
| Local token storage plaintext | Medium | `auth_tokens` stores opaque token. | Store token hash and rotate sessions. |
| Plain LAN HTTP allowed | Medium | Server warns but permits cleartext. | Require HTTPS for autonomous devices and payment/camera integrations. |

## 8. Recommended Target Architecture

### Design Principle

Do not rewrite the POS core. Add a transaction-truth layer beside it, then gradually route workflows through that layer.

### Target Components

1. **Business Event Ledger**
   - Local SQLite table: `business_events`.
   - Central mirror table: `business_events_central`.
   - Every event has correlation, causation, idempotency, actor, device, location, payload hash, and schema version.
   - Existing service transactions write domain rows and event rows in the same SQLite transaction.

2. **Observation Service**
   - Edge cameras or scanners submit observations, not business mutations.
   - Observations are append-only evidence: detected SKU, count, barcode/OCR text, confidence, image/video URI, device, zone, timestamp.
   - Observations link to expected events such as pending order pack list, stock receipt, return, or breakage report.

3. **Reconciliation Engine**
   - Compares expected state against observed state.
   - Produces match, mismatch, missing evidence, duplicate, late observation, or low-confidence outcomes.
   - Never silently changes money or inventory; it creates exceptions or recommends actions.

4. **Exception Workflow**
   - Durable cases with status: OPEN, ACKNOWLEDGED, INVESTIGATING, RESOLVED, DISMISSED.
   - Severity, assigned worker, due time, evidence links, comments, resolution code.
   - Resolution writes an event and optionally drives a stock adjustment, void, return, or payment correction through existing services.

5. **Dispatch and Reservation**
   - Confirmed order creates reservation.
   - Pick, pack, verify, load, dispatch, deliver, fail, return are explicit events.
   - Camera verification attaches observations to pack/load events.
   - Sale completion consumes reservation and creates stock outflow, or stock outflow moves to goods-in-transit depending on accounting choice.

6. **External Payment Reconciliation**
   - Import MoMo/bank statement rows.
   - Normalize provider, account, reference, amount, timestamp, payer, raw payload hash.
   - Match to sale payments and customer payments.
   - Create exceptions for missing, duplicate, amount mismatch, or stale pending payments.

7. **Central Analytics Warehouse**
   - Keep Supabase as central operational store.
   - Add event projections for dashboards rather than making central the live shop database.
   - Preserve offline-first sales.

### Target Data Flow

```text
Human cashier / owner / driver
Camera / scanner / payment feed / WhatsApp agent
  -> authenticated command or observation
  -> idempotency and authorization
  -> local service transaction
  -> domain rows + business_events + audit_log
  -> local reconciliation engine
  -> exceptions if mismatch
  -> sync_outbox
  -> central event mirror and analytics
```

### Event Types Needed

| Event | Current status | Notes |
|---|---|---|
| Sale created/draft | Absent | Sales are finalized directly. |
| Sale completed | Implemented, partial event model | `sales`, `sale_lines`, `sale_payments`, `stock_movements`, audit. |
| Sale cancelled/voided | Implemented | Void fields plus reversal stock movements and audit. |
| Sale corrected | Implemented well | Void plus re-ring plus links and audit. |
| Payment received | Implemented internally | Sale and customer payments; no external reconciliation event. |
| Partial payment allocated | Implemented | Customer payment allocations. |
| Credit issued | Implemented | Credit sale and balance logic. |
| Credit repaid | Implemented | Customer payments and allocations. |
| Stock received | Implemented | Stock movements plus supplier invoice. |
| Stock dispatched | Partial | Sale outflow and pending order delivery status; no dispatch event chain. |
| Stock adjusted | Partial | Stocktake variance; no generic adjustment event model. |
| Damaged/broken | Implemented | Breakage with photo. |
| Customer return | Implemented with concerns | Return records and stock movements; unit cost/manual movement risk. |
| Inter-shop transfer | Absent | Route-style reason codes exist, not full transfer workflow. |
| Discount applied | Implemented | Discount fields and audit, supervisor threshold. |
| Price override | Partial | Admin gated; audit gap found. |
| Cash drawer opened | Absent as event | Cash counts and shifts exist; no drawer-open peripheral event. |
| Shift started/closed | Implemented | Shift and cash count flow. |
| Employee action | Partial | Audit log covers many actions. Needs systematic event coverage. |
| Customer order confirmed | Implemented centrally | Agent order confirmation and pending local feed. |
| Pick/pack/load/deliver | Partial | Pending order delivery status transitions, no physical verification event model. |
| Supplier invoice posted | Implemented | Created from stock receiving. |
| Camera observation | Absent | Needs new model. |
| Reconciliation exception | Absent | Reports exist; case workflow absent. |

## 9. Minimum Viable Dispatch-Verification Pilot

Goal: verify that goods physically packed for a confirmed order match the expected pending order before dispatch, without blocking normal sales and without rewriting the POS.

### Pilot Boundaries

In scope:

- One shop.
- One packing station.
- One fixed camera or scanner.
- Confirmed pending orders only.
- SKU/count comparison at pack/load time.
- Exception creation for mismatch.
- Human override by OWNER/FOUNDER/SUPERVISOR.

Out of scope:

- Automatic sale completion.
- Driver route optimization.
- Full computer vision SKU recognition for every product.
- Payment settlement automation.
- Inter-branch transfers.

### Pilot Schema Additions

Add these tables locally first:

- `device_integrations`: registered cameras/scanners, device secret hash, type, station, active flag.
- `business_events`: immutable event ledger.
- `observations`: observation header with device, station, type, timestamp, model version, confidence.
- `observation_items`: SKU/product/count/barcode/OCR details.
- `observation_media`: image/video URI, hash, capture timestamp.
- `observation_links`: links observations to pending order, sale, stock receipt, or event.
- `exceptions`: durable mismatch cases.
- `exception_events`: status changes, comments, assignments, resolution.
- `stock_reservations`: optional for pilot phase 2.

### Pilot Flow

1. Central agent creates and confirms an order.
2. Shop pulls it into `pending_orders`.
3. Worker opens the pending order and starts packing.
4. App creates `ORDER_PACK_STARTED`.
5. Camera/scanner submits observations for products/counts.
6. Reconciliation compares observed lines to `pending_orders.lines_json`.
7. If matched, app creates `ORDER_PACK_VERIFIED`.
8. If mismatched, app creates `EXCEPTION_OPENED` with evidence links.
9. Supervisor either fixes pack, dismisses exception, or overrides.
10. Dispatch can proceed only when matched or supervisor-overridden.

### Pilot Success Criteria

- At least 95% of packed orders have a verification event or explicit override.
- Every mismatch has a durable exception with evidence.
- No normal sale completion latency regression above 200 ms.
- No data loss when internet is down.
- Pilot can be disabled by configuration without changing sales flow.

### Pilot Implementation Notes

- Reuse `HandlerRegistry` and local HTTP for a camera gateway, but require HTTPS or signed payloads for the device integration.
- Do not let the camera call `completeSale` or mutate stock directly.
- Link observations to pending order IDs and business event IDs.
- Sync observations and exceptions through the existing outbox model after adding table coverage.

## 10. Phased Implementation Roadmap

### Phase 0: Stabilize Transaction Evidence

Duration: 1-2 weeks.

Tasks:

- Add local command idempotency support.
- Add `business_events`.
- Emit events from sale complete, void, correction, customer payment, stock receipt, breakage, stocktake complete, customer return, and pending-order status changes.
- Add audit coverage for stocktake draft counts, customer price overrides, and empties.
- Fix or verify customer return unit cost calculation.
- Add tests for event emission inside existing transactions.

Exit criteria:

- Every high-value mutation emits an event in the same transaction.
- Duplicate idempotency keys cannot double-write.

### Phase 1: Exception Workflow

Duration: 1-2 weeks.

Tasks:

- Add `exceptions` and `exception_events`.
- Convert negative stock, large discount, repeated voids, missing receipt print, and stale sync into exception creation paths.
- Build operator UI for open/resolved exceptions.
- Add role-gated resolution codes.

Exit criteria:

- Existing exception reports become projections over durable cases or can create cases.

### Phase 2: Dispatch Verification Pilot

Duration: 2-4 weeks.

Tasks:

- Add device integration registry.
- Add observation and media tables.
- Build scanner/camera gateway API.
- Add pending-order pack verification workflow.
- Add evidence-linked mismatch exceptions.
- Sync pilot event and exception tables.

Exit criteria:

- A confirmed order can be physically verified before dispatch with evidence and supervisor override.

### Phase 3: Payment Reconciliation

Duration: 2-4 weeks.

Tasks:

- Add external payment import tables.
- Add MoMo/bank statement CSV import first; webhook later.
- Normalize references and add duplicate controls.
- Match sale/customer payments to external rows.
- Generate payment exceptions.

Exit criteria:

- Claimed MoMo/bank payments can be verified or flagged.

### Phase 4: Reservation and Goods in Transit

Duration: 3-5 weeks.

Tasks:

- Add stock reservations for confirmed orders.
- Add pick/pack/load/depart/deliver/fail/return event chain.
- Add goods-in-transit ledger.
- Add driver assignment and route inventory.

Exit criteria:

- Stock committed to an order is visible separately from available stock.

### Phase 5: Wholesale Replenishment Intelligence

Duration: 4-8 weeks.

Tasks:

- Add supplier lead times, MOQ/order multiples, and price contracts.
- Add demand forecasting and reorder confidence.
- Add receiving discrepancy workflow with camera/barcode support.
- Add invoice matching and supplier shortage claims.

Exit criteria:

- System can recommend purchase quantities and detect receiving discrepancies.

## 11. Files and Modules Likely to Change

### Local Database and Migrations

- `migrations/*.sql`: add event, observation, exception, reservation, dispatch, and payment reconciliation tables.
- `src/main/db/migrations.ts`: likely unchanged except migration behavior if payload hashing/check constraints are added.
- `src/main/db/audit.ts`: extend or complement with event emission helpers.

### Core Services

- `src/main/services/sales.ts`: emit business events, accept idempotency keys, link reservations/orders.
- `src/main/services/voids.ts`: emit explicit void/correction events.
- `src/main/services/correctSale.ts`: add event links and idempotency.
- `src/main/services/stockMovements.ts`: link movements to business events and observations.
- `src/main/services/stockReceipts.ts`: add receiving observations, batch/expiry, supplier discrepancy handling.
- `src/main/services/customerReturns.ts`: fix/verify unit-cost math, use shared movement helper or equivalent validation, emit events.
- `src/main/services/stocktake.ts`: audit/event draft counts and count corrections.
- `src/main/services/breakage.ts`: link photo evidence to observation/media model.
- `src/main/services/customerCredit.ts`: emit payment/credit events and support payment reconciliation.
- `src/main/services/pendingOrders.ts`: add pack/verify/load/dispatch events and reservation integration.
- `src/main/services/reorderSuggestions.ts`: evolve into replenishment recommendations.
- `src/main/services/supplierPaymentsAdmin.ts`: link supplier payments/invoices to payment reconciliation.
- `src/main/services/customerPriceOverrides.ts`: add event/audit emission.
- `src/main/services/empties.ts`: add event/audit emission.

### IPC, HTTP, and Shared API

- `src/shared/counterApi.ts`: add commands for events, observations, exceptions, device integrations, dispatch, reconciliation.
- `src/main/ipc/handlers.ts`: register new handlers; likely should be split by domain before it grows further.
- `src/main/ipc/registry.ts`: probably unchanged.
- `src/main/http/server.ts`: add edge-device auth mode and signed request validation.
- `src/main/ipc/session.ts`: hash local tokens and separate human sessions from machine credentials.

### Sync and Central Store

- `src/shared/sync.ts`: add new event/exception/observation/reservation tables to sync contract.
- `src/main/sync/outbox.ts`: support new tables and payload sizes.
- `src/main/sync/push.ts`: monitor larger media/evidence event flows.
- `src/main/sync/pull.ts`: pull central dispatch/order state if needed.
- `supabase/migrations/*.sql`: mirror event, exception, observation metadata, reservations, central analytics views.
- `supabase/functions/ingest/index.ts`: validate new event types and payload schemas.
- `supabase/functions/agent/index.ts`: expose order reservation/availability changes carefully.
- `supabase/functions/orders-feed/index.ts`: include dispatch/reservation data as needed.

### Renderer

- `src/renderer/screens/*`: new exception queue, dispatch verification, observation evidence viewer, payment reconciliation, reservations.
- `src/renderer/components/*`: status chips, evidence thumbnails, exception assignment/resolution controls.

### Tests

- `tests/*`: add event emission, idempotency, exception workflow, observation matching, dispatch verification, payment reconciliation, and security tests.

## 12. Questions Not Answerable From the Repo

1. Which exact autonomous future is desired first: dispatch verification, receiving verification, shelf monitoring, payment reconciliation, or WhatsApp sales automation?
2. What camera hardware will be used, and can it run local inference?
3. Are products visually distinguishable enough for CV, or should the first pilot use barcode/QR scanning plus photos?
4. What is the expected order volume per shop and peak dispatch rate?
5. Should stock be decremented at sale, pack, load, dispatch, or delivery for wholesale orders?
6. Is a packed order allowed to leave with a supervisor override if camera verification fails?
7. Which external payment providers need reconciliation first?
8. Are MoMo/bank APIs available, or must imports start as CSV/manual statements?
9. Do customers exist centrally across branches, or per shop?
10. Do workers exist centrally across branches, or per shop?
11. Are inter-shop transfers required before autonomous dispatch?
12. What legal/privacy constraints apply to camera footage in shops and warehouses?
13. Should media be stored locally, centrally, or both?
14. How long should observation media be retained?
15. Does the owner want autonomous blocking of risky actions, or advisory exceptions only?

## 13. Final Go/No-Go Recommendation

Recommendation: **Go for a constrained dispatch-verification pilot; no-go for full autonomous wholesale until the event, observation, and exception layers exist.**

Counter is a credible base. It has the right instincts: local-first reliability, integer money, transaction services, stock movement truth, role gates, audit logs, sync outbox, central tenant isolation, and early customer-order automation. These foundations materially reduce the cost and risk of the autonomous roadmap.

But the next system cannot rely on the current domain tables alone. Camera reconciliation, wholesale dispatch, external payment verification, and fraud investigation all require a common evidence spine. Without that, automation will either create false confidence or bury operators in unstructured mismatches.

The correct next move is not a rewrite. The correct next move is to add a minimal immutable event ledger, durable exception workflow, and observation model, then run a dispatch-verification pilot that only creates verified/exception states and does not automatically mutate money or inventory. Once that pilot proves reliable, reservations, goods-in-transit, external payment reconciliation, and supplier automation can be layered in safely.

## Validation Notes

Commands run:

```bash
npm run typecheck
npm test -- --run
```

Results:

- `npm run typecheck` passed.
- `npm test -- --run` did not produce meaningful application failures because local `better-sqlite3` was compiled against a different Node ABI. The failure was `NODE_MODULE_VERSION 130` versus current Node requiring `115`. The run collected 60 test files and 632 tests, with the DB-backed tests failing at module load. This matches the repository runbook note that plain Node tests may need `npm rebuild better-sqlite3`, followed by `npx electron-builder install-app-deps` to restore the Electron ABI.

