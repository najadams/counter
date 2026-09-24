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

## Icons

Lucide (`lucide-react`, Phase 3), 1.75px stroke, `currentColor`, always
beside a word. They replace the Unicode glyphs (`×`, `→`, `✓`, `⚠`) in use
today. Friendly keeps its illustrated pictures.

## Quick picks (from Market)

A strip above the sale screen's search results:

- **What.** The 8 drinks sold most in the last 30 days at this shop, by
  units, each in its default sale unit. Refreshed when a shift opens.
- **How.** A tap or click adds one to the cart. **Alt+1 … Alt+8** from the
  keyboard (digits alone would type into search). Each tile shows its key.
- **Tile.** Name, size, price in accent-coloured mono, 84px tall, 4 per row
  on the counter PC. On a phone, a horizontal row of chips under the search.
- **Empty state.** A new shop with no sales yet shows no strip.

This needs a small query in the main process (top sellers by units) and
lands with the sale screen rebuild in Phase 3.

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
| `Input`, `Textarea`, `Select`, `Checkbox` | Form fields; each needs a visible label. |
| `Badge` | Status. `tone`: `neutral`, `accent`, `success`, `warning`, `danger`, plus the words. `lib/tones.ts` maps review statuses and severities. |
| `Card` | A white surface for a group of related content. |
| `Table` and parts | Data tables; money and quantity cells take `text-right font-mono tnum`. |
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

Mount a dialog only while it is open (`{open && <Dialog onClose={…}>…}`), as
the app always has. The older hand-built dialogs use `hooks/useDialog.ts`,
which follows the same rules; Phase 3 moves them over.

## Rollout

| Phase | What changes | State |
|---|---|---|
| 0 | Tailwind 4, bundled fonts, no visible change | PR #8 |
| D | Direction chosen: this document | Done |
| 1 | Harbour tokens: palette, three themes, fluid type, Geist, corners, motion | PR #9 |
| 2 | Shared components; every `.btn` and status badge moved onto them; Edit customer is the first dialog on `Dialog` | This branch |
| 3 | Screens move to the components (cards, tables, fields, the other dialogs); quick picks; lucide icons; charts on tokens | Next |
| 4 | Enter/exit motion, view transitions, cart animation | |
