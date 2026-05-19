// Backup script (scripts/backup.cjs) — end-to-end check that:
//   1. The script runs against a sandboxed userData dir
//   2. It writes <userData>/last_backup.json
//   3. The JSON shape matches what the IPC heartbeat handler reads back
//
// Ports the prior root-level _verify_backup_heartbeat.mjs scratch script
// into the vitest suite so it runs in CI.
//
// VACUUM INTO will fail against the stub counter.db this test creates
// (it's not a valid SQLite file). The script catches that and falls back
// to file copy, which is exactly the path the test wants to exercise.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Stub counter.db — VACUUM INTO will fail against this and the script
  // falls back to plain file copy, which is the path we want to exercise
  // in a sandboxed test.
  fs.writeFileSync(
    path.join(userDataDir, 'counter.db'),
    Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]),
  );
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
