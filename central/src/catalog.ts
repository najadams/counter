// Catalog distribution (pull side). Shops GET /catalog?since=<cursor> and apply
// rows by upsert on id; HQ is the single writer so last-writer-wins is safe.

import { query } from './db.js';

export interface CatalogRow {
  cursor: number;
  table: string;
  data: Record<string, unknown>;
}

export interface CatalogPage {
  rows: CatalogRow[];
  cursor: number;
}

/** Catalog rows with cursor > `since`, oldest first, capped at `limit`. The
 *  returned `cursor` is the page's high-water mark (or `since` if empty), which
 *  the shop persists and passes back next time. */
export async function fetchCatalog(since: number, limit: number): Promise<CatalogPage> {
  const lim = Math.min(Math.max(Math.trunc(limit) || 500, 1), 1000);
  const safeSince = Number.isFinite(since) ? since : 0;
  const rows = await query<{ cursor: string; table_name: string; data: Record<string, unknown> }>(
    `SELECT cursor, table_name, data FROM catalog
       WHERE cursor > $1 ORDER BY cursor ASC LIMIT $2`,
    [safeSince, lim],
  );
  const mapped: CatalogRow[] = rows.map((r) => ({
    cursor: Number(r.cursor),
    table: r.table_name,
    data: r.data,
  }));
  const cursor = mapped.length ? mapped[mapped.length - 1]!.cursor : safeSince;
  return { rows: mapped, cursor };
}
