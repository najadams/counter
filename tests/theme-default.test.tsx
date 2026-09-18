// @vitest-environment jsdom
//
// What a device shows before anyone picks a theme. The store applies the
// choice at module load, so each case re-imports it with localStorage in the
// state under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'counter.theme';

async function bootStore() {
  vi.resetModules();
  return import('../src/renderer/store/theme');
}

/** jsdom has no matchMedia, and the store subscribes to it at module load. */
function stubMatchMedia(prefersLight: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersLight, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubMatchMedia(true);
});
afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('default theme', () => {
  it('is sea on a device that has never chosen', async () => {
    const { useTheme, DEFAULT_CHOICE } = await bootStore();
    expect(DEFAULT_CHOICE).toBe('sea');
    expect(useTheme.getState().choice).toBe('sea');
    expect(useTheme.getState().resolved).toBe('sea');
    expect(document.documentElement.getAttribute('data-theme')).toBe('sea');
  });

  it('never overrides a choice the device already stored', async () => {
    window.localStorage.setItem(KEY, 'dark');
    const { useTheme } = await bootStore();
    expect(useTheme.getState().choice).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to the default when the stored value is junk', async () => {
    window.localStorage.setItem(KEY, 'chartreuse');
    const { useTheme } = await bootStore();
    expect(useTheme.getState().choice).toBe('sea');
  });

  it('keeps "system" resolving to the OS light/dark pair, not sea', async () => {
    // Sea is a deliberate pick, not something the OS can ask for — otherwise
    // "Follow OS" would quietly mean something different per install.
    const { resolveChoice } = await bootStore();
    stubMatchMedia(true);
    expect(resolveChoice('system')).toBe('light');
    stubMatchMedia(false);
    expect(resolveChoice('system')).toBe('dark');
  });
});
