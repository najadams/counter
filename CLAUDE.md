# Counter — Operator runbook & build notes

Keyboard-first Electron POS for a Ghanaian beverage shop. Anti-shrinkage
forensics on every cedi.

This file is the practical companion to the design docs. If the design doc
asks "what should this do?", this file answers "how do I run it, build it,
and recover when it breaks?"

## 1. Quick start (developer)

```bash
npm install
npm run db:reset      # wipes the dev DB and reapplies all migrations
npm run dev           # vite + electron in dev mode (auto-cleans dist-electron)
```

Two seed scripts are also available, depending on the situation:

- `npm run seed:reset` — destructive. Nukes business data (sales, customers,
  products, stock, etc.) and replants a realistic fixture set. Keeps workers,
  locations, lookup tables, schema_migrations, device_config — so the
  first-run wizard doesn't re-fire. Useful for testing whole workflows from
  a known-good starting state.
- `npm run seed:demo` — idempotent additive. Inserts a handful of `DEMO_*`
  products with two units each (canonical + bigger purchase unit), primary
  unit selections, opening stock. Skips SKUs that already exist. Useful for
  poking the units / pricing UI without touching anything else.

If the renderer hangs on "Loading…" after edits to main/preload code, it's
almost always a stale `dist-electron` cache. The `predev` script in
`package.json` wipes it automatically on every `npm run dev`. To force
manually: `npm run clean`.

The app stores its DB at `<userData>/counter.db` in dev and production alike
(on macOS, `~/Library/Application Support/Counter/`). `db:reset` and
`db:migrate` target the same file; set `COUNTER_USER_DATA` to point them
elsewhere. Photos for breakage live under
`<userData>/photos/breakage/YYYY/MM/`.

## 2. Building installers

The build is shaped by `build` in `package.json` (electron-builder). Paths below
use `${version}` from `package.json`.

| Command            | Output                                                          |
|--------------------|------------------------------------------------------------------|
| `npm run dist:win` | `release/${version}/Counter-Setup-${version}-x64.exe` (NSIS)    |
| `npm run dist:mac` | `release/${version}/Counter-${version}-arm64.dmg` (and -x64)    |
| `npm run dist:linux` | `release/${version}/Counter-${version}-x64.AppImage`         |

Targets configured: nsis (Windows), dmg (Mac), AppImage (Linux).

**Mac builds, one architecture per run.** Each `dist:mac*` script runs
electron-builder twice (`--mac dmg:arm64`, then `--mac dmg:x64`). Building both
in one run swapped the arm64 app's SQLite module for the x64 one while its
image was still being written; v0.4.0's Apple Silicon installers shipped that
way and opened no window. `scripts/verify-mac-native-modules.sh
release/*/*.dmg` checks every native module in a Mac image has the image's
architecture and the app's Electron ABI; the release workflow runs it before
upload. Run it on any Mac image you build locally too: after
`npm rebuild better-sqlite3` for the tests, electron-builder can package that
plain-Node build (it trusts a stale "already built" marker). Delete
`node_modules/better-sqlite3/build` before a local `dist:*` run to force a real
rebuild.

**VAT vs no-VAT variants.** Counter ships in two flavours from one codebase (see
§11). The `dist:*` commands above build the **no-VAT** installer. Append `:vat`
— `npm run dist:win:vat`, `dist:mac:vat`, `dist:linux:vat` — to build the **VAT**
installer (`Counter-VAT-Setup-${version}-x64.exe`, etc.). The `:vat` scripts set
`COUNTER_VAT=1` and use `electron-builder.vat.cjs` to give the VAT build a
distinct appId/name so both can install side by side. CI builds every variant —
see `.github/workflows/release.yml` for the current matrix.

**Friendly variant.** `npm run dist:win:friendly` (and `dist:mac:friendly`,
`dist:linux:friendly`) builds **Counter Friendly** — the no-VAT build with large
illustrated buttons, simple wording and on-screen number pads (see §13). Output is
`Counter-Friendly-Setup-${version}-x64.exe` etc.; it installs beside Counter with
its own data. CI builds these three too.

### 2a. Cross-build caveat & the recommended path

`better-sqlite3` is a native module. **You cannot build a working Windows
installer from a Mac.** electron-builder will produce an .exe, but the
bundled `better-sqlite3.node` will be the macOS binary and the app will
crash on launch on Windows.

**Recommended: GitHub Actions.** This repo ships
`.github/workflows/release.yml` — a 3-OS matrix (windows-latest,
macos-latest, ubuntu-latest) that builds the right native binary on each
runner. Two ways to trigger it:

- **Tagged release** (recommended): bump the version in `package.json`,
  commit, then `git tag v0.1.1 && git push --tags`. Actions builds all
  three installers and attaches them to a GitHub Release matching the
  tag. Download the `.exe` from the Release page and copy it to the
  counter PC.
- **Manual run**: from the GitHub UI go to Actions → Release → Run
  workflow. The installers are uploaded as workflow artifacts (no
  Release is created).

Both paths use the same matrix; the only difference is whether a Release
gets created. The .exe is not code-signed for v0.x — Windows SmartScreen
will warn the user; they click "More info" → "Run anyway".

**Fallback: build on the target OS.** Plug into the counter PC, install
Node 20 and Git, clone the repo, `npm install`, `npm run dist:win`. The
`.exe` lands in `release/<version>/`. The `postinstall` script runs
`electron-builder install-app-deps` to rebuild native modules against the
Electron ABI; that's why a fresh clone on the target machine works, but
copying `node_modules` across OS lines does not.

## 3. Installing on the counter PC (Windows)

1. Copy `Counter-Setup-<version>-x64.exe` to the PC (USB stick, network share,
   whatever). Verify the file size matches the build machine's copy — a
   truncated installer is the most common ghost.
2. Double-click the installer. NSIS prompts for an install path; the
   default (`C:\Users\<user>\AppData\Local\Programs\Counter`) is fine for
   a single-user install. The installer creates a Desktop shortcut and a
   Start Menu entry called "Counter".
3. Launch Counter. The first run will:
   - Create the SQLite database at
     `C:\Users\<user>\AppData\Roaming\Counter\counter.db`
   - Apply every bundled migration
   - Show the **first-run owner setup wizard** — enter dad's name, phone,
     and PIN. This becomes the OWNER account.
4. Log in with the OWNER PIN. Open Settings → Workers to add cashiers
   and supervisors. Settings → Suppliers to seed beverage suppliers.
   Settings → Products to add the catalog. Then run an Opening Stock
   receipt to seed inventory.

### Receipt printer

The thermal printer driver is configured in the OS, not in Counter.
Counter calls into `node-thermal-printer` against the default Windows
printer. On a fresh PC:

1. Install the printer's vendor driver.
2. Set the thermal printer as the **default** printer (Settings →
   Bluetooth & devices → Printers).
3. Print a Windows test page; if that works, Counter's print path works.

If the printer is offline at sale time the receipt is queued in the
`pending_receipt_reprints` table — see Settings → Reprint queue.

## 4. Backups

Run nightly. Either:

- **Schedule:** Open Task Scheduler → Create Basic Task → Daily 23:30 →
  Action `cmd /c cd /d "C:\Users\<user>\AppData\Local\Programs\Counter\resources\app" && npm run backup`. (Adjust the path; the goal is `node scripts/backup.cjs` runs against the installed app's resources.)
- **Manual:** `npm run backup` from a checkout of the repo.

The script uses SQLite's `VACUUM INTO`, which writes a consistent snapshot
even while the app is running. Output goes to
`%USERPROFILE%\CounterBackups\counter-YYYY-MM-DD.db` and rolls a 14-day
window.

**Off-site:** copy the latest `.db` to a USB stick at end of day, take it
home. Without an off-site copy a fire or theft loses everything.

**Health indicator.** After every successful run, `scripts/backup.cjs`
writes `<userData>/last_backup.json` with the timestamp and target dir.
Counter reads this on every boot and shows a banner on the home screen
when the heartbeat is older than 72 hours (warning) or 7 days (danger),
or has never been written at all. The banner is dismissible with
"Remind tomorrow" so it doesn't pester the cashier mid-shift, but it
reappears the next morning.

### Automatic snapshot before upgrades

When a new version starts with migrations to apply to an existing database, it
first copies the database to
`<userData>\pre-migration-backups\counter-before-<first migration>-<YYYYMMDD-HHMMSS>.db`
(`src/main/db/preMigrationSnapshot.ts`). `npm run db:migrate` does the same.
The newest three are kept. A brand-new install skips it, since there is nothing
to lose.

This is an **undo file for a bad upgrade**, not a backup: it sits on the same
disk as the live database and does not update the backup heartbeat. If the
snapshot can't be written, the log says so (`pre-migration snapshot FAILED`)
and the app migrates anyway rather than refusing to open the till.

To roll back: close Counter, move `counter.db`, `counter.db-wal` and
`counter.db-shm` aside, copy the snapshot in as `counter.db`, and reinstall the
**previous** version. The newer version would just re-run the same
migrations. Anything recorded after the upgrade is not in the snapshot.

## 5. Money, units, and the SYSTEM worker

- Money is stored as **integer pesewas** (1 cedi = 100 pesewas). Never
  introduce floats.
- Stock is stored in **canonical units** (the smallest sellable unit per
  product). The `product_units` table maps display units (CRATE, PACK,
  BAG_50KG) to canonical via integer factors.
- The `SYSTEM` worker is the actor for migration-time inserts and
  reconciliation jobs. It cannot log in; the first-run wizard creates the
  first human OWNER.

## 6. When something breaks

| Symptom                                            | Where to look                              |
|----------------------------------------------------|---------------------------------------------|
| App won't start, crashes immediately               | electron-log: `%APPDATA%\Counter\logs\main.log` |
| "Migration failed: 00xx_*.sql"                     | Same log. The failed migration rolled back, so data is as it was before the upgrade |
| Data missing or wrong right after an upgrade       | Roll back to the pre-migration snapshot (§4) |
| Receipt printer silent                             | Windows print queue + `pending_receipt_reprints` |
| Cashier locked out (5 PIN attempts)                | Wait 15 min, or OWNER → Settings → Workers → Reset PIN |
| Stock count off                                    | Run a stocktake; daily summary uses the corrected count |
| Customer balance disagrees with sales              | Audit log viewer (Session 12); auto-reconcile on next boot |
| OWNER PIN forgotten                                | Login screen → "Forgot OWNER PIN?" + recovery code (see §7) |

## 7. Recovering a forgotten OWNER PIN

Counter has no "forgot PIN" path through the regular login flow — that
would defeat the point of PINs. Instead, every OWNER account gets a
**one-time recovery code** when it's first set up, and again whenever it's
regenerated.

### What the recovery code looks like

A 16-character code in four groups, like:

```
H7K3-MXN9-PQR2-VFTW
```

Hyphens and case are ignored when typed. Only letters and digits are used,
and easily-confused characters (`0`, `O`, `1`, `I`, `L`) are excluded.

### Where to get it

- **First-run setup:** the wizard shows the code on the screen immediately
  after you create the OWNER account. There is a checkbox saying *"I have
  written this code down somewhere safe"* — you must tick it to continue.
  This is the ONLY time the code is shown without a PIN reset.
- **From inside the app:** an OWNER signed in can regenerate a fresh code
  any time from Settings → Workers → "Generate new recovery code" (this
  invalidates the old one). Use this if you've lost the original paper or
  if a trusted person who held the code has left.
- **After a successful recovery:** when the code has just been used to
  reset a PIN, a new code is shown on the same screen for you to write
  down. The old code is consumed.

### Where to keep it

The code's whole purpose is to be available when the OWNER PIN is not.
Keep it OUT of the app:

- A locked drawer at the shop or at home.
- A photo on the OWNER's personal phone, in a passworded folder.
- An envelope mailed to a trusted family member.

Do **not** save it on the same PC that runs Counter — if the PC is stolen
or wiped, the code goes with it.

### How to use it

1. On the login screen, click **"Forgot OWNER PIN?"** below the PIN box.
2. Pick the OWNER account from the list. (Workers without a code on file
   are greyed out — those can only be reset by another OWNER.)
3. Type the recovery code. Hyphens and case are ignored.
4. Set a new PIN (4–6 digits) and confirm.
5. **A new recovery code is shown on the next screen.** Write it down —
   the old one is gone.
6. Sign in with the new PIN.

### When the code itself is lost

If both the OWNER PIN and the recovery code are lost, the only paths back
are:

- **Another active OWNER** (if you set up two during onboarding) can
  reset this OWNER's PIN from Settings → Workers → Reset PIN.
- **Restore from a backup** (`%USERPROFILE%\CounterBackups`) where the
  PIN was still known — this loses any data after the backup.

This is why the recommendation in section 4 is to back up nightly AND set
up a second OWNER (e.g. a spouse) at first-run if you have one available.

### What's logged

- `RECOVERY_CODE_GENERATED` — every time a code is created (with trigger:
  `SETUP`, `REGENERATE`, or `POST_RESET`).
- `RECOVERY_CODE_CONSUMED` — every successful PIN reset using a code.

Both end up in the audit log so you can see exactly when the recovery
flow was used.

## 8. Build prerequisites

- Node 20+ (`engines.node` in package.json)
- For Windows builds: Visual Studio 2022 Build Tools with the "Desktop
  development with C++" workload (so node-gyp can rebuild
  better-sqlite3)
- For Mac builds: Xcode Command Line Tools
- For Linux builds: `build-essential`, `libsqlite3-dev`

`electron-builder install-app-deps` runs in `postinstall` and handles the
Electron-ABI rebuild automatically.

## 9. Network access — other devices on the same wi-fi

Counter can serve its full UI over HTTP so a phone or tablet on the same
network can use it through a browser (no app install). The host PC running
Counter is the server; it holds the one database and the receipt printer.
This is **off by default** — the desktop app opens no network socket unless
you ask it to.

### Turning it on

Set environment variables before launching Counter:

| Variable              | Default       | Meaning                                            |
|-----------------------|---------------|----------------------------------------------------|
| `COUNTER_HTTP`        | (unset)       | `1` enables the embedded server.                   |
| `COUNTER_HTTP_HOST`   | `127.0.0.1`   | `0.0.0.0` exposes it to the LAN. Loopback = this PC only. |
| `COUNTER_HTTP_PORT`   | `4317`        | Port to listen on.                                 |
| `COUNTER_HTTPS_KEY`   | (unset)       | Path to a TLS private key (PEM). Enables HTTPS.    |
| `COUNTER_HTTPS_CERT`  | (unset)       | Path to a TLS certificate (PEM). Enables HTTPS.    |

- **This PC only (proof / kiosk):** `COUNTER_HTTP=1` then open
  `http://127.0.0.1:4317` in a browser.
- **LAN (other devices):** `COUNTER_HTTP=1 COUNTER_HTTP_HOST=0.0.0.0`. On
  startup the main log prints every reachable URL, e.g.
  `[http] reachable on LAN at http://192.168.1.20:4317`. Open that on the
  phone. (Log location: §6 — `%APPDATA%\Counter\logs\main.log`.)

### Joining from a phone (QR + counter.local)

When the server is LAN-exposed, the host home screen shows a **QR code** —
the cashier scans it to open the till on a phone/tablet on the same wi-fi,
with no IP to type. The QR encodes the host's IP URL (always resolvable);
the friendly `counter.local` address is shown beneath it.

The host also advertises itself over **mDNS** as `counter.local`, so
`http://counter.local:4317` keeps working even when DHCP hands the host a
new IP. Rename it with `COUNTER_MDNS_NAME` (e.g. `osu` ->
`http://osu.local:4317`) when several Counter hosts share one LAN.

Caveats: some Android browsers don't resolve `.local` names — the QR (IP
URL) is the reliable fallback. A Windows host needs an mDNS responder;
Apple's Bonjour service ships with many printer drivers and is often
already present.

### Security notes (read before exposing on the LAN)

- **Use a trusted private network.** Without TLS, PINs travel unencrypted
  over the wi-fi; the log warns you when you bind to the LAN without a cert.
  Supply `COUNTER_HTTPS_KEY`/`COUNTER_HTTPS_CERT` to encrypt.
- **PIN lockout is per device.** Each browser gets its own device id, so a
  cashier's phone hitting the 5-attempt lockout (§6) does **not** lock that
  worker on the counter PC. An OWNER reset still works for all.
- **Login is rate-limited** to 10 attempts / 5 minutes per device IP to slow
  guessing; further attempts get a "try again later" until the window clears.
- Sessions are independent per device — two people can be signed in as
  different workers at once. Sign-in tokens expire after 2h idle / 12h max,
  and now **survive a host restart** (persisted to the DB in `auth_tokens`),
  so a load-shedding reboot doesn't sign everyone out mid-shift. Expired
  tokens are reaped on boot.

Still **not** built yet (don't promise these): a touch-optimised layout —
the till UI is keyboard-first, so a phone is usable but cramped — and remote
receipt printing. Phones can ring up sales; the receipt prints on the host.

## 10. Multiple shops — sync (LIVE — central store deployed, multi-tenant)

> **Status: built and running**, not just designed. The shop-side push/pull
> workers (`src/main/sync/*`) start automatically at boot once a shop is
> provisioned; the central store is a live, multi-tenant Supabase project
> (`pakfonjgxcnxdkgpuafg`) with a real client company walled off from every
> other by `company_id` + RLS — see `supabase/migrations/` and
> `supabase/functions/{ingest,catalog,add-shop,bootstrap-company}`. The fuller
> design narrative (including open questions) is still in
> `docs/phase3-network-and-sync.md`.

### The model

Each shop stays exactly what it is today: one Counter install, one local
SQLite DB, one receipt printer, serving its own phones/tablets over the LAN
(§9). A shop **never** needs the internet to sell — that's deliberate, because
the line goes down. A background sync worker moves data to and from a central
store whenever a connection is available.

Data flows in two directions with a clear ownership split, which is what keeps
sync conflict-free:

- **Sales, payments, stock moves, breakage, audit — flow UP.** These are
  append-only events; no two shops ever touch the same record, so they merge
  with no conflicts. The central store is the union of every shop's activity.
- **Catalog, prices, suppliers, worker roster — flow DOWN.** The owner
  maintains one master set at HQ; shops receive it. One writer, so again no
  conflicts. You stop re-keying the product list at every shop.

What we will **not** do: make the central database the live system of record
(a shop with no internet could no longer sell), let two shops edit the same
price and try to merge, or wire shops directly to each other. Everything is
hub-and-spoke through the central store.

### Onboarding — two paths, deliberately different trust levels

**Adding a branch to a company that already has Counter** is self-service, no
SQL, no operator involved:

1. From an already-provisioned branch, an OWNER/FOUNDER opens Settings → Sync →
   **"Add a new branch"**, types the new branch's shop code, clicks Add.
2. The app asks the central store to mint a sibling shop under *this install's
   own company* (the existing branch's own token proves which company —
   `supabase/functions/add-shop`). The new branch always joins as role `SHOP`
   (never a second `HQ` — that would make the catalog function's "which HQ do I
   serve from" ambiguous).
3. The new shop's `shop_id` / central URL / token are shown **once**, in a
   recovery-code-style panel (copy it down before dismissing).
4. Install Counter on the new branch's PC, run the first-run wizard (§3) for its
   own local OWNER, then paste those three values into *that* install's
   Settings → Sync and restart. Background sync starts at boot from then on;
   the branch works offline and catches up when it reconnects.

**Bringing on a brand-new client company** (the first branch of a business that
has never used Counter) is operator-only, on purpose — otherwise anyone with a
copy of the app could spin up unlimited companies against the Supabase project
for free:

```
PROVISION_ADMIN_SECRET=<secret> npm run provision:company -- ACME "Acme Drinks Ltd" OSU HQ
```

This hits `supabase/functions/bootstrap-company`, gated by an admin secret set
once via `supabase secrets set PROVISION_ADMIN_SECRET=<random> --project-ref
pakfonjgxcnxdkgpuafg` (never committed). It prints the new company's first
shop's onboarding details the same way — paste them into that first branch's
Settings → Sync, same as step 4 above. Every subsequent branch for that company
goes through the self-service path.

### Sync health

Like the backup heartbeat (§4), each shop records its last successful sync, and
the home screen shows a banner when sync goes stale (warning after 24h, danger
after 72h). The central side tracks each shop's last-seen and watches for gaps
in the per-shop sequence numbers — a gap means data went missing in transit,
which is itself worth investigating (same anti-shrinkage instinct as the rest of
the app).

### Security — including multi-tenant isolation

Shop-to-central traffic runs over real HTTPS to the central host (Supabase has a
proper certificate), so the LAN self-signed-cert problem in §9 never arises for
data leaving the building. Each shop authenticates with its own revocable
bearer token (only its sha256 hash is stored centrally), and the central store
never dials into shops — every connection starts from the shop side.

Counter is **multi-tenant**: multiple separate client companies share the one
central project, and none can see another's data. A token resolves to
`(company_id, shop_id)` server-side — a shop can never assert which company it
belongs to, only prove it via its own token — and the Edge Functions (`ingest`,
`catalog`, `add-shop`) stamp/scope every row by that resolved `company_id`.
Row-Level Security is on for every central table with no policies, so even the
Supabase auto-REST API can't read anything; only the service-role Edge
Functions touch these tables.

### Consolidated reporting

The central store (Postgres, on Supabase) is where the owner sees everything at
once: revenue by shop, stock by shop, cross-shop audit — scoped to one company
at a time (`sales_central` view and friends). Each shop's own local reports keep
working offline, unchanged.

### Not yet decided (see the design doc)

Whether customers and the worker roster are owned per-shop or centrally (this
affects credit and logins across shops), and how inter-shop stock transfers are
recorded. These are open questions in `docs/phase3-network-and-sync.md`, not
settled plans. (Central hosting itself is decided: Supabase, project
`pakfonjgxcnxdkgpuafg`.)

## 11. VAT — the two build variants

Counter ships as **two binaries from one `main` branch**: a **no-VAT** build and a
**VAT** build. There is no separate VAT branch — VAT is gated by a build-time flag,
so every feature lands once and flows into both. The only runtime difference is
whether VAT is charged/recorded.

Which one a shop installs depends on VAT registration. Ghana raised the mandatory
registration threshold to **GH¢750,000** turnover (1 Jan 2026), so a small shop
below it runs the no-VAT build; a registered shop runs the VAT build.

### The flag

`COUNTER_VAT=1` at **build time** selects the VAT build. `vite.config.mts` injects
it as the compile-time constant `__COUNTER_VAT__`; `src/shared/lib/vat.ts` exposes
it as `VAT_ENABLED`. Dead VAT branches tree-shake out of the no-VAT bundle. Build
with the `dist:*:vat` scripts (§2). It is **not** a runtime toggle — a shop can't
flip VAT on in Settings; you install the matching binary.

### The law (VAT Act 2025 / Act 1151, effective 1 Jan 2026)

- VAT **15%** + NHIL **2.5%** + GETFund **2.5%**, all on the **same base** (no
  cascading). The COVID-19 Health Recovery Levy is **abolished**. Combined effective
  rate **20%**.
- Prices are **VAT-inclusive** (Ghana law for consumer prices). The customer total
  is **identical** to the no-VAT build; the tax is **extracted** out of the inclusive
  total for the receipt and records. From an inclusive total `T`:
  base = `round(T / 1.20)`, then VAT/NHIL/GETFund off the base, with VAT absorbing
  the rounding residual so `taxable + vat + nhil + getfund == total` exactly.
- All integer pesewas (§5). Rates live in `src/shared/lib/vat.ts` — change them
  there if the law changes again. VFRS (flat-rate scheme) is not built; it would go
  behind the same module.

### What changes in the VAT build

- `sales` carries `taxable_pesewas / vat_pesewas / nhil_pesewas / getfund_pesewas`
  (migration `0037_vat.sql`). These columns exist in **both** builds — the no-VAT
  build just always writes 0, so the schema never diverges. Written in
  `completeSaleCore` (`src/main/services/sales.ts`).
- Receipts print a VAT block (`TOTAL includes VAT`, the three levy lines, and the
  shop's VAT reg number) — `src/shared/lib/receipt.ts` and the on-screen
  `ReceiptBody`. Suppressed entirely when the components are 0.
- Settings → Receipt gains a **VAT registration number** field (stored in
  `device_config` via `receiptConfig.ts`), shown only in the VAT build.
- The checkout screens show an "incl. VAT" line; the total is unchanged.

### Verifying

`COUNTER_VAT=1 npm run test -- tests/vat-sale.test.ts` exercises a real VAT sale
(DB row + receipt); `src/shared/lib/vat.test.ts` proves the pesewa rounding identity.
The default `npm test` runs the suite with VAT off (the VAT integration test
self-skips), so the no-VAT receipt assertions stay valid.

> Note for contributors: tests open `better-sqlite3` under plain Node, but
> `postinstall` rebuilds it for the Electron ABI. If the DB-backed tests fail with
> `NODE_MODULE_VERSION`, run `npm rebuild better-sqlite3` to test, then
> `npx electron-builder install-app-deps` to restore the Electron build before
> `npm run dev`.

## 12. Activation keys

Counter requires a **one-time activation key** on first run. The key is
machine-bound, perpetual, and verified entirely offline — a shop with no
internet can still activate.

### How it works

An activation key is an **Ed25519 signature over a small payload** (version,
issue date, machine hash, licensee name), base32-encoded. The vendor holds the
private key; every build ships only the public key (`PUBLIC_KEY_B64` in
`src/main/services/activation.ts`). Nobody can mint a key from anything in the
shipped app — that's the whole reason for asymmetric crypto here rather than a
shared secret.

The cost is length: a 64-byte signature can't be shrunk, so keys are ~150
characters and are **pasted** (WhatsApp, email), not typed. Dashes, line breaks
and case are all ignored on input.

### Issuing a key (vendor side)

Once, ever — create the signing keypair:

```bash
npm run license:keygen
```

It writes `~/.counter/license-ed25519.key` (mode 0600) and prints the public key
to paste into `activation.ts`. **Back this file up and never commit it.**
Regenerating it invalidates every key you have ever issued.

Then, per shop:

```bash
npm run license:mint -- --licensee "Osu Drinks Ltd" --machine QV07-5AEV-7A18-HTBA
```

The machine code comes from the shop — see below. Send the printed key back.

### Activating (shop side)

1. Install Counter and launch it. Because no key is on file, the **activation
   screen** appears before the first-run owner wizard (§3).
2. The screen shows a **machine code** in the same shape as a recovery code
   (`QV07-5AEV-7A18-HTBA`). The shop sends it to you by WhatsApp/SMS. It's a
   truncated hash of an OS-level machine id — it carries no sales, customer or
   worker data.
3. You mint a key and send it back; they paste it and click Activate.
4. Counter proceeds to the owner wizard as normal. Activation is once per PC.

### The machine fingerprint

`src/main/services/machineId.ts` reads an OS-level install id — `MachineGuid`
on Windows, `IOPlatformUUID` on macOS, `/etc/machine-id` on Linux — and hashes
it. Deliberately **not** the `device_id` from `db/deviceId.ts`: that one lives
inside counter.db and travels with the database on purpose, which is exactly
wrong for binding a licence to a PC. If no OS id can be read, a random id is
persisted in userData as a fallback (weaker — wiping userData re-rolls it).

### Policy: grace, then read-only

| Moment | Behaviour |
|---|---|
| First run, no key on file | **Blocks** — activation screen, and the `sale:complete` channel refuses (so a LAN phone can't ring one up past the desktop gate) |
| Activation, key invalid or for another PC | **Rejected**, logged as `ACTIVATION_REJECTED` |
| Key stops validating, day 0–7 | **GRACE** — countdown banner, till fully functional |
| Key stops validating, day 7+ | **RESTRICTED** — read-only: no new sales |
| Mismatch we can't trust | **INCONCLUSIVE** — warns, never escalates (see below) |

Read-only is deliberately narrow. It takes away exactly one thing: ringing up a
**new sale**. Shift close, reports, export, stock and re-activation all keep
working, so a shop under enforcement can still finish its day and get its books
out — pressured, never trapped. `GRACE_DAYS` is in `activation.ts`.

The countdown runs from when the mismatch was **first observed**
(`activation_mismatch_since` in `device_config`), not from each boot, so
restarting the app doesn't buy another week. It's cleared whenever the key
validates again — a DB copied to a second PC and then run back on the original
returns to `OK`.

**Enforcement lives at the IPC boundary** (`assertSalesAllowed`, called from the
`SALE_COMPLETE` handler), not in the renderer. LAN phones ring up sales through
that same channel over HTTP, so a UI-only check would leave the transport open.
The renderer checks too, but only so the cashier gets a readable explanation and
the machine code instead of a failure at the end of a rung-up cart.

### Why INCONCLUSIVE exists

A mismatch is only enforced when the evidence is trustworthy. Two cases warn
forever and never escalate:

- **A fallback fingerprint on either side.** If the OS machine id couldn't be
  read — a wedged `reg` on a loaded Windows box, say — `machineId.ts` falls back
  to a random id persisted in userData. Then we cannot tell "different PC" from
  "couldn't read this PC", and punishing the second would take a legitimate till
  read-only for a transient failure. So enforcement requires `source === 'os'`
  at *both* activation time (`activation_machine_source`) and now.
- **A bad signature.** That's exactly what rotating `PUBLIC_KEY_B64` in a future
  build would look like on every existing install. Enforcing it would restrict
  every shop at once on upgrade.

Both are covered by tests. If you ever loosen this, understand that you are
trading a shrinkage control for the risk of bricking tills you can't reach.

### What's logged

- `ACTIVATION_ACTIVATED` — licensee, issue date, machine code.
- `ACTIVATION_REJECTED` — failure reason and the machine code that was refused.
- `ACTIVATION_MACHINE_MISMATCH` — written once per boot, carrying the state
  (`GRACE` / `RESTRICTED` / `INCONCLUSIVE`), days left, the code the key was
  activated on, the code the PC reports now, and how confidently that code was
  read.

### Verifying

```bash
npx vitest --run tests/activation.test.ts
```

Covers the base32/payload round-trips, signature forgery, tampering, wrong-PC
rejection, the grace→read-only transition (with an injected clock), and every
path that must NOT escalate. The happy-path key in that file is a
committed test vector minted against a fixed synthetic machine — the public key
never rotates, so it stays valid without the private key being present.

> Note: the `Counters` decoy build (`electron-builder.counters.cjs`) is a
> separate app identity with its own database, so it needs **its own**
> activation key for whatever PC it runs on.

## 13. Counter Friendly — the illustrated build

A third binary from the same `main` branch, for shops whose staff find the
keyboard-first till hard to read. Same sales, payment, stock, permission, audit
and activation rules; only the renderer changes. No database migrations, no IPC
changes.

### The flag

`COUNTER_FRIENDLY=1` at **build time** → Vite injects `__COUNTER_FRIENDLY__` →
`FRIENDLY_UI_ENABLED` in `src/shared/lib/buildFlags.ts`. `main.tsx` stamps
`<html data-ui="friendly">` for the larger focus ring. Like VAT it is not a
runtime toggle, and the standard bundle tree-shakes the Friendly screens out.
`electron-builder.friendly.cjs` gives it its own appId (`com.counter.pos.friendly`)
and name, so it has its **own userData dir, database and activation key**. It is
no-VAT only for now.

```bash
npm run dev:friendly      # renderer on :5175
npm run build:friendly    # dist/ for the LAN preview (scripts/serve-lan.ts)
```

### What it changes

- **Home** (`components/friendly/FriendlyHomeMenu.tsx`): six big tiles — Sell
  drinks (highlighted; becomes *Continue sale* while the cart has items), Customers,
  Money out, Receive stock, Recent sales, Today's summary — then three expandable
  groups (Stock tools, Orders & receipts, Manage shop). Close shift sits apart.
  All F-keys, role gates and notification counts are unchanged.
- **Sign in / open shift / close shift**: "Choose your name", "Enter your PIN",
  "Count the money in the drawer. Enter the amount." with an on-screen
  `NumberPad` that never takes focus from the field, so taps and typing mix.
- **Selling**: bigger search, names and units; 48px quantity buttons; a large
  Total; the keys are listed behind **Help** (F1) in the header, and on a PC
  the search side and the cart scroll separately;
  **Take payment** opens the touch checkout on every device (hybrid PCs),
  while F4/F5/F6, Split payment and F2 stay visible. The checkout shows **Total**,
  **Money received**, **Change to give**, and answers to F4/F5/F6/F2/Esc.
- **Header**: a large **Home** button with a house picture on every screen that
  returns home; screens that return elsewhere pass `backLabel` (e.g. *Back to
  customers*, *Back to open shift*). F9 unchanged.

Illustrations are local SVGs in `src/renderer/assets/illustrations/`, inlined by
`TaskIllustration` so they work offline and follow the theme (palette in
`styles/index.css` under `.task-illustration`). Always pair one with words.

**Real artwork instead of line drawings.** `TaskIllustration` also looks in
`src/renderer/assets/illustrations/raster/`. A file named after an illustration
(`sell.webp`, `receive-stock.png` — `.webp`/`.png`/`.jpg`/`.avif`) is rendered as
an `<img>` in place of that SVG; names with no file there keep their line drawing,
so the set can be replaced one picture at a time and a picture is backed out by
deleting it. The glob is behind `FRIENDLY_UI_ENABLED`, so the standard and VAT
bundles ship none of those bytes.

The trade is that a raster picture **cannot follow the theme** the way an inlined
SVG does — it keeps its own colours on every theme, and gets
the round accent backdrop (`[data-art='photo']` in `styles/index.css`) that the
SVGs draw for themselves. Art must be **square, 256px or larger** (drawn at
32–120 CSS px on 2× screens, masked to a circle), readable at 40px, one subject,
no text in the picture, and small — everything here ships inside the installer
and must work with no internet, so keep each under ~40 KB. The contract is
restated for whoever draws them in that directory's `README.md`.

### Shared fixes (both builds)

- A synchronous lock in `SaleScreen` stops a double tap / F2 from posting the same
  cart twice before React re-renders.
- A refused split payment keeps the split dialog open with every tender intact.

### Verifying

`npx vitest --run tests/friendly-ui.test.tsx` — home groups and role visibility,
Continue sale, number pad, mixed tap/keyboard sign-in, Home/Back labels, checkout
wording, one sale per repeated tap, and inputs kept after a refused sale or split.
Not yet done: the staff walkthrough (sign in, sell, take payment, go home, find
stock counting, close shift) without coaching.


### Friendly upgrades: payment, installation, and recovery

Friendly uses one illustrated checkout: Take payment / F4 opens Cash, F5 opens
MoMo, F6 opens Pay later. Only the top dialog receives shortcuts. Escape returns
to the previous dialog or cart; it cannot clear the sale underneath. While saving,
controls and navigation are locked. Failed responses preserve entries; a transport
failure asks staff to check Recent sales before retrying because the save outcome
may be unknown. The app never retries a sale automatically.

The completion panel retains change and printer status until **Next sale**. Print
receipt retries printing without recording another sale. Friendly home uses six
compact illustrated tiles with three columns on wide screens. Split payment uses
labelled payment cards and shows the amount remaining.

Development and builds:

```bash
npm run dev:friendly
npm run build:friendly
npm run dist:win:friendly       # run on Windows or use release CI
npm run dist:mac:friendly
npm run dist:linux:friendly
```

On Windows, install `release/<version>/Counter-Friendly-Setup-<version>-x64.exe`
and launch **Counter Friendly**. Its database is
`%APPDATA%\Counter Friendly\counter.db`; standard Counter is independent. The
packaged app runs first-time setup for its own installation. Development runs
don't rename the app, so `dev:friendly` opens the same dev database as
`npm run dev` — do not run two development variants concurrently.
No existing Counter data is automatically imported.

Back up Friendly explicitly from a checkout:

```bash
npm run backup -- --variant friendly
npm run backup -- --variant friendly --keep 30 "D:\CounterFriendlyBackups"
```

The default destination is `~/CounterFriendlyBackups`; standard Counter keeps
`~/CounterBackups`. Friendly's automatic shift-close backup uses the same Friendly
default unless Settings selects another directory. Assign distinct custom backup
folders to each installation. Scheduled jobs must include `--variant friendly`.

To recover, close Counter Friendly, retain a copy of its current data folder,
and copy a known-good Friendly backup to that folder as `counter.db`. Move any
old `counter.db-wal` and `counter.db-shm` files into the retained copy before
reopening. Restore the matching photo archive into the `photos` subdirectory if
needed. On macOS the data folder is
`~/Library/Application Support/Counter Friendly`; on Linux it is
`${XDG_CONFIG_HOME:-~/.config}/Counter Friendly`. Restore only a Friendly backup
to this installation; data recorded after the snapshot will not be present.

## 14. Look and feel — the Harbour design system

The UI follows **Harbour** (`docs/design-system.md`): three themes (light,
dark, high contrast, plus "System"), Geist and Geist Mono, a fluid type scale
and one sea-teal accent. Counter Friendly swaps the fonts for Atkinson
Hyperlegible. Tokens live in `src/renderer/styles/index.css`; add a colour to
every theme block or `tests/theme-tokens.test.ts` fails, and the same test
fails any text/background pairing under WCAG AA (4.5:1). Keep every F-key and
each screen's primary action where it is: the redesign must not retrain staff.

Build screens from the shared components in `src/renderer/components/ui/`
(Button, Dialog, Sheet, Badge, Card, Table, Field, Input, NativeSelect,
Segmented, NavTab). Raw `<button>`s are only for clickable rows and tiles.
The Dialog keeps the till's keyboard rules — topmost-only Escape and F-keys,
a busy lock, focus return — and `tests/ui-components.test.tsx` holds it to
them. A dialog opened on top of another must render inside the other's
`DialogContent`; see "Dialog rules" in the design doc.

The sale screen's **quick picks** — the eight best sellers at this shop over
30 days, by units, as tiles added with Alt+1 … Alt+8 — come from
`topSellingProducts()` in `src/main/services/sales.ts` over
`product:top-sellers`. They are fetched once per shift, so positions don't
move mid-shift; a shop with no sales shows no strip.

Motion is CSS only and never makes the cashier wait: a new screen fades in
after it is already taking keys, dialogs animate in but close instantly, and
`prefers-reduced-motion` switches it all off ("Motion rules" in the design
doc; `tests/motion.test.tsx`).

## 15. Correcting a sale, and where refunds go

Three ways to fix a sale that's already been rung, all append-only:

| Situation | Path | Money |
|---|---|---|
| Missed items, same shift | **Correct** (cashier) | What was paid stays as it was (cash, MoMo with its reference, pay-later on the same customer and due date); the cashier says how the extra is paid. Only for today's sales in a shift that is still open, at that till. After the shift closes, ring the missed items as a new sale. |
| Wrong sale, customer changed mind | **Void request** → supervisor approves | The requester says whether the sale's cash goes back. If it does, the refund comes out of the requester's own drawer (or the sale's, for a supervisor with no shift) when approved, and that drawer can't close until then. "No cash changes hands" is for a sale rung by mistake. |
| Some items come back | **Customer return** (supervisor PIN) | Cash refunds come out of the current drawer. |

Every cash refund is a `cash_refunds` row (migration 0056) naming the drawer it
left. A sale's cash stays counted in the drawer that took it; the refund is
subtracted from the drawer that paid it (`src/main/services/drawerCash.ts`,
used by shift close, cash drops, "Cash in tills" and the position report). So a
refund for a sale from an earlier shift, or from another till, doesn't show as a
shortage on the wrong cashier.

Revenue and margin in the daily summary, Overview, Sales and Margin reports are
**net of customer returns**, dated the day of the return. The daily summary shows
the returns and the cash paid back. Refunds used to be recorded as cash drops
(notes `customer-refund:…`); those old rows stay as they were.

**Stock and returns guards** (`docs/reviews/2026-09-20-restock-and-return-safety.md`).
A sale can't take recorded stock below zero unless the cashier ticks **Restock
not recorded yet** (goods are here, the delivery isn't entered); it's per sale,
audited as `SALE_UNRECORDED_STOCK`, and Correct offers the same box. A return
names its original sale (`returnLimits.ts`): it can't return more of a product
than was sold or refund more than is left on the sale; a receipt-less return is
an explicit, audited exception. Migration 0055 lets valuation go negative until
the late delivery is entered.

Verify with `npx vitest --run tests/correctSale.test.ts tests/cash-refunds.test.ts tests/queuedVoids.test.ts tests/deferred-restock.test.ts`.

## 16. Version and updates

Settings → **About** shows which edition and version this till runs. Twice a
day (first check 20 s after start), the main process asks GitHub for the latest
release (`src/main/services/updateCheck.ts`). The request carries nothing about
the shop, only `User-Agent: Counter/<version>`. The answer is kept in
`<userData>/last_update_check.json`, so an offline till still shows the last
one. Set `COUNTER_UPDATE_CHECK=0` to switch the check off.

When a newer release exists, owners, founders and supervisors see a notice on
Home ("Remind tomorrow" hides it for a day, per version), and About lists the
steps and the exact installer for this edition and computer. **Download page**
opens the GitHub release on the shop PC only; a phone on the LAN can't make the
host open a browser. Nothing is downloaded or installed automatically.

To update a shop: close the day, back up and copy the backup to a USB stick,
close Counter, run the installer for the **same edition** over the old one, and
reopen. The data folder isn't touched, and Counter snapshots the database
before applying new migrations (§4). A different edition installs as a separate
app with its own empty database.

Publishing a release (§2a, tag `vX.Y.Z`) is what makes the notice appear. Drafts
and pre-releases are ignored.
