// The Friendly illustration set and its palette.
//
// The drawings are ink-on-paper: a near-black outline around a light fill.
// That only works over a light backdrop, which is why the dark theme gets a
// parchment plate instead of the accent-tinted disc. Two ways to break it
// silently, both guarded here: reach for a class the stylesheet doesn't
// define, or let a colour follow the theme into light-on-light.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ART_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'illustrations');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'styles', 'index.css'),
  'utf-8',
);

const FILES = fs.readdirSync(ART_DIR).filter((f) => f.endsWith('.svg'));

function classesIn(svg: string): string[] {
  return [...svg.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/));
}

/** Base palette rules: class -> declaration body. */
function basePalette(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\.task-illustration ((?:\.il-[\w-]+,?\s*)+)\{([^}]*)\}/gms;
  for (let m = re.exec(CSS); m; m = re.exec(CSS)) {
    for (const cl of m[1]!.split(',')) {
      const name = cl.trim().replace(/^\./, '');
      if (name) out.set(name, (out.get(name) ?? '') + m[2]!);
    }
  }
  return out;
}

function darkOverrides(): Set<string> {
  return new Set(
    [...CSS.matchAll(/:root\[data-theme='dark'\] \.task-illustration \.(il-[\w-]+)/g)]
      .map((m) => m[1]!),
  );
}

describe('illustration palette', () => {
  const defined = basePalette();

  it('ships the whole named set', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(27);
  });

  it('only uses classes the stylesheet defines', () => {
    const unknown = new Set<string>();
    for (const f of FILES) {
      for (const cl of classesIn(fs.readFileSync(path.join(ART_DIR, f), 'utf-8'))) {
        if (!defined.has(cl)) unknown.add(`${f}: ${cl}`);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('keeps colour in the stylesheet, not inline on the shapes', () => {
    // An inline fill would survive the theme swap and go unnoticed until the
    // drawing is looked at on a theme nobody checked.
    const inline = FILES.filter((f) =>
      /style="|\sfill="(?!none")|\sstroke="/.test(fs.readFileSync(path.join(ART_DIR, f), 'utf-8')),
    );
    expect(inline).toEqual([]);
  });

  it('pins every theme-following colour for the dark theme', () => {
    // A class whose value resolves through --c-* changes with the theme. On
    // dark that lands light-on-light (or dark-on-dark), so each one must be
    // re-pointed under :root[data-theme='dark'].
    const overridden = darkOverrides();
    const follows = [...defined.entries()]
      .filter(([, body]) => body.includes('var(--c-'))
      .map(([name]) => name);
    expect(follows.length).toBeGreaterThan(0);
    expect(follows.filter((n) => !overridden.has(n))).toEqual([]);
  });
});
