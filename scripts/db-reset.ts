// Wipes counter.db, re-runs all migrations, seeds dev fixtures.
// Dev only. Never run this in production.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect, defaultMigrationsDir } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { runSeed } from '../src/main/db/seed.js';

function devUserDataDir(): string {
  // Mirrors what Electron's app.getPath('userData') would return for our app
  // in dev — but we don't have access to Electron here, so we emulate.
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

  console.log(`[db:reset] target: ${dbPath}`);

  // Clean up DB + WAL/SHM if they exist.
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[db:reset] removed ${p}`);
    }
  }

  const db = connect({ filePath: dbPath, verbose: false });
  const migrationsDir = defaultMigrationsDir();
  console.log(`[db:reset] migrations dir: ${migrationsDir}`);

  const result = runMigrations(db, migrationsDir);
  console.log(`[db:reset] applied ${result.applied.length} migrations:`);
  for (const f of result.applied) console.log(`  - ${f}`);

  runSeed(db, { includeDevFixtures: true });
  console.log('[db:reset] dev fixtures seeded');

  // Quick sanity sums.
  const counts = {
    workers: (db.prepare('SELECT COUNT(*) AS n FROM workers').get() as { n: number }).n,
    products: (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n,
    suppliers: (db.prepare('SELECT COUNT(*) AS n FROM suppliers').get() as { n: number }).n,
    locations: (db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number }).n,
    reasonCodes: (db.prepare('SELECT COUNT(*) AS n FROM reason_codes').get() as { n: number }).n,
    paymentMethods: (db.prepare('SELECT COUNT(*) AS n FROM payment_methods').get() as { n: number }).n,
  };
  console.log('[db:reset] row counts:', counts);

  db.close();
  console.log('[db:reset] done.');
}

main();
