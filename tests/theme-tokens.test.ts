// Theme tokens — every theme must define the same set.
//
// index.css says it outright: "Both dark and light blocks must define the
// same set or the theme swap will leave holes." A hole is invisible at build
// time and shows up as an unreadable control on one theme only, so this test
// compares the blocks directly. It also pins the choices the store accepts to
// the blocks that actually exist, so adding one without the other fails here
// rather than on a till.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'styles', 'index.css'),
  'utf-8',
);

function themeBlocks(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  const re = /:root\[data-theme='([\w-]+)'\] \{([\s\S]*?)\n\}/g;
  for (let m = re.exec(CSS); m; m = re.exec(CSS)) {
    const [, name, body] = m;
    // Skip the small per-theme overrides (.panel, .bg-scrim); only the token
    // blocks declare --c-* variables.
    const tokens = [...body!.matchAll(/(--c-[\w-]+):/g)].map((t) => t[1]!);
    if (tokens.length) out[name!] = new Set(tokens);
  }
  return out;
}

describe('theme tokens', () => {
  const blocks = themeBlocks();

  it('defines every theme the store can resolve to', () => {
    expect(Object.keys(blocks).sort()).toEqual(['contrast', 'dark', 'light']);
  });

  it('gives every theme the same token set', () => {
    const [reference, ...rest] = Object.entries(blocks);
    const [refName, refTokens] = reference!;
    for (const [name, tokens] of rest) {
      const missing = [...refTokens].filter((t) => !tokens.has(t));
      const extra = [...tokens].filter((t) => !refTokens.has(t));
      expect({ theme: name, missing, extra })
        .toEqual({ theme: name, missing: [], extra: [] });
    }
    expect(refTokens.size).toBeGreaterThan(15);
    expect(refName).toBeTruthy();
  });

  it('declares a color-scheme for each theme so form controls match', () => {
    for (const name of Object.keys(blocks)) {
      const block = new RegExp(`:root\\[data-theme='${name}'\\] \\{[\\s\\S]*?\\n\\}`).exec(CSS)![0];
      expect(block).toMatch(/color-scheme: (light|dark);/);
    }
  });
});

// docs/design-system.md promises WCAG AA (4.5:1) for every text/background
// pairing the UI actually uses. Check it here so a palette edit that breaks
// legibility fails CI instead of a till in the sun.
describe('theme contrast', () => {
  function channels(theme: string): Record<string, number[]> {
    const block = new RegExp(`:root\\[data-theme='${theme}'\\] \\{([\\s\\S]*?)\\n\\}`).exec(CSS)![1]!;
    const out: Record<string, number[]> = {};
    for (const m of block.matchAll(/(--c-[\w-]+):\s*(\d+) (\d+) (\d+);/g)) out[m[1]!] = [+m[2]!, +m[3]!, +m[4]!];
    return out;
  }
  function luminance([r, g, b]: number[]): number {
    const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  }
  function ratio(a: number[], b: number[]): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  const BACKGROUNDS = ['--c-bg-deep', '--c-bg-surface', '--c-bg-elevated'];
  const TEXT = ['--c-text-primary', '--c-text-secondary', '--c-text-tertiary',
    '--c-accent', '--c-success', '--c-danger', '--c-warning'];
  const FILLS = ['--c-accent', '--c-success', '--c-danger', '--c-warning'];

  for (const theme of ['light', 'dark', 'contrast']) {
    it(`${theme}: text and status colours read at 4.5:1 on every surface`, () => {
      const c = channels(theme);
      const failures: string[] = [];
      for (const fg of TEXT) for (const bg of BACKGROUNDS) {
        const r = ratio(c[fg]!, c[bg]!);
        if (r < 4.5) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });

    it(`${theme}: ink reads at 4.5:1 on accent and status fills`, () => {
      const c = channels(theme);
      const failures = FILLS
        .map((fill) => [fill, ratio(c['--c-text-ink']!, c[fill]!)] as const)
        .filter(([, r]) => r < 4.5)
        .map(([fill, r]) => `ink on ${fill}: ${r.toFixed(2)}`);
      expect(failures).toEqual([]);
    });
  }
});
