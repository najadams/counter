# Counter — Operator runbook & build notes

Keyboard-first Electron POS for a Ghanaian beverage shop. Anti-shrinkage
forensics on every cedi.

This file is the practical companion to the design docs. If the design doc
asks "what should this do?", this file answers "how do I run it, build it,
and recover when it breaks?"

## 1. Quick start (developer)

```bash
npm install
npm run db:reset      # wipes ./dev.db and reapplies all migrations
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

The app stores its DB at the OS userData dir in production, and at
`./dev.db` in dev. Photos for breakage live under
`<userData>/photos/breakage/YYYY/MM/`.

## 2. Building installers

The build is shaped by `build` in `package.json` (electron-builder).

| Command            | Output                                                          |
|--------------------|------------------------------------------------------------------|
| `npm run dist:win` | `release/0.1.0/Counter-Setup-0.1.0-x64.exe` (NSIS installer)    |
| `npm run dist:mac` | `release/0.1.0/Counter-0.1.0-arm64.dmg` (and -x64 if hosted)    |
| `npm run dist:linux` | `release/0.1.0/Counter-0.1.0-x64.AppImage`                    |

Targets configured: nsis (Windows), dmg (Mac), AppImage (Linux).

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
`.exe` lands in `release/0.1.0/`. The `postinstall` script runs
`electron-builder install-app-deps` to rebuild native modules against the
Electron ABI; that's why a fresh clone on the target machine works, but
copying `node_modules` across OS lines does not.

## 3. Installing on the counter PC (Windows)

1. Copy `Counter-Setup-0.1.0-x64.exe` to the PC (USB stick, network share,
   whatever). Verify the file size matches the build machine's copy — a
   truncated installer is the most common ghost.
2. Double-click the installer. NSIS prompts for an install path; the
   default (`C:\Users\<user>\AppData\Local\Programs\Counter`) is fine for
   a single-user install. The installer creates a Desktop shortcut and a
   Start Menu entry called "Counter".
3. Launch Counter. The first run will:
   - Create the SQLite database at
     `C:\Users\<user>\AppData\Roaming\Counter\counter.db`
   - Apply all 17 migrations (or however many ship)
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
`pending_receipt_reprints` table — see Settings → Reprint Queue once that
screen ships.

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
| "Migration failed: 00xx_*.sql"                     | Same log; restore from last backup          |
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
