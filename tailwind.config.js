/** @type {import('tailwindcss').Config} */
// Design tokens locked in CLAUDE.md. The aesthetic is sharp, financial,
// gold-accented. Values resolve through CSS variables defined in
// src/renderer/styles/index.css so dark and light themes can swap at
// runtime by toggling the `data-theme` attribute on <html>.
//
// Add a colour by:
//   1. Adding a `--c-foo` variable to BOTH theme blocks in index.css.
//   2. Mapping `foo: 'rgb(var(--c-foo) / <alpha-value>)'` here.

const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          deep: v('--c-bg-deep'),
          surface: v('--c-bg-surface'),
          elevated: v('--c-bg-elevated'),
          input: v('--c-bg-input'),
          modal: v('--c-bg-modal'),
        },
        border: {
          DEFAULT: v('--c-border'),
          strong: v('--c-border-strong'),
          subtle: v('--c-border-subtle'),
        },
        text: {
          primary: v('--c-text-primary'),
          secondary: v('--c-text-secondary'),
          tertiary: v('--c-text-tertiary'),
        },
        // `ink` is a high-contrast foreground that always stays dark, even
        // in the light theme. It pairs with accent/warning/danger/success
        // surfaces (e.g. "bg-accent text-ink") so button text stays legible
        // after the theme flip. Top-level so the class is `text-ink`, not
        // `text-text-ink`.
        ink: v('--c-text-ink'),
        accent: {
          DEFAULT: v('--c-accent'),
          primary: v('--c-accent'),
          light: v('--c-accent-light'),
          dim: v('--c-accent-dim'),
        },
        success: v('--c-success'),
        danger: {
          DEFAULT: v('--c-danger'),
          light: v('--c-danger-light'),
        },
        warning: v('--c-warning'),
        // Note: the modal scrim is exposed as the `.bg-scrim` utility in
        // styles/index.css instead of a Tailwind color, because we want
        // the alpha baked into the utility (and theme-dependent).
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        // Sharp aesthetic: zero radius on buttons/inputs by default. Override
        // explicitly on the rare element where a curve is intentional.
        none: '0',
        DEFAULT: '0',
      },
    },
  },
  plugins: [],
};
