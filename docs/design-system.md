# Harbour — Counter's design system

Chosen 2026-09-23 from three directions (Harbour, Market, Console) on the
[design canvas](https://claude.ai/artifact/4isbsnSNqWuLqxsTJ7q7iQ): **Harbour,
with Market's quick picks** on the sale screen. The canvas's "Chosen" row is
the visual reference; this file is the rulebook. Tokens live in
`src/renderer/styles/index.css`.

Harbour is calm and precise. The page recedes, one sea-teal accent does the
pointing, and money is always set in a monospaced face so columns line up.
It grew out of the old Sea theme, so staff see an evolution, not a new app.

## Rules that do not bend

- **Keys stay put.** Every F-key and each screen's primary action keeps its
  place. A redesign that makes staff relearn the till has failed.
- **Offline.** Every font, icon and picture ships inside the installer.
- **Legible.** Every text/background pairing clears WCAG AA (4.5:1);
  `tests/theme-tokens.test.ts` fails CI when a palette edit breaks this.
- **Money is monospaced.** Amounts, quantities, SKUs and keys use
  `font-mono` + `tnum`.

## Themes

| Choice | For | Notes |
|---|---|---|
| **Light** (default) | Most shops | Off-white page, teal accent, white ink on fills |
| **Dark** | Dim shops, night shifts | Same teal lifted to `#3CB3C8`; dark ink on fills |
| **High contrast** | Bright sun, low vision | White page, near-black ink, 5:1 borders, accents at 7:1+, solid ink focus ring |
| **System** | Following the OS | Resolves to light or dark only — never high contrast |

Set per device in Settings → Appearance (`src/renderer/store/theme.ts`).
Devices that stored the retired `sea` or `violet` themes open on Light.

## Colour tokens

Each is an RGB-channel variable (`--c-*`) used through Tailwind names
(`bg-bg-deep`, `text-text-secondary`, `border-border-strong`, `bg-accent/10`).

| Token | Light | Dark | High contrast | Role |
|---|---|---|---|---|
| `bg-deep` | `#F3F6F7` | `#0A1316` | `#FFFFFF` | Page |
| `bg-surface` | `#EAF0F2` | `#101C20` | `#EEF2F3` | Recessed panels, bars |
| `bg-elevated` | `#FFFFFF` | `#152429` | `#FFFFFF` | Cards; hover on a surface |
| `border` / `-strong` | `#DCE5E8` / `#B8C8CD` | `#213439` / `#34494F` | `#5E7178` / `#0F2A33` | Dividers / inputs |
| `text-primary` | `#0F2A33` | `#E4EDEF` | `#06161B` | Body text |
| `text-secondary` | `#475C64` | `#93A7AD` | `#2D4047` | Labels |
| `text-tertiary` | `#56707A` | `#7A8E94` | `#3A4F57` | Hints — still 4.5:1 |
| `accent` | `#0B6E83` | `#3CB3C8` | `#005566` | Primary action, focus, selection |
| `ink` | white | `#03171C` | white | Text on accent and status fills |
| `success` / `danger` / `warning` | `#146C3C` / `#B42318` / `#8F5400` | `#4CC98A` / `#FF7A6E` / `#F2B45A` | `#0A5A2E` / `#8E1B12` / `#6A3E00` | Status; each works as a fill and as text |

## Type

- **Geist** for words, **Geist Mono** for money, quantities, SKUs and keys
  (`@fontsource-variable/geist`, `…/geist-mono`).
- **Counter Friendly** uses **Atkinson Hyperlegible Next** and **Mono**,
  designed for low-vision readers. Loaded only in that build, through
  `virtual:friendly-fonts` in `vite.config.mts`.
- **Fluid scale.** Each Tailwind step is its classic size on a 375px phone
  and grows linearly to 1.15× at 1920px:

  | Class | 375px | 1366px | 1920px |
  |---|---|---|---|
  | `text-xs` | 12px | 13.2px | 13.8px |
  | `text-sm` | 14px | 15.3px | 16.1px |
  | `text-base` | 16px | 17.5px | 18.4px |
  | `text-lg` | 18px | 19.7px | 20.7px |
  | `text-2xl` | 24px | 26.3px | 27.6px |
  | `text-4xl` | 36px | 39.5px | 41.4px |

  Line-heights scale the same way and stay lengths, not ratios.
- **Sale screen** adds `sale-type`: one notch (×1.05) larger at 1024px and
  up, matching the old 1.15 CSS zoom at 1366px without zoom's layout side
  effects. Cashiers read it standing, often in poor light.

## Shape, depth, motion

- **Corners.** Controls 8px (bare `rounded`), cards 12px (`rounded-xl`),
  dialogs and sheets 16px (`rounded-2xl`), chips and badges fully round.
- **Depth.** Cards: a 1px border plus a soft two-layer shadow. Dark uses a
  deeper shadow; high contrast drops shadows and relies on borders.
- **Spacing.** Fluid `p-gutter` (16→32px) for page edges and `gap-section`
  (16→28px) between sections.
- **Motion.** Short and calm: `--duration-fast` 120ms, `--duration-base`
  200ms, `--ease-standard`. `prefers-reduced-motion` finishes transitions
  instantly; the sale-complete flash stays, because it is a colour signal.

### Motion rules

The till is keyboard-first, so **motion never delays or swallows input**.
Every animation starts after its element is already in the DOM, focused
and taking keys, and only opacity, translate, scale and colour move (cheap
for the GPU on a modest PC). `tests/motion.test.tsx` holds these.

| What | How |
|---|---|
| **Screen change** | The new screen fades up 6px over 200ms (`screen-in` on `#root > *`). Every screen is a direct child of `#root`, so this plays on each change and never on a re-render. Not the View Transitions API: that applies the change a frame late (after snapshotting the old screen), so F1 then typing could send a key to the old screen, and its overlay blocks clicks while it runs. |
| **Dialogs, sheets** | Enter: scale from 95% and fade (sheets slide 40px; the Friendly checkout rises from the bottom on a phone). Exit: none. The app unmounts a dialog the moment it is dismissed, so the next key goes to the screen at once; a closing animation would leave it half there while Escape-then-F5 raced it. |
| **Selects, popovers, tooltips** | Enter and exit (Base UI owns their open state). |
| **New cart line** | `animate-cart-line-in`: eases down 6px with a brief accent wash, so the cashier sees what the scan or tap added. |
| **A changed figure** | `animate-value-bump`: the line total and the cart total pop once in the accent when they change (the element is keyed on its value), so a second press of the same pick visibly registers. |
| **Disclosure** | `animate-reveal`: a Friendly home group fades in as it opens. |
| **Loading reports** | `ReportSkeleton`: placeholder stat cards and rows in the report's shape, so nothing jumps when the numbers land; screen readers hear the old "Loading…" words. |

## Layout

- **Raw elements are for content, not actions.** An action is a `Button`;
  a list row, tile or card that happens to be clickable (search results,
  pickers, home tiles, payment-method tiles) stays a styled `<button>`.
- **Surfaces.** A group of content sits on a white card (`Card` or
  `.panel`). Anything that needs its own fill inside one uses `bg-surface`
  (a recessed well); selection inside a card is `bg-accent/10`.
- **Fit the pane, not the window.** Screens mark their content area as a
  size container (`@container`) and grids use container breakpoints
  (`@xl:`, `@2xl:`, `@4xl:`, `@6xl:`), so a report or settings tab reflows
  for the space it actually has. Home keeps its two columns of tiles (three
  in Friendly from 64rem) — staff find tiles by position. Quick picks go
  from chips to three tiles at 32rem of search pane, four at 42rem.
- Container queries never match inside a dialog (it portals to `<body>`),
  so dialog content uses plain widths or window breakpoints.

## Icons

Lucide (`lucide-react`), `currentColor`, always beside a word or with an
`aria-label` when alone (a close cross, a sort chevron). They replaced the
Unicode glyphs that stood in for controls: back arrows, sort and expand
chevrons, trend arrows, warnings, checks, the number-pad delete key. Glyphs
that are typography stay as text: `×` in "2 × 8.00", key labels like `↑`,
and arrows inside plain sentences ("Settings → Products"). Friendly keeps
its illustrated pictures.

## Charts

Eight series colours per theme, `--c-chart-1` … `--c-chart-8` (teal, green,
orange, red, blue, slate, violet, rose), each at least 3:1 against a card —
`tests/theme-tokens.test.ts` checks. Recharts needs real colour strings, so
`useChartTheme()` (`src/renderer/lib/chartTheme.ts`) reads the series,
grid, axis, label and tooltip colours from the live theme and re-reads them
when the theme changes. A measure keeps one colour everywhere: revenue is
the accent, profit green, expenses red. Axis numbers use the mono face.

## Quick picks (from Market)

A strip above the sale screen's search results:

- **What.** The 8 drinks sold most in the last 30 days at this shop, by
  units, each in its default sale unit. Refreshed when a shift opens.
- **How.** A tap or click adds one to the cart. **Alt+1 … Alt+8** from the
  keyboard (digits alone would type into search). The tiles don't draw their
  keys: the sale screen's key-hint row lists "Alt+1–8 Quick pick" once, and
  each tile carries its key in `aria-keyshortcuts` for screen readers.
- **Tile.** Name (up to two lines), unit, price in accent-coloured mono. At
  least 84px tall (96px in Friendly), 4 per row on the counter PC; every row
  grows to the tallest tile rather than clipping a long name. On a phone, a
  horizontal row of chips under the search.
- **Empty state.** A new shop with no sales yet shows no strip.
- **Stable.** Fetched once per shift and channel, then held, so tiles and
  their Alt keys don't move under a cashier's hands mid-shift. Alt+N does
  nothing while a dialog is open.

Built from `topSellingProducts()` in `src/main/services/sales.ts` (canonical
units, so a crate of 24 counts as 24; voided sales don't count), the
`product:top-sellers` channel, and `components/QuickPicks.tsx`. It returns
exactly the rows search returns, so a tile adds the same cart line a search
hit would. Tests: `tests/top-sellers.test.ts`, `tests/quick-picks.test.tsx`.

## Components

`src/renderer/components/ui/` holds the shared parts, generated with the
shadcn CLI on Base UI and rewritten in Harbour's token names. We own this
code: change a component here and every screen follows. Class names are
joined with `cn()` from `src/renderer/lib/cn.ts`, so a `className` passed in
overrides the component's own.

To add one, generate it in a scratch project, not this repo, because the CLI
rewrites the stylesheet with its own colour names:
`npx shadcn@latest init -t vite -b base -p nova`, then
`npx shadcn@latest add <name>`. Copy the file here, swap shadcn's names
(`primary`, `muted`, `popover`, `ring`, `accent` as a hover grey) for
Harbour's, import `cn` from `lib/cn`, and give anything that takes a `ref`
a `forwardRef` (React 18).

| Part | Use it for |
|---|---|
| `Button` | Every button. `variant`: `primary` (the one main action), `secondary` (default), `ghost`, `danger`, `success`, `warning`, `destructive` (filled; the confirming step of something irreversible), `link`. `size`: `sm`, `md`, `lg`, `xl`, `icon`. `shortcut="F2"` shows the key and sets `aria-keyshortcuts`. A native `<button>`, so it still submits a form. |
| `Dialog`, `Sheet` | Anything that takes over the screen until answered. See the rules below. |
| `Input`, `Textarea`, `NativeSelect`, `Select`, `Checkbox` | Form fields; each needs a visible label. Prefer `NativeSelect` for short fixed lists (it keeps the browser's type-to-jump keys); `Select` for rich items. |
| `Field` | A visible label around one control, with an optional hint. Wrapping the control names it without ids. |
| `Segmented` | Two to four mutually exclusive buttons that switch a view or mode in place (Pending / History, Walk-in / Wholesale / Route, date presets). Real buttons with `aria-pressed`. `size` `sm`/`md`/`lg` (Friendly), `fill` to share the full width, `value={null}` when none applies. |
| `NavTab` | The underline section tabs across the top of a screen (Settings, Reports, a customer's record, Money out). The current one carries `aria-current`. |
| `Badge` | Status. `tone`: `neutral`, `accent`, `success`, `warning`, `danger`, plus the words. `lib/tones.ts` maps review statuses and severities. |
| `Card` | A white surface for a group of related content. The older `.panel` class is the same card; inside either, give a nested fill `bg-surface` (a recessed well), never `bg-elevated`, which vanishes into the card. |
| `Table` and parts | Every data table. Money and quantity cells take `text-right font-mono tnum`; cells keep their own padding where a report wants density. `scroll={false}` drops the table's own horizontal scroller, for a table in a panel that already scrolls and has a sticky header. The paper surfaces (statement, receipt, PIN cards, runbook) stay plain black-on-white tables. |
| `Tabs` | `segmented` for switching a view in place, `line` for sections of a screen. |
| `Tooltip`, `Popover` | Extra explanation, never the only copy of something needed. |
| `Kbd`, `Separator`, `Skeleton`, `ScrollArea`, `Toaster` | As named. Toasts are for short confirmations only; errors stay inline. |

### Dialog rules

Dialogs keep the till's keyboard contract (`components/ui/dialog.tsx`,
tested in `tests/ui-components.test.tsx`):

- Only the **topmost** open dialog receives Escape and F1–F12. They are
  caught before any screen handler, so Escape in a payment dialog can never
  also clear the sale underneath.
- While `busy` (saving), Escape, F-keys and outside clicks do nothing.
- Focus moves inside, stays trapped there, and returns to the opener when
  the dialog goes away. Point `initialFocus` at the field staff type into
  first.
- The page behind is hidden from screen readers; `DialogTitle` names the
  dialog.
- A dialog that opens on top of another renders **inside** the other's
  `DialogContent` (supervisor approval inside the checkout, the receipt
  inside Sale complete). Base UI stacks dialogs by React nesting; side by
  side, each hides the other and their focus traps compete.
- Something that must be a direct child of `<body>` (the receipt's print
  stylesheet) passes `portalProps={{ container: document.body }}`.

Mount a dialog only while it is open (`{open && <Dialog onClose={…}>…}`), as
the app always has. Every dialog in the app now uses `Dialog` or `Sheet`;
`hooks/useDialog.ts` is gone.

## Rollout

| Phase | What changes | State |
|---|---|---|
| 0 | Tailwind 4, bundled fonts, no visible change | PR #8 |
| D | Direction chosen: this document | Done |
| 1 | Harbour tokens: palette, three themes, fluid type, Geist, corners, motion | PR #9 |
| 2 | Shared components; every `.btn` and status badge moved onto them; Edit customer is the first dialog on `Dialog` | PR #10 |
| 3 | Every dialog on `Dialog`/`Sheet`; quick picks; lucide icons; charts on tokens; panels as white cards | PR #11 |
| 3b | Screens' buttons, fields and tables onto the components; `NavTab`; grey containers become cards; `@container` layouts for sale, home, reports and settings | PR #12 |
| 4 | Motion: screen fade-in, dialog enter, cart line and total animation, disclosure reveal, report skeletons | This branch |
