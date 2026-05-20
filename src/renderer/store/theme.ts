// theme.ts — runtime theme switcher.
//
// The choice persists in localStorage under THEME_KEY. On boot, the small
// inline script in index.html reads the same key synchronously *before*
// React mounts and sets <html data-theme="…"> so users don't see a flash
// of the wrong theme. This store is the React-side controller used by
// the Appearance section in Settings.
//
// Values:
//   'dark'   — financial dark (default, original aesthetic)
//   'light'  — warm parchment light
//   'violet' — Sophon-inspired cool grey + vivid violet accent
//   'system' — follow prefers-color-scheme; resolves to dark or light only
//              (system follows OS dark/light, not violet)

import { create } from 'zustand';

export type ThemeChoice = 'dark' | 'light' | 'violet' | 'system';
type ResolvedTheme = 'dark' | 'light' | 'violet';

export const THEME_KEY = 'counter.theme';

export function readStoredChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'violet' || v === 'system') return v;
  } catch {
    /* localStorage may be unavailable; fall through to default */
  }
  return 'dark';
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

const initialChoice = typeof window === 'undefined' ? 'dark' : readStoredChoice();

// Apply the initial theme synchronously at module load. The inline script in
// index.html does this earlier (to prevent FOUC), but if it's blocked by CSP
// or otherwise missing, this guarantees the attribute is set before the
// first paint of any component that reads themed tokens.
if (typeof window !== 'undefined') {
  applyChoice(initialChoice);
}

export const useTheme = create<ThemeStore>((set) => ({
  choice: initialChoice,
  resolved: typeof window === 'undefined' ? 'dark' : resolveChoice(initialChoice),
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
