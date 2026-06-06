// Sync provisioning lives in device_config (the existing KV store). A shop is
// "provisioned" once it has a shop_id, a central URL, and a per-shop token —
// set later via Settings -> Sync. Until then readSyncConfig returns null and
// no sync worker runs, so a single-shop install opens no outbound connection.

import type { Database as DB } from 'better-sqlite3';

export interface SyncConfig { shopId: string; centralUrl: string; token: string; role: 'HQ' | 'SHOP'; }

export function readSyncConfig(db: DB): SyncConfig | null {
  const get = (k: string): string | undefined =>
    (db.prepare('SELECT value FROM device_config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const shopId = get('shop_id');
  const centralUrl = get('central_url');
  const token = get('central_token');
  if (!shopId || !centralUrl || !token) return null;
  const role = get('sync_role') === 'HQ' ? 'HQ' : 'SHOP';
  return { shopId, centralUrl, token, role };
}

export interface SyncConfigView {
  shopId: string | null;
  centralUrl: string | null;
  role: 'HQ' | 'SHOP';
  hasToken: boolean;
}

/** Config for display/editing (never returns the token plaintext). */
export function readSyncConfigView(db: DB): SyncConfigView {
  const get = (k: string): string | undefined =>
    (db.prepare('SELECT value FROM device_config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  return {
    shopId: get('shop_id') ?? null,
    centralUrl: get('central_url') ?? null,
    role: get('sync_role') === 'HQ' ? 'HQ' : 'SHOP',
    hasToken: Boolean(get('central_token')),
  };
}

/** Upsert the sync provisioning keys. A blank/absent token leaves the stored
 *  one untouched (so editing the URL doesn't force re-entering the secret). */
export function writeSyncConfig(
  db: DB,
  cfg: { shopId: string; centralUrl: string; token?: string; role: 'HQ' | 'SHOP' },
): void {
  const set = (k: string, v: string): void => {
    db.prepare(
      `INSERT INTO device_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(k, v);
  };
  set('shop_id', cfg.shopId);
  set('central_url', cfg.centralUrl);
  set('sync_role', cfg.role);
  if (cfg.token) set('central_token', cfg.token);
}
