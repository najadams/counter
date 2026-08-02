import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  _clearReportAccessTokens,
  lockReportAccess,
  reportAccessStatus,
  requireReportAccess,
  touchReportAccess,
  unlockReportAccess,
} from '../src/main/services/reportAccess';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const SUPERVISOR = 'dev-supervisor-1';
const COUNTER = 'dev-counter-1';
const DEVICE = 'reports-device';
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  _clearReportAccessTokens();
});
afterEach(() => { _clearReportAccessTokens(); db.close(); });

describe('five-minute report access', () => {
  it('unlocks the correct worker, grants scoped access, and never accepts a different device', () => {
    const unlocked = unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '9999', deviceId: DEVICE, now: 1_000,
    });
    expect(unlocked.scopes).toEqual(['OPERATIONAL']);
    expect(() => requireReportAccess({
      accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: 'other', now: 2_000,
    })).toThrow(/REPORT_ACCESS_LOCKED/);
    expect(() => requireReportAccess({
      accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, scope: 'OWNER', now: 2_000,
    })).toThrow(/Owner reports/);
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SUPERVISOR);
    const owner = unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '9999', deviceId: DEVICE, now: 2_000,
    });
    expect(owner.scopes).toEqual(['OPERATIONAL', 'OWNER']);
  });

  it('expires at five idle minutes and genuine touches extend that deadline', () => {
    const unlocked = unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '9999', deviceId: DEVICE, now: 1_000,
    });
    expect(reportAccessStatus({ accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, now: 300_999 }).unlocked).toBe(true);
    const touched = touchReportAccess({
      accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, now: 250_000,
    });
    expect(touched.idleExpiresAt).toBe(new Date(550_000).toISOString());
    expect(reportAccessStatus({ accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, now: 549_999 }).unlocked).toBe(true);
    expect(reportAccessStatus({ accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, now: 550_000 }).unlocked).toBe(false);
  });

  it('rejects a wrong PIN and roles below supervisor', () => {
    expect(() => unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '0000', deviceId: DEVICE,
    })).toThrow(/PIN check failed/);
    expect(() => unlockReportAccess(db, {
      workerId: COUNTER, pin: '1234', deviceId: DEVICE,
    })).toThrow(/require SUPERVISOR/);
  });

  it('manual lock revokes immediately and records the reason', () => {
    const unlocked = unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '9999', deviceId: DEVICE, now: 1_000,
    });
    lockReportAccess(db, {
      accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, reason: 'MANUAL',
    });
    expect(reportAccessStatus({ accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, now: 2_000 }).unlocked).toBe(false);
    const audit = db.prepare("SELECT after_value FROM audit_log WHERE action = 'REPORT_ACCESS_LOCKED' ORDER BY created_at DESC LIMIT 1").get() as { after_value: string };
    expect(JSON.parse(audit.after_value)).toMatchObject({ reason: 'MANUAL' });
  });

  it('process restart semantics invalidate every in-memory token', () => {
    const unlocked = unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '9999', deviceId: DEVICE, now: 1_000,
    });
    _clearReportAccessTokens();
    expect(reportAccessStatus({ accessToken: unlocked.accessToken, workerId: SUPERVISOR, deviceId: DEVICE, now: 2_000 }).unlocked).toBe(false);
  });

  it('invalidates an existing token when the worker becomes inactive or loses the required role', () => {
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SUPERVISOR);
    const owner = unlockReportAccess(db, {
      workerId: SUPERVISOR, pin: '9999', deviceId: DEVICE, now: 1_000,
    });
    db.prepare("UPDATE workers SET role = 'SUPERVISOR' WHERE id = ?").run(SUPERVISOR);
    expect(() => requireReportAccess({
      db, accessToken: owner.accessToken, workerId: SUPERVISOR, deviceId: DEVICE,
      scope: 'OWNER', now: 2_000,
    })).toThrow(/Owner reports/);
    db.prepare('UPDATE workers SET active = 0 WHERE id = ?').run(SUPERVISOR);
    expect(() => requireReportAccess({
      db, accessToken: owner.accessToken, workerId: SUPERVISOR, deviceId: DEVICE,
      scope: 'OPERATIONAL', now: 3_000,
    })).toThrow(/REPORT_ACCESS_LOCKED/);
  });
});
