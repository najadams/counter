// Operator-facing sync status: provisioning state + last-sync timestamps +
// pending backlog. Feeds the home-screen SyncHealthBanner and Settings -> Sync.

import type { Database as DB } from 'better-sqlite3';
import type { SyncStatus } from '../../shared/types/ipc.js';
import { getState } from './state.js';

export function getSyncStatus(db: DB): SyncStatus {
  const cfg = (k: string): string | undefined =>
    (db.prepare('SELECT value FROM device_config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const shopId = cfg('shop_id') ?? null;
  const centralUrl = cfg('central_url') ?? null;
  const hasToken = Boolean(cfg('central_token'));
  const anyConfig = Boolean(shopId || centralUrl || hasToken);

  const pendingCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM sync_outbox WHERE acked_at IS NULL',
  ).get() as { c: number }).c;

  return {
    configured: Boolean(shopId && centralUrl && hasToken),
    role: !anyConfig ? null : (cfg('sync_role') === 'HQ' ? 'HQ' : 'SHOP'),
    shopId,
    centralUrl,
    lastPushAt: getState(db, 'last_push_at') ?? null,
    lastPullAt: getState(db, 'last_pull_at') ?? null,
    pendingCount,
  };
}
