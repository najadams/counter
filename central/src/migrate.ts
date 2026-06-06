// Apply schema.sql to the configured Postgres. Idempotent — safe to re-run.
//   npm run migrate

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './db.js';

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // schema.sql sits next to this file in src/; for compiled runs it is copied
  // alongside dist/ (see package.json build notes in README).
  const schemaPath = fs.existsSync(path.join(here, 'schema.sql'))
    ? path.join(here, 'schema.sql')
    : path.join(here, '..', 'src', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log(`schema applied from ${schemaPath}`);
  await closePool();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
