// Provision (or re-key) a shop and mint its bearer token. The plaintext token
// is printed ONCE — copy it into the shop's Settings -> Sync. Only its sha256
// hash is stored; re-running rotates the token and reactivates the shop.
//
//   npm run shop:add -- --id osu --name "Osu Counter"
//   npm run shop:add -- --id hq  --name "HQ" --hq
//   npm run shop:add -- --id osu --revoke

import { randomBytes } from 'node:crypto';
import { hashToken } from './auth.js';
import { pool, closePool } from './db.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const shopId = arg('id');
  if (!shopId) {
    throw new Error('usage: npm run shop:add -- --id <shop> [--name <name>] [--hq] [--revoke]');
  }

  if (flag('revoke')) {
    const res = await pool.query('UPDATE shops SET active = false WHERE shop_id = $1', [shopId]);
    // eslint-disable-next-line no-console
    console.log(res.rowCount ? `revoked ${shopId}` : `no such shop: ${shopId}`);
    await closePool();
    return;
  }

  const name = arg('name') ?? null;
  const role = flag('hq') ? 'HQ' : 'SHOP';
  const token = randomBytes(24).toString('base64url'); // ~32 url-safe chars
  const tokenHash = hashToken(token);

  await pool.query(
    `INSERT INTO shops (shop_id, name, token_hash, role, active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (shop_id) DO UPDATE
         SET name = excluded.name, token_hash = excluded.token_hash,
             role = excluded.role, active = true`,
    [shopId, name, tokenHash, role],
  );

  // eslint-disable-next-line no-console
  console.log(
    `\nProvisioned shop "${shopId}" (${role}).\n\n` +
      `  Sync token (shown once — store it now):\n\n    ${token}\n\n` +
      `Enter this under Settings -> Sync on the shop, with the central URL.\n`,
  );
  await closePool();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
