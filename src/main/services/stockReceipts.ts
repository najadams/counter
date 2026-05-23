// Ad-hoc stock receipt: goods arrived from supplier, no PO yet.
// Each line gets a RECEIVED_FROM_SUPPLIER stock_movement (positive qty,
// supervisor approval required by reason_code config). The product's
// cost_price_pesewas is updated to the latest received cost so future
// sale_lines snapshot the new cost.
//
// Full PO matching (compare ordered vs received vs paid, partial receipts,
// multiple deliveries) lands in Week 4.

import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';
import { insertStockMovement } from './stockMovements.js';
import { getUnit } from './productUnits.js';
import { assertNotSealed } from './periods.js';

export interface StockReceiptLine {
  productId: string;
  /** Quantity in the chosen unit. If unitId omitted, treated as canonical. */
  quantity: number;
  /** Optional purchase unit. If provided, conversion_factor × quantity is the canonical qty. */
  unitId?: string | null;
  /** Cost per unit in the chosen unit (or per canonical if unitId omitted). */
  unitCostPesewas: number;
}

export interface ReceiveStockInput {
  /** Required for normal supplier receipts, null for OPENING_STOCK. */
  supplierId: string | null;
  /** When true, supplierId may be null and reason is OPENING_STOCK. */
  isOpeningStock?: boolean;
  locationId: string;
  workerId: string;
  supervisorApprovalId: string;
  lines: StockReceiptLine[];
  notes?: string | null;
  deviceId: string;
}

export interface ReceiveStockResult {
  movementIds: string[];
  totalValuePesewas: number;
  productsUpdated: number;
}

/**
 * Receive stock from a supplier. One transaction:
 *   - INSERT stock_movements per line (RECEIVED_FROM_SUPPLIER, +qty)
 *   - UPDATE products.cost_price_pesewas to latest received cost
 *   - audit STOCK_RECEIVED with snapshot
 */
export function receiveStock(
  db: DB,
  input: ReceiveStockInput,
): ReceiveStockResult {
  if (input.lines.length === 0) {
    throw new Error('receiveStock: at least one line required');
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`receiveStock: line quantity must be a positive integer`);
    }
    if (!Number.isInteger(line.unitCostPesewas) || line.unitCostPesewas < 0) {
      throw new Error(`receiveStock: line unitCostPesewas must be a non-negative integer`);
    }
  }

  // Day-lock guard: today's date at this location cannot be sealed when
  // receiving stock. Opening stock entries are also blocked — once a day
  // is sealed, no inventory adjustments for that date.
  const todayISO = new Date().toISOString().slice(0, 10);
  assertNotSealed(
    db, input.locationId, todayISO,
    input.isOpeningStock ? 'opening-stock entry' : 'receiving stock from a supplier',
  );

  if (input.isOpeningStock) {
    if (input.supplierId) {
      throw new Error('receiveStock: opening stock cannot reference a supplier');
    }
  } else {
    if (!input.supplierId) {
      throw new Error('receiveStock: supplierId is required unless isOpeningStock=true');
    }
    const supplier = db
      .prepare('SELECT id, active, deleted_at FROM suppliers WHERE id = ?')
      .get(input.supplierId) as { id: string; active: number; deleted_at: string | null } | undefined;
    if (!supplier || supplier.active !== 1 || supplier.deleted_at) {
      throw new Error(`receiveStock: supplier ${input.supplierId} not found or inactive`);
    }
  }
  const reasonCode = input.isOpeningStock ? 'OPENING_STOCK' : 'RECEIVED_FROM_SUPPLIER';

  // Verify the products exist + are active. Pre-flight before we touch DB.
  const productMap = new Map<string, { name: string; oldCost: number }>();
  for (const line of input.lines) {
    const p = db
      .prepare(
        `SELECT name, cost_price_pesewas FROM products
           WHERE id = ? AND active = 1 AND deleted_at IS NULL`,
      )
      .get(line.productId) as { name: string; cost_price_pesewas: number } | undefined;
    if (!p) throw new Error(`receiveStock: product ${line.productId} not found or inactive`);
    productMap.set(line.productId, { name: p.name, oldCost: p.cost_price_pesewas });
  }

  const movementIds: string[] = [];
  let totalValuePesewas = 0;
  let productsUpdated = 0;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const productsTouched = new Set<string>();
    // Per-receipt cost accumulator: productId -> { value (pesewas), qty (canonical) }.
    // Used below to set the new canonical cost = sum value / sum canonical
    // qty across JUST this receipt's lines for that product. "Latest
    // receipt wins" semantics — prior inflows do not influence the new
    // cost. Multi-line receipts for the same product (rare but allowed)
    // get a weighted average of just this receipt's lines.
    const receiptCost = new Map<string, { value: number; qty: number }>();

    for (const line of input.lines) {
      // Resolve unit + convert to canonical.
      let factor = 1;
      let unitId: string | null = null;
      if (line.unitId) {
        const u = getUnit(db, line.unitId);
        if (!u) throw new Error(`receiveStock: unit ${line.unitId} not found`);
        if (!u.active) throw new Error(`receiveStock: unit ${line.unitId} is inactive`);
        if (u.productId !== line.productId) {
          throw new Error(`receiveStock: unit ${line.unitId} does not belong to product ${line.productId}`);
        }
        if (!u.isPurchaseUnit) {
          throw new Error(`receiveStock: unit '${u.unitName}' is not flagged as a purchase unit`);
        }
        factor = u.conversionFactor;
        unitId = u.id;
      }
      const canonicalQty = line.quantity * factor;

      // Truth: total spent on this line, in pesewas. EXACT — the user typed
      // (quantity, per-purchase-unit cost) and we just multiply integers.
      // No division means no rounding here.
      const lineTotalPesewas = line.quantity * line.unitCostPesewas;
      // Display: per-canonical-unit cost, rounded. Used for analysis and as
      // the cost-snapshot at sale time. May differ from
      // lineTotalPesewas / canonicalQty by ±0.5 pesewa due to rounding, but
      // the line total above stays exact.
      const canonicalUnitCost = Math.round(lineTotalPesewas / canonicalQty);

      const sm = insertStockMovement(db, {
        productId: line.productId,
        locationId: input.locationId,
        quantity: canonicalQty,
        reasonCode,
        workerId: input.workerId,
        supervisorApprovalId: input.supervisorApprovalId,
        unitCostPesewas: canonicalUnitCost,
        // Preserve the EXACT total. Without this, total_value would be
        // canonicalQty × canonicalUnitCost — and for any line whose
        // box-cost isn't evenly divisible, that quietly understates
        // (or overstates) what we actually spent.
        totalValuePesewasOverride: lineTotalPesewas,
        notes: input.notes ?? null,
        deviceId: input.deviceId,
      });
      if (unitId) {
        db.prepare('UPDATE stock_movements SET source_unit_id = ?, updated_at = ? WHERE id = ?')
          .run(unitId, new Date().toISOString(), sm.id);
      }
      movementIds.push(sm.id);
      totalValuePesewas += sm.totalValuePesewas;
      productsTouched.add(line.productId);

      // Accumulate this line into the receipt-cost map.
      const acc = receiptCost.get(line.productId) ?? { value: 0, qty: 0 };
      acc.value += lineTotalPesewas;
      acc.qty += canonicalQty;
      receiptCost.set(line.productId, acc);
    }

    // Latest-receipt-wins cost recompute. The new canonical cost is the
    // weighted average of JUST this receipt's lines for the product —
    // not an average across history. Rationale: cost should reflect
    // what we most recently paid, so margin reports track current
    // supplier pricing instead of lagging behind it indefinitely.
    //
    // Customer returns and other non-receipt inflows do not affect cost
    // at all under this model (they don't go through receiveStock).
    // Multi-line receipts for the same product get an honest weighted
    // average across just those lines.
    for (const productId of productsTouched) {
      const acc = receiptCost.get(productId);
      if (!acc || acc.qty <= 0) continue;
      const newCost = Math.round(acc.value / acc.qty);
      const old = productMap.get(productId)!.oldCost;
      if (old !== newCost) {
        db.prepare(
          `UPDATE products
              SET cost_price_pesewas = ?, updated_at = ?, updated_by = ?
              WHERE id = ?`,
        ).run(newCost, now, input.workerId, productId);
        productsUpdated++;
      }
    }

    logAudit(db, {
      workerId: input.workerId,
      action: input.isOpeningStock ? 'OPENING_STOCK_ENTERED' : 'STOCK_RECEIVED',
      entityType: 'stock_movements',
      entityId: input.supplierId ?? 'opening-stock',
      afterValue: {
        supplierId: input.supplierId,
        isOpeningStock: !!input.isOpeningStock,
        lineCount: input.lines.length,
        totalValuePesewas,
        productsCostUpdated: productsUpdated,
        supervisorApprovalId: input.supervisorApprovalId,
      },
      deviceId: input.deviceId,
    });
  });

  tx();
  return { movementIds, totalValuePesewas, productsUpdated };
}

export interface SupplierSummary {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  paymentTermsDays: number;
  currentBalancePesewas: number;
  reliabilityScore: number | null;
}

export function listActiveSuppliers(db: DB): SupplierSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, contact_person AS contactPerson, phone,
              payment_terms_days AS paymentTermsDays,
              current_balance_pesewas AS currentBalancePesewas,
              reliability_score AS reliabilityScore
         FROM suppliers
         WHERE active = 1 AND deleted_at IS NULL
         ORDER BY name ASC`,
    )
    .all() as SupplierSummary[];
  return rows;
}
