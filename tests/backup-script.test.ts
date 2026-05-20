// Backup script (scripts/backup.cjs) — end-to-end check that:
//   1. The script runs against a sandboxed userData dir
//   2. It writes <userData>/last_backup.json
//   3. The JSON shape matches what the IPC heartbeat handler reads back
//   4. The runner's integrity check passes on a real SQLite source (the
//      whole point of having it).
//
// Ports the prior root-level _verify_backup_heartbeat.mjs scratch script
// into the vitest suite so it runs in CI.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

let tmp: string;
let env: NodeJS.ProcessEnv;
let userDataDir: string;
let target: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-bk-'));
  env = { ...process.env };
  if (process.platform === 'darwin') {
    env.HOME = tmp;
    userDataDir = path.join(tmp, 'Library', 'Application Support', 'Counter');
  } else if (process.platform === 'win32') {
    env.APPDATA = tmp;
    userDataDir = path.join(tmp, 'Counter');
  } else {
    env.XDG_CONFIG_HOME = tmp;
    userDataDir = path.join(tmp, 'Counter');
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  // Real SQLite source — needed because the runner integrity-checks the
  // destination via PRAGMA quick_check after VACUUM INTO. A stub byte blob
  // would correctly fail that check.
  const sourcePath = path.join(userDataDir, 'counter.db');
  const db = new Database(sourcePath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
  db.prepare('INSERT INTO t (x) VALUES (?)').run('hello');
  db.close();
  target = path.join(tmp, 'Backups');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('scripts/backup.cjs', () => {
  it('writes a heartbeat file at <userData>/last_backup.json', () => {
    execFileSync('node', [path.join(repoRoot, 'scripts/backup.cjs'), target], {
      env, stdio: 'pipe',
    });
    const heartbeatPath = path.join(userDataDir, 'last_backup.json');
    expect(fs.existsSync(heartbeatPath)).toBe(true);
  });

  it('heartbeat JSON has the shape the IPC handler reads', () => {
    const before = Date.now();
    execFileSync('node', [path.join(repoRoot, 'scripts/backup.cjs'), target], {
      env, stdio: 'pipe',
    });
    const after = Date.now();
    const raw = fs.readFileSync(path.join(userDataDir, 'last_backup.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      timestamp?: string; target?: string; usedVacuum?: boolean;
    };
    expect(typeof parsed.timestamp).toBe('string');
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const ts = Date.parse(parsed.timestamp ?? '');
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
    expect(parsed.target).toBe(target);
    expect(typeof parsed.usedVacuum).toBe('boolean');
  });

  it('a second run updates the heartbeat timestamp', async () => {
    execFileSync('node', [path.join(repoRoot, 'scripts/backup.cjs'), target], {
      env, stdio: 'pipe',
    });
    const heartbeatPath = path.join(userDataDir, 'last_backup.json');
    const firstTs = Date.parse(
      (JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')) as { timestamp: string }).timestamp,
    );
    await new Promise((r) => setTimeout(r, 1100));
    execFileSync('node', [path.join(repoRoot, 'scripts/backup.cjs'), target], {
      env, stdio: 'pipe',
    });
    const secondTs = Date.parse(
      (JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')) as { timestamp: string }).timestamp,
    );
    expect(secondTs).toBeGreaterThan(firstTs);
  });
});

describe('runner integrity check', () => {
  // Driving runBackup() directly here (not the CLI) so we can inspect the
  // structured failure code without an exit-code dance.
  type RunnerResult =
    | { ok: true; dbDest: string; sizeBytes: number; usedVacuum: boolean }
    | { ok: false; error: string; code?: string };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runBackup } = require(
    path.join(repoRoot, 'scripts/lib/backup-runner.cjs'),
  ) as {
    runBackup: (opts: {
      sourceDir: string;
      target: string;
      betterSqlite3Path?: string;
    }) => RunnerResult;
  };
  const betterSqlite3Path = path.join(repoRoot, 'node_modules/better-sqlite3');

  it('rejects + deletes a corrupt destination, no heartbeat written', () => {
    // Replace the valid source set up in beforeEach with garbage so VACUUM
    // INTO fails, the file-copy fallback fires, and the integrity check
    // catches the corrupt destination it produced.
    fs.writeFileSync(
      path.join(userDataDir, 'counter.db'),
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]),
    );

    const r = runBackup({
      sourceDir: userDataDir,
      target,
      betterSqlite3Path,
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('INTEGRITY_FAILED');
    expect(r.error).toMatch(/integrity|quick_check|cannot open/i);
    // Heartbeat MUST NOT be written on integrity failure — the home-screen
    // banner should keep warning.
    expect(fs.existsSync(path.join(userDataDir, 'last_backup.json'))).toBe(false);
    // Corrupt destination file should have been removed.
    const dest = fs.readdirSync(target).filter((n) => /^counter-.*\.db$/.test(n));
    expect(dest).toEqual([]);
  });

  it('passes integrity check on a real SQLite source and writes heartbeat', () => {
    // beforeEach already created a valid source. Just run the backup.
    const r = runBackup({
      sourceDir: userDataDir,
      target,
      betterSqlite3Path,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.usedVacuum).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'last_backup.json'))).toBe(true);
    // No leftover .tmp file from the atomic heartbeat write.
    expect(fs.existsSync(path.join(userDataDir, 'last_backup.json.tmp'))).toBe(false);
  });
});
