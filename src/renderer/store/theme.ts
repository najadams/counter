// theme.ts — runtime theme switcher.
//
// The choice persists in localStorage under THEME_KEY. On boot, the small
// inline script in index.html reads the same key synchronously *before*
// React mounts and sets <html data-theme="…"> so users don't see a flash
// of the wrong theme. This store is the React-side controller used by
// the Appearance section in Settings.
//
// Values (the Harbour design system, docs/design-system.md):
//   'light'    — Harbour light, the default for a new installation
//   'dark'     — Harbour dark
//   'contrast' — Harbour high contrast, for bright sun or low vision
//   'system'   — follow prefers-color-scheme; resolves to light or dark only
//                (high contrast is a deliberate pick, not something the OS asks for)
//
// Choices from before Harbour ('sea', 'violet') read as 'light', so a device
// that stored one opens on a theme that still exists.

import { create } from 'zustand';

export type ThemeChoice = 'light' | 'dark' | 'contrast' | 'system';
type ResolvedTheme = 'light' | 'dark' | 'contrast';

export const THEME_KEY = 'counter.theme';

/** What a device shows before anyone picks a theme. */
export const DEFAULT_CHOICE: ThemeChoice = 'light';

const RETIRED: Record<string, ThemeChoice> = { sea: 'light', violet: 'light' };

export function readStoredChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'contrast' || v === 'system') return v;
    if (v && RETIRED[v]) return RETIRED[v]!;
  } catch {
    /* localStorage may be unavailable; fall through to default */
  }
  return DEFAULT_CHOICE;
}

export function resolveChoice(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return choice;
}

function applyChoice(choice: ThemeChoice) {
  const resolved = resolveChoice(choice);
  document.documentElement.setAttribute('data-theme', resolved);
}

interface ThemeStore {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (c: ThemeChoice) => void;
}

const initialChoice = typeof window === 'undefined' ? DEFAULT_CHOICE : readStoredChoice();

// Apply the initial theme synchronously at module load. The inline script in
// index.html does this earlier (to prevent FOUC), but if it's blocked by CSP
// or otherwise missing, this guarantees the attribute is set before the
// first paint of any component that reads themed tokens.
if (typeof window !== 'undefined') {
  applyChoice(initialChoice);
}

export const useTheme = create<ThemeStore>((set) => ({
  choice: initialChoice,
  resolved: typeof window === 'undefined' ? resolveChoice(DEFAULT_CHOICE) : resolveChoice(initialChoice),
  setChoice: (c: ThemeChoice) => {
    try { window.localStorage.setItem(THEME_KEY, c); } catch { /* ignore */ }
    applyChoice(c);
    set({ choice: c, resolved: resolveChoice(c) });
  },
}));

// Subscribe to OS theme changes when the user has picked "system" — keep
// the resolved value in sync without requiring a reload.
if (typeof window !== 'undefined') {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', () => {
    const state = useTheme.getState();
    if (state.choice === 'system') {
      applyChoice('system');
      useTheme.setState({ resolved: resolveChoice('system') });
    }
  });
}
