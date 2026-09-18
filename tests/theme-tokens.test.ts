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
    expect(Object.keys(blocks).sort()).toEqual(['dark', 'light', 'sea', 'violet']);
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
