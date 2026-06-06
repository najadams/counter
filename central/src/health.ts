// Per-shop sync health for the owner dashboard (design §B10). Gap detection is
// cheap: the shop's seq is a gap-free AUTOINCREMENT, so for a contiguous stream
// the count of received seqs equals the max. count < max => a hole => data lost
// in transit (a shrinkage signal worth investigating).

import { query } from './db.js';

export interface ShopHealth {
  shopId: string;
  name: string | null;
  role: string;
  lastSeenAt: string | null;
  maxSeq: number;
  received: number;
  hasGap: boolean;
}

export async function shopHealth(): Promise<ShopHealth[]> {
  const rows = await query<{
    shop_id: string;
    name: string | null;
    role: string;
    last_seen_at: Date | null;
    max_seq: string;
    received: string;
    has_gap: boolean;
  }>(
    `SELECT s.shop_id, s.name, s.role, s.last_seen_at,
            COALESCE(MAX(l.seq), 0) AS max_seq,
            COUNT(l.seq)            AS received,
            (COALESCE(MAX(l.seq), 0) <> COUNT(l.seq)) AS has_gap
       FROM shops s
       LEFT JOIN sync_ingest_log l ON l.shop_id = s.shop_id
       GROUP BY s.shop_id, s.name, s.role, s.last_seen_at
       ORDER BY s.shop_id`,
  );
  return rows.map((r) => ({
    shopId: r.shop_id,
    name: r.name,
    role: r.role,
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    maxSeq: Number(r.max_seq),
    received: Number(r.received),
    hasGap: r.has_gap,
  }));
}
