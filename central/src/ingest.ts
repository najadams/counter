// Ingest a push batch from a shop. Mirrors the stub's contract but durable,
// idempotent, and gap-aware:
//   - every row's seq is logged (sync_ingest_log) for hole detection
//   - event rows land in the union store (ingested_rows) ON CONFLICT DO NOTHING
//   - master rows (only from an HQ shop) upsert the catalog with a fresh cursor
//   - the ack is the highest GAP-FREE seq, so a shop never marks acked past a
//     row central is still missing (design §B5/§B6).

import { withTx } from './db.js';
import { EVENT_TABLES, MASTER_TABLES } from './tables.js';
import type { AuthedShop } from './auth.js';

const MASTER = new Set<string>(MASTER_TABLES);
const KNOWN = new Set<string>([...EVENT_TABLES, ...MASTER_TABLES]);

export interface IngestRow {
  seq: number;
  table: string;
  op: 'INSERT' | 'UPDATE';
  data: Record<string, unknown>;
}

/** Apply a batch and return the highest contiguous (gap-free) seq for the shop. */
export async function ingestBatch(shop: AuthedShop, rows: IngestRow[]): Promise<number> {
  return withTx(async (client) => {
    for (const row of rows) {
      const id = row.data?.['id'] != null ? String(row.data['id']) : null;

      // Always log the seq (even for unknown/idless rows) so the contiguous
      // watermark and gap detection see the whole stream.
      await client.query(
        `INSERT INTO sync_ingest_log (shop_id, seq, table_name, op)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (shop_id, seq) DO NOTHING`,
        [shop.shopId, row.seq, row.table, row.op],
      );

      if (!id || !KNOWN.has(row.table)) continue; // garbage/idless: logged, not stored

      if (MASTER.has(row.table)) {
        // Only HQ distributes catalog. A SHOP-role token pushing a master row is
        // ignored (still seq-logged above) — defense in depth against a shop
        // injecting catalog it does not own.
        if (shop.role !== 'HQ') continue;
        await client.query(
          `INSERT INTO catalog (table_name, row_id, data, cursor, source_shop_id)
             VALUES ($1, $2, $3::jsonb, nextval('catalog_cursor_seq'), $4)
             ON CONFLICT (table_name, row_id) DO UPDATE
               SET data = excluded.data,
                   cursor = nextval('catalog_cursor_seq'),
                   source_shop_id = excluded.source_shop_id,
                   updated_at = now()`,
          [row.table, id, JSON.stringify(row.data), shop.shopId],
        );
      } else {
        await client.query(
          `INSERT INTO ingested_rows (shop_id, table_name, row_id, op, data)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (shop_id, table_name, row_id) DO NOTHING`,
          [shop.shopId, row.table, id, row.op, JSON.stringify(row.data)],
        );
      }
    }

    return contiguousSeq(client, shop.shopId);
  });
}

/** Highest M such that every seq 1..M is present for the shop (0 if seq 1 is
 *  missing or nothing has arrived). This is the safe ack watermark. */
async function contiguousSeq(
  client: { query: (text: string, params: unknown[]) => Promise<{ rows: Array<{ contiguous: string }> }> },
  shopId: string,
): Promise<number> {
  const res = await client.query(
    `WITH present AS (SELECT seq FROM sync_ingest_log WHERE shop_id = $1)
     SELECT CASE
       WHEN NOT EXISTS (SELECT 1 FROM present WHERE seq = 1) THEN 0
       ELSE (SELECT MIN(p.seq) FROM present p
               WHERE NOT EXISTS (SELECT 1 FROM present n WHERE n.seq = p.seq + 1))
     END::bigint AS contiguous`,
    [shopId],
  );
  return Number(res.rows[0]?.contiguous ?? 0);
}
