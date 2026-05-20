// backupConfig — getter/setter for backup_target_dir + backup_location_class
// rows in device_config.

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getBackupConfig,
  setBackupConfig,
  defaultBackupTarget,
} from '../src/main/db/backupConfig';

function freshDb() {
  const db = new Database(':memory:');
  // device_config is created by migration 0012 in production; emulate it here.
  db.exec(`
    CREATE TABLE device_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return db;
}

describe('getBackupConfig — unconfigured', () => {
  it('returns defaults when no rows exist', () => {
    const db = freshDb();
    const cfg = getBackupConfig(db);
    expect(cfg.targetDir).toBe(defaultBackupTarget());
    expect(cfg.locationClass).toBe('local');
    expect(cfg.configured).toBe(false);
  });
});

describe('setBackupConfig — happy paths', () => {
  it('persists target dir and location class as device_config rows', () => {
    const db = freshDb();
    setBackupConfig(db, { targetDir: '/Volumes/Backup', locationClass: 'usb' });
    const cfg = getBackupConfig(db);
    expect(cfg.targetDir).toBe('/Volumes/Backup');
    expect(cfg.locationClass).toBe('usb');
    expect(cfg.configured).toBe(true);
  });

  it('overwrites previous values on second save', () => {
    const db = freshDb();
    setBackupConfig(db, { targetDir: '/Volumes/A', locationClass: 'usb' });
    setBackupConfig(db, { targetDir: '/Users/me/Dropbox/Counter', locationClass: 'cloud' });
    const cfg = getBackupConfig(db);
    expect(cfg.targetDir).toBe('/Users/me/Dropbox/Counter');
    expect(cfg.locationClass).toBe('cloud');
  });
});

describe('setBackupConfig — validation', () => {
  it('rejects empty target dir', () => {
    const db = freshDb();
    expect(() => setBackupConfig(db, { targetDir: '   ', locationClass: 'local' }))
      .toThrow(/cannot be empty/);
  });

  it('rejects relative target dir', () => {
    const db = freshDb();
    expect(() => setBackupConfig(db, { targetDir: 'backups', locationClass: 'local' }))
      .toThrow(/absolute path/);
  });

  it('rejects unknown location class', () => {
    const db = freshDb();
    expect(() => setBackupConfig(
      db,
      // @ts-expect-error — testing runtime validation
      { targetDir: '/tmp/x', locationClass: 'remote' },
    )).toThrow(/usb\|cloud\|local/);
  });
});

describe('getBackupConfig — partial / invalid rows', () => {
  it('falls back to local when location_class is corrupt', () => {
    const db = freshDb();
    db.prepare("INSERT INTO device_config (key, value) VALUES (?, ?)").run('backup_target_dir', '/tmp/x');
    db.prepare("INSERT INTO device_config (key, value) VALUES (?, ?)").run('backup_location_class', 'remote');
    const cfg = getBackupConfig(db);
    expect(cfg.targetDir).toBe('/tmp/x');
    expect(cfg.locationClass).toBe('local');
    expect(cfg.configured).toBe(true);
  });
});
