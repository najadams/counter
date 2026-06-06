// Per-shop bearer-token authentication. The shop presents `Authorization:
// Bearer <token>`; we sha256 it and look up the owning shop. The token -> shop
// binding is authoritative: the caller IS whatever shop the token belongs to,
// so a leaked token from shop A cannot act as shop B (design §B8).

import { createHash } from 'node:crypto';
import { query } from './db.js';

export type ShopRole = 'SHOP' | 'HQ';
export interface AuthedShop {
  shopId: string;
  role: ShopRole;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Resolve the Authorization header to an active shop, stamping last_seen_at in
 *  the same round-trip. Returns null for missing/malformed/unknown/revoked. */
export async function authenticate(authHeader: string | undefined): Promise<AuthedShop | null> {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const hash = hashToken(match[1]!.trim());
  const rows = await query<{ shop_id: string; role: ShopRole }>(
    `UPDATE shops SET last_seen_at = now()
       WHERE token_hash = $1 AND active = true
       RETURNING shop_id, role`,
    [hash],
  );
  const row = rows[0];
  return row ? { shopId: row.shop_id, role: row.role } : null;
}
