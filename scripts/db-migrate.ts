// Apply any pending migrations against an existing DB. No wipe, no seed.
// Safe to run in production.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect, defaultMigrationsDir } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';

function devUserDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Counter');
    case 'win32':
      return path.join(process.env['APPDATA'] ?? home, 'Counter');
    default:
      return path.join(home, '.config', 'Counter');
  }
}

function main() {
  const userData = process.env['COUNTER_USER_DATA'] ?? devUserDataDir();
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, 'counter.db');

  console.log(`[db:migrate] target: ${dbPath}`);
  const db = connect({ filePath: dbPath, verbose: false });
  const result = runMigrations(db, defaultMigrationsDir());
  if (result.applied.length === 0) {
    console.log('[db:migrate] up to date (no pending migrations)');
  } else {
    console.log(`[db:migrate] applied ${result.applied.length} migrations:`);
    for (const f of result.applied) console.log(`  - ${f}`);
  }
  db.close();
}

main();
