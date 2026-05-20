// Backup configuration: where backups go and how they're classified.
// Stored as rows in device_config (already created by migration 0012 +
// deviceId.ts as a safety net). No new table needed.
//
// Keys:
//   backup_target_dir       absolute filesystem path
//   backup_location_class   'usb' | 'cloud' | 'local'
//
// Unset → callers fall back to ~/CounterBackups + 'local'. We don't write
// the default at first run; only an explicit save persists.

import type { Database as DB } from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';

export type BackupLocationClass = 'usb' | 'cloud' | 'local';

export interface BackupConfig {
  targetDir: string;
  locationClass: BackupLocationClass;
  /** True when at least one explicit save has happened (vs returning defaults). */
  configured: boolean;
}

export function getBackupConfig(db: DB): BackupConfig {
  const rows = db
    .prepare(
      `SELECT key, value FROM device_config WHERE key IN ('backup_target_dir', 'backup_location_class')`,
    )
    .all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const rawClass = map.get('backup_location_class');
  const targetDir = map.get('backup_target_dir') ?? defaultBackupTarget();
  const locationClass: BackupLocationClass =
    rawClass === 'usb' || rawClass === 'cloud' || rawClass === 'local' ? rawClass : 'local';

  return {
    targetDir,
    locationClass,
    configured: map.has('backup_target_dir') || map.has('backup_location_class'),
  };
}

export function setBackupConfig(
  db: DB,
  cfg: { targetDir: string; locationClass: BackupLocationClass },
): void {
  const target = cfg.targetDir.trim();
  if (!target) throw new Error('backup target dir cannot be empty');
  if (!path.isAbsolute(target)) {
    throw new Error(`backup target dir must be an absolute path, got '${target}'`);
  }
  if (cfg.locationClass !== 'usb' && cfg.locationClass !== 'cloud' && cfg.locationClass !== 'local') {
    throw new Error(`backup location class must be usb|cloud|local, got '${cfg.locationClass}'`);
  }

  const upsert = db.prepare(
    `INSERT INTO device_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  const tx = db.transaction(() => {
    upsert.run('backup_target_dir', target);
    upsert.run('backup_location_class', cfg.locationClass);
  });
  tx();
}

/** Resolve the default backup directory: <home>/CounterBackups. */
export function defaultBackupTarget(): string {
  return path.join(os.homedir(), 'CounterBackups');
}
