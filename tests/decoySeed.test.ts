import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { ensureCountersDecoySeed, refreshCountersDecoyData } from '../src/main/services/decoySeed';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

let db: ReturnType<typeof Database>;
let tempDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-decoy-test-'));
  const emptyCatalog = path.join(tempDir, 'empty-catalog.db');
  new Database(emptyCatalog).close();
  process.env['COUNTERS_CATALOG_DB'] = emptyCatalog;

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
});

afterEach(() => {
  db.close();
  delete process.env['COUNTERS_CATALOG_DB'];
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('Counters weekday-only camouflage records', () => {
  it('seeds weekday history and creates no new operational records on weekends', () => {
    // Saturday in Accra/UTC. Initial generation should stop at Friday and
    // omit both Saturday and the preceding Sunday from the rolling history.
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    ensureCountersDecoySeed(db, 'decoy-test-device', tempDir);

    for (const tableAndDate of [
      ['sales', 'created_at'],
      ['shifts', 'opened_at'],
      ['stock_movements', 'created_at'],
    ] as const) {
      const weekendRows = db.prepare(
        `SELECT COUNT(*) AS count FROM ${tableAndDate[0]}
          WHERE strftime('%w', ${tableAndDate[1]}) IN ('0', '6')`,
      ).get() as { count: number };
      expect(weekendRows.count, tableAndDate[0]).toBe(0);
    }

    const weekendSummaries = db.prepare(
      "SELECT COUNT(*) AS count FROM daily_summaries WHERE strftime('%w', summary_date) IN ('0', '6')",
    ).get() as { count: number };
    expect(weekendSummaries.count).toBe(0);
    expect(db.prepare('SELECT MAX(summary_date) AS date FROM daily_summaries').get())
      .toEqual({ date: '2026-07-31' });

    const before = db.prepare(
      'SELECT (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM shifts) AS shifts, (SELECT COUNT(*) FROM daily_summaries) AS summaries',
    ).get();
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    refreshCountersDecoyData(db, 'decoy-test-device');
    const after = db.prepare(
      'SELECT (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM shifts) AS shifts, (SELECT COUNT(*) FROM daily_summaries) AS summaries',
    ).get();
    expect(after).toEqual(before);
  });
});
