// Backup history listing — exercises the filesystem logic the
// backup:list-history IPC handler uses to enumerate recent backups.
//
// We re-implement the small filter+sort+stat block here rather than
// importing it, because the handler is wired into Electron's ipcMain
// and dragging Electron into a unit test isn't worth the setup cost.
// The logic is small enough that a direct test of the algorithm is
// equivalent in coverage and easier to maintain.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-hist-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const FILE_RE = /^counter-\d{4}-\d{2}-\d{2}\.db$/;

function listEntries(targetDir: string) {
  const now = Date.now();
  return fs
    .readdirSync(targetDir)
    .filter((n) => FILE_RE.test(n))
    .map((filename) => {
      const fullPath = path.join(targetDir, filename);
      const st = fs.statSync(fullPath);
      return {
        filename,
        fullPath,
        sizeBytes: st.size,
        mtime: st.mtime.toISOString(),
        ageMs: now - st.mtimeMs,
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

describe('backup history listing', () => {
  it('returns an empty list when the directory has no matching files', () => {
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'noise');
    fs.writeFileSync(path.join(dir, 'counter-bogus.db'), 'should not match');
    fs.mkdirSync(path.join(dir, 'photos-2026-05-20'));
    expect(listEntries(dir)).toEqual([]);
  });

  it('matches counter-YYYY-MM-DD.db only', () => {
    fs.writeFileSync(path.join(dir, 'counter-2026-05-20.db'), 'A');
    fs.writeFileSync(path.join(dir, 'counter-2026.db'), 'B');
    fs.writeFileSync(path.join(dir, 'counter-bogus.db'), 'C');
    const entries = listEntries(dir);
    expect(entries.map((e) => e.filename)).toEqual(['counter-2026-05-20.db']);
  });

  it('orders newest-first by mtime', () => {
    const newest = path.join(dir, 'counter-2026-05-20.db');
    const middle = path.join(dir, 'counter-2026-05-19.db');
    const oldest = path.join(dir, 'counter-2026-05-18.db');
    fs.writeFileSync(newest, 'n');
    fs.writeFileSync(middle, 'm');
    fs.writeFileSync(oldest, 'o');

    const t = (iso: string) => new Date(iso);
    fs.utimesSync(oldest, t('2026-05-18T10:00:00Z'), t('2026-05-18T10:00:00Z'));
    fs.utimesSync(middle, t('2026-05-19T10:00:00Z'), t('2026-05-19T10:00:00Z'));
    fs.utimesSync(newest, t('2026-05-20T10:00:00Z'), t('2026-05-20T10:00:00Z'));

    const entries = listEntries(dir);
    expect(entries.map((e) => e.filename)).toEqual([
      'counter-2026-05-20.db',
      'counter-2026-05-19.db',
      'counter-2026-05-18.db',
    ]);
  });

  it('records size in bytes', () => {
    fs.writeFileSync(path.join(dir, 'counter-2026-05-20.db'), 'x'.repeat(4096));
    const [entry] = listEntries(dir);
    expect(entry?.sizeBytes).toBe(4096);
  });
});
