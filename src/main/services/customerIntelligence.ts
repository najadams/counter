import type { Database as DB } from 'better-sqlite3';

const ALLOWED_ROLES = new Set(['OWNER', 'FOUNDER', 'SUPERVISOR']);

function requireReportsActor(db: DB, actorId: string): void {
  const w = db.prepare(
    `SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?`,
  ).get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) throw new Error('customer intelligence: actor not active');
  if (!ALLOWED_ROLES.has(w.role)) throw new Error(`customer intelligence: role ${w.role} not permitted`);
}

export interface CustomerIntelligenceRow {
  customerId: string;
  name: string;
  phone: string | null;
  lastPurchaseAt: string | null;
  daysInactive: number | null;
  purchaseCount: number;
  purchaseFrequencyDays: number | null;
  totalValuePesewas: number;
  monthlyValuePesewas: number;
  abcClass: 'A' | 'B' | 'C';
}

export interface CustomerTopProductRow {
  customerId: string;
  customerName: string;
  productId: string;
  sku: string;
  productName: string;
  unitsSold: number;
  revenuePesewas: number;
}

export function getCustomerIntelligence(
  db: DB,
  input: { actorWorkerId: string; asOfDateISO?: string; inactiveDays?: number },
): { rows: CustomerIntelligenceRow[]; inactive: CustomerIntelligenceRow[]; topProducts: CustomerTopProductRow[] } {
  requireReportsActor(db, input.actorWorkerId);
  const asOf = input.asOfDateISO ?? new Date().toISOString().slice(0, 10);
  const inactiveDays = input.inactiveDays ?? 30;
  const rows = db.prepare(
    `WITH customer_sales AS (
       SELECT c.id AS customerId, c.display_name AS name, c.phone,
              COUNT(s.id) AS purchaseCount,
              COALESCE(SUM(s.total_pesewas), 0) AS totalValuePesewas,
              MIN(date(s.created_at)) AS firstPurchaseDate,
              MAX(date(s.created_at)) AS lastPurchaseDate,
              COALESCE(SUM(CASE
                WHEN date(s.created_at) >= date(?, 'start of month')
                 AND date(s.created_at) < date(?, 'start of month', '+1 month')
                THEN s.total_pesewas ELSE 0 END), 0) AS monthlyValuePesewas
         FROM customers c
         LEFT JOIN sales s ON s.customer_id = c.id AND s.voided = 0
        WHERE c.deleted_at IS NULL
        GROUP BY c.id
     ),
     ranked AS (
       SELECT *,
              SUM(totalValuePesewas) OVER () AS grandTotal,
              SUM(totalValuePesewas) OVER (ORDER BY totalValuePesewas DESC, name ASC) AS cumulativeValue
         FROM customer_sales
     )
       SELECT customerId, name, phone,
            CASE WHEN lastPurchaseDate IS NULL THEN NULL ELSE lastPurchaseDate || 'T00:00:00.000Z' END AS lastPurchaseAt,
            CASE WHEN lastPurchaseDate IS NULL THEN NULL
                 ELSE CAST(julianday(?) - julianday(lastPurchaseDate) AS INTEGER)
            END AS daysInactive,
            purchaseCount,
            CASE
              WHEN purchaseCount <= 1 OR firstPurchaseDate IS NULL THEN NULL
              ELSE ROUND((julianday(lastPurchaseDate) - julianday(firstPurchaseDate)) / (purchaseCount - 1), 1)
            END AS purchaseFrequencyDays,
            totalValuePesewas,
            monthlyValuePesewas,
            CASE
              WHEN grandTotal <= 0 THEN 'C'
              WHEN cumulativeValue - totalValuePesewas < grandTotal * 0.80 THEN 'A'
              WHEN cumulativeValue - totalValuePesewas < grandTotal * 0.95 THEN 'B'
              ELSE 'C'
            END AS abcClass
       FROM ranked
      ORDER BY totalValuePesewas DESC, name ASC`,
  ).all(asOf, asOf, asOf) as CustomerIntelligenceRow[];

  const inactive = rows.filter((row) => row.daysInactive === null || row.daysInactive >= inactiveDays);
  const topProducts = db.prepare(
    `SELECT c.id AS customerId, c.display_name AS customerName,
            p.id AS productId, p.sku, p.name AS productName,
            SUM(sl.quantity) AS unitsSold,
            SUM(sl.line_total_pesewas) AS revenuePesewas
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN sale_lines sl ON sl.sale_id = s.id
       JOIN products p ON p.id = sl.product_id
      WHERE s.voided = 0 AND c.deleted_at IS NULL
      GROUP BY c.id, p.id
      HAVING revenuePesewas > 0
      ORDER BY c.display_name ASC, revenuePesewas DESC`,
  ).all() as CustomerTopProductRow[];

  return { rows, inactive, topProducts };
}
