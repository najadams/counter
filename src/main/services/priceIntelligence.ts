import type { Database as DB } from 'better-sqlite3';

const ALLOWED_ROLES = new Set(['OWNER', 'FOUNDER', 'SUPERVISOR']);

function requireReportsActor(db: DB, actorId: string): void {
  const w = db.prepare(
    `SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?`,
  ).get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) throw new Error('price intelligence: actor not active');
  if (!ALLOWED_ROLES.has(w.role)) {
    throw new Error(`price intelligence: role ${w.role} not permitted`);
  }
}

export interface PriceHistoryRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  fieldName: string;
  oldPesewas: number | null;
  newPesewas: number | null;
  competitorName: string | null;
  reason: string | null;
  changedAt: string;
  changedBy: string;
}

export interface PriceIntelligenceRow {
  productId: string;
  sku: string;
  productName: string;
  costPricePesewas: number;
  minimumPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  competitorPricePesewas: number | null;
  competitorName: string | null;
  competitorCheckedAt: string | null;
  walkInVsMinimumPesewas: number;
  walkInVsCompetitorPesewas: number | null;
}

export interface LandedCostAllocationRow {
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  productId: string;
  sku: string;
  productName: string;
  lineTotalPesewas: number;
  allocatedTransportCostPesewas: number;
  allocatedLoadingCostPesewas: number;
  landedLineTotalPesewas: number;
}

export function getPriceIntelligence(
  db: DB,
  input: { actorWorkerId: string },
): { rows: PriceIntelligenceRow[] } {
  requireReportsActor(db, input.actorWorkerId);
  const rows = db.prepare(
    `SELECT p.id AS productId, p.sku, p.name AS productName,
            p.cost_price_pesewas AS costPricePesewas,
            p.minimum_price_pesewas AS minimumPricePesewas,
            p.walk_in_price_pesewas AS walkInPricePesewas,
            p.wholesale_price_pesewas AS wholesalePricePesewas,
            p.route_price_pesewas AS routePricePesewas,
            p.competitor_price_pesewas AS competitorPricePesewas,
            p.competitor_name AS competitorName,
            p.competitor_checked_at AS competitorCheckedAt,
            p.walk_in_price_pesewas - p.minimum_price_pesewas AS walkInVsMinimumPesewas,
            CASE WHEN p.competitor_price_pesewas IS NULL THEN NULL
                 ELSE p.walk_in_price_pesewas - p.competitor_price_pesewas
            END AS walkInVsCompetitorPesewas
       FROM products p
      WHERE p.deleted_at IS NULL
      ORDER BY p.active DESC, p.name ASC`,
  ).all() as PriceIntelligenceRow[];
  return { rows };
}

export function getPriceHistory(
  db: DB,
  input: { actorWorkerId: string; fromDate?: string; toDate?: string; productId?: string | null; limit?: number },
): { rows: PriceHistoryRow[] } {
  requireReportsActor(db, input.actorWorkerId);
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.fromDate) { where.push('date(ph.changed_at) >= date(?)'); params.push(input.fromDate); }
  if (input.toDate) { where.push('date(ph.changed_at) <= date(?)'); params.push(input.toDate); }
  if (input.productId) { where.push('ph.product_id = ?'); params.push(input.productId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT ph.id, ph.product_id AS productId, p.sku, p.name AS productName,
            ph.field_name AS fieldName, ph.old_pesewas AS oldPesewas,
            ph.new_pesewas AS newPesewas, ph.competitor_name AS competitorName,
            ph.reason, ph.changed_at AS changedAt, w.full_name AS changedBy
       FROM price_history ph
       JOIN products p ON p.id = ph.product_id
       JOIN workers w ON w.id = ph.changed_by
       ${whereSql}
      ORDER BY ph.changed_at DESC
      LIMIT ?`,
  ).all(...params, Math.min(Math.max(input.limit ?? 100, 1), 500)) as PriceHistoryRow[];
  return { rows };
}

export function getLandedCostAllocations(
  db: DB,
  input: { actorWorkerId: string; fromDate?: string; toDate?: string; supplierId?: string | null },
): { rows: LandedCostAllocationRow[] } {
  requireReportsActor(db, input.actorWorkerId);
  const where: string[] = ["si.status != 'VOID'"];
  const params: unknown[] = [];
  if (input.fromDate) { where.push('date(si.invoice_date) >= date(?)'); params.push(input.fromDate); }
  if (input.toDate) { where.push('date(si.invoice_date) <= date(?)'); params.push(input.toDate); }
  if (input.supplierId) { where.push('si.supplier_id = ?'); params.push(input.supplierId); }
  const rows = db.prepare(
    `SELECT si.id AS invoiceId, si.invoice_number AS invoiceNumber, s.name AS supplierName,
            p.id AS productId, p.sku, p.name AS productName,
            sil.line_total_pesewas AS lineTotalPesewas,
            sil.allocated_transport_cost_pesewas AS allocatedTransportCostPesewas,
            sil.allocated_loading_cost_pesewas AS allocatedLoadingCostPesewas,
            sil.landed_line_total_pesewas AS landedLineTotalPesewas
       FROM supplier_invoice_lines sil
       JOIN supplier_invoices si ON si.id = sil.supplier_invoice_id
       JOIN suppliers s ON s.id = si.supplier_id
       JOIN products p ON p.id = sil.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY si.invoice_date DESC, si.invoice_number DESC, p.name ASC`,
  ).all(...params) as LandedCostAllocationRow[];
  return { rows };
}
