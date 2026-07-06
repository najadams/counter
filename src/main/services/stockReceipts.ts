// Stock receipt: goods arrived from supplier, with optional PO/invoice matching.
// Each line gets a RECEIVED_FROM_SUPPLIER stock_movement (positive qty,
// supervisor approval required by reason_code config). The product's
// cost_price_pesewas is updated to the latest received cost so future
// sale_lines snapshot the new cost.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
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
  purchaseOrderId?: string | null;
  supplierInvoiceNumber?: string | null;
  supplierInvoiceDate?: string | null;
  supplierDueDate?: string | null;
  transportCostPesewas?: number;
  loadingCostPesewas?: number;
  lines: StockReceiptLine[];
  notes?: string | null;
  /** Confirm a receipt whose implied per-canonical cost moves a product's
   *  cost by more than ±50%. Without this the receipt is refused with a
   *  COST_SWING error so a per-crate/per-bottle mix-up can't silently
   *  poison the cost basis (and every margin figure after it). */
  allowLargeCostSwing?: boolean;
  deviceId: string;
}

export interface ReceiveStockResult {
  movementIds: string[];
  supplierInvoiceId: string | null;
  totalValuePesewas: number;
  totalPayablePesewas: number;
  productsUpdated: number;
}

function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, days));
  return d.toISOString().slice(0, 10);
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

  let supplierInfo: { id: string; payment_terms_days: number; credit_limit_pesewas: number; current_balance_pesewas: number } | null = null;
  if (input.isOpeningStock) {
    if (input.supplierId) {
      throw new Error('receiveStock: opening stock cannot reference a supplier');
    }
    if (
      input.supplierInvoiceNumber || input.supplierInvoiceDate || input.supplierDueDate || input.purchaseOrderId ||
      (input.transportCostPesewas ?? 0) > 0 || (input.loadingCostPesewas ?? 0) > 0
    ) {
      throw new Error('receiveStock: opening stock cannot carry supplier invoice or PO details');
    }
  } else {
    if (!input.supplierId) {
      throw new Error('receiveStock: supplierId is required unless isOpeningStock=true');
    }
    const supplier = db
      .prepare(
        `SELECT id, active, deleted_at, payment_terms_days, credit_limit_pesewas, current_balance_pesewas
           FROM suppliers WHERE id = ?`,
      )
      .get(input.supplierId) as
        | { id: string; active: number; deleted_at: string | null; payment_terms_days: number; credit_limit_pesewas: number; current_balance_pesewas: number }
        | undefined;
    if (!supplier || supplier.active !== 1 || supplier.deleted_at) {
      throw new Error(`receiveStock: supplier ${input.supplierId} not found or inactive`);
    }
    supplierInfo = supplier;
    if (input.purchaseOrderId) {
      const po = db.prepare('SELECT supplier_id, status FROM purchase_orders WHERE id = ?')
        .get(input.purchaseOrderId) as { supplier_id: string; status: string } | undefined;
      if (!po || po.supplier_id !== input.supplierId || po.status === 'CANCELLED') {
        throw new Error(`receiveStock: purchase order ${input.purchaseOrderId} is not open for this supplier`);
      }
    }
  }
  const transportCostPesewas = input.transportCostPesewas ?? 0;
  const loadingCostPesewas = input.loadingCostPesewas ?? 0;
  if (!Number.isInteger(transportCostPesewas) || transportCostPesewas < 0) {
    throw new Error('receiveStock: transportCostPesewas must be a non-negative integer');
  }
  if (!Number.isInteger(loadingCostPesewas) || loadingCostPesewas < 0) {
    throw new Error('receiveStock: loadingCostPesewas must be a non-negative integer');
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

  // Resolve units + convert to canonical BEFORE any writes, so the cost-swing
  // guard can see the receipt's implied per-canonical costs pre-flight.
  const resolvedLines = input.lines.map((line) => {
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
    return { ...line, unitId, canonicalQty, lineTotalPesewas, canonicalUnitCost };
  });

  // Per-receipt cost accumulator: productId -> { value (pesewas), qty (canonical) }.
  // Used below to set the new canonical cost = sum value / sum canonical
  // qty across JUST this receipt's lines for that product. "Latest
  // receipt wins" semantics — prior inflows do not influence the new
  // cost. Multi-line receipts for the same product (rare but allowed)
  // get a weighted average of just this receipt's lines.
  const receiptCost = new Map<string, { value: number; qty: number }>();
  const poReceiptByProduct = new Map<string, { value: number; qty: number }>();
  for (const line of resolvedLines) {
    const acc = receiptCost.get(line.productId) ?? { value: 0, qty: 0 };
    acc.value += line.lineTotalPesewas;
    acc.qty += line.canonicalQty;
    receiptCost.set(line.productId, acc);

    const poAcc = poReceiptByProduct.get(line.productId) ?? { value: 0, qty: 0 };
    poAcc.value += line.lineTotalPesewas;
    poAcc.qty += line.canonicalQty;
    poReceiptByProduct.set(line.productId, poAcc);
  }

  if (input.purchaseOrderId) {
    const remainingRows = db.prepare(
      `SELECT product_id AS productId,
              COALESCE(SUM(quantity_ordered - quantity_received), 0) AS remainingQty
         FROM purchase_order_lines
        WHERE purchase_order_id = ?
        GROUP BY product_id`,
    ).all(input.purchaseOrderId) as Array<{ productId: string; remainingQty: number }>;
    const remainingByProduct = new Map(remainingRows.map((r) => [r.productId, r.remainingQty]));
    for (const [productId, acc] of poReceiptByProduct) {
      const remainingQty = remainingByProduct.get(productId);
      if (remainingQty === undefined) {
        throw new Error(`receiveStock: product ${productId} is not on purchase order ${input.purchaseOrderId}`);
      }
      if (acc.qty > remainingQty) {
        throw new Error(
          `receiveStock: receipt quantity for product ${productId} exceeds the open PO quantity ` +
          `(${acc.qty} > ${remainingQty})`,
        );
      }
    }
  }

  // Cost-swing guard: the most damaging receipt mistake is typing the
  // per-bottle cost against a CRATE unit (or vice versa), which shifts the
  // product's cost basis by the conversion factor and poisons every margin
  // figure after it. Refuse a >±50% implied cost change unless the caller
  // confirms with allowLargeCostSwing. Marker prefix is matched by the UI.
  if (!input.allowLargeCostSwing) {
    const swings: string[] = [];
    for (const [productId, acc] of receiptCost) {
      if (acc.qty <= 0) continue;
      const newCost = Math.round(acc.value / acc.qty);
      const old = productMap.get(productId)!.oldCost;
      if (old > 0 && (newCost > old * 1.5 || newCost < old * 0.5)) {
        swings.push(`${productMap.get(productId)!.name}: ${old} → ${newCost} pesewas per canonical unit`);
      }
    }
    if (swings.length > 0) {
      throw new Error(
        `COST_SWING: this receipt changes cost by more than 50% — ${swings.join('; ')}. ` +
        `Check that each cost was entered per the CHOSEN unit (a crate costs more than a ` +
        `bottle). If the new cost is genuinely right, confirm to receive anyway.`,
      );
    }
  }

  const movementIds: string[] = [];
  const lineMovementIds: string[] = [];
  let totalValuePesewas = 0;
  let productsUpdated = 0;
  let createdSupplierInvoiceId: string | null = null;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const line of resolvedLines) {
      const sm = insertStockMovement(db, {
        productId: line.productId,
        locationId: input.locationId,
        quantity: line.canonicalQty,
        reasonCode,
        workerId: input.workerId,
        purchaseOrderId: input.purchaseOrderId ?? null,
        supervisorApprovalId: input.supervisorApprovalId,
        unitCostPesewas: line.canonicalUnitCost,
        // Preserve the EXACT total. Without this, total_value would be
        // canonicalQty × canonicalUnitCost — and for any line whose
        // box-cost isn't evenly divisible, that quietly understates
        // (or overstates) what we actually spent.
        totalValuePesewasOverride: line.lineTotalPesewas,
        notes: input.notes ?? null,
        deviceId: input.deviceId,
      });
      if (line.unitId) {
        db.prepare('UPDATE stock_movements SET source_unit_id = ?, updated_at = ? WHERE id = ?')
          .run(line.unitId, new Date().toISOString(), sm.id);
      }
      movementIds.push(sm.id);
      lineMovementIds.push(sm.id);
      totalValuePesewas += sm.totalValuePesewas;
    }

    let supplierInvoiceId: string | null = null;
    if (!input.isOpeningStock && input.supplierId) {
      const invoiceDate = input.supplierInvoiceDate ?? now.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) throw new Error('receiveStock: supplierInvoiceDate must be YYYY-MM-DD');
      const dueDate = input.supplierDueDate
        ?? addDaysISO(invoiceDate, supplierInfo?.payment_terms_days ?? 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('receiveStock: supplierDueDate must be YYYY-MM-DD');
      const totalPayablePesewas = totalValuePesewas + transportCostPesewas + loadingCostPesewas;
      if (
        supplierInfo &&
        supplierInfo.credit_limit_pesewas > 0 &&
        supplierInfo.current_balance_pesewas + totalPayablePesewas > supplierInfo.credit_limit_pesewas
      ) {
        throw new Error(
          `receiveStock: supplier credit limit exceeded ` +
          `(${supplierInfo.current_balance_pesewas + totalPayablePesewas} > ${supplierInfo.credit_limit_pesewas} pesewas)`,
        );
      }
      supplierInvoiceId = `sinv-${uuidv4()}`;
      createdSupplierInvoiceId = supplierInvoiceId;
      const invoiceNumber = input.supplierInvoiceNumber?.trim() || `AUTO-${supplierInvoiceId.slice(-8)}`;
      db.prepare(
        `INSERT INTO supplier_invoices (
           id, supplier_id, purchase_order_id, invoice_number, invoice_date, due_date,
           total_pesewas, total_paid_pesewas, status, transport_cost_pesewas, loading_cost_pesewas, notes,
           created_by, updated_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?, ?, ?, ?)`,
      ).run(
        supplierInvoiceId,
        input.supplierId,
        input.purchaseOrderId ?? null,
        invoiceNumber,
        invoiceDate,
        dueDate,
        totalPayablePesewas,
        transportCostPesewas,
        loadingCostPesewas,
        input.notes?.trim() || null,
        input.workerId,
        input.workerId,
        input.deviceId,
      );
      const allocatedTransport = allocateLandedCost(
        resolvedLines.map((line) => line.lineTotalPesewas),
        transportCostPesewas,
      );
      const allocatedLoading = allocateLandedCost(
        resolvedLines.map((line) => line.lineTotalPesewas),
        loadingCostPesewas,
      );
      for (let i = 0; i < resolvedLines.length; i++) {
        const line = resolvedLines[i]!;
        const lineTransport = allocatedTransport[i] ?? 0;
        const lineLoading = allocatedLoading[i] ?? 0;
        db.prepare(
          `INSERT INTO supplier_invoice_lines (
             id, supplier_invoice_id, stock_movement_id, product_id, source_unit_id,
             quantity, canonical_quantity, unit_cost_pesewas, line_total_pesewas,
             allocated_transport_cost_pesewas, allocated_loading_cost_pesewas, landed_line_total_pesewas,
             created_by, updated_by, device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `sil-${uuidv4()}`,
          supplierInvoiceId,
          lineMovementIds[i] ?? null,
          line.productId,
          line.unitId,
          line.quantity,
          line.canonicalQty,
          line.unitCostPesewas,
          line.lineTotalPesewas,
          lineTransport,
          lineLoading,
          line.lineTotalPesewas + lineTransport + lineLoading,
          input.workerId,
          input.workerId,
          input.deviceId,
        );
      }
      if (input.purchaseOrderId) {
        for (const [productId, acc] of poReceiptByProduct) {
          let remainingQty = acc.qty;
          let remainingValue = acc.value;
          const poLines = db.prepare(
            `SELECT id, quantity_ordered - quantity_received AS remainingQty
               FROM purchase_order_lines
              WHERE purchase_order_id = ?
                AND product_id = ?
                AND quantity_received < quantity_ordered
              ORDER BY created_at ASC, id ASC`,
          ).all(input.purchaseOrderId, productId) as Array<{ id: string; remainingQty: number }>;
          for (const poLine of poLines) {
            if (remainingQty <= 0) break;
            const qty = Math.min(remainingQty, poLine.remainingQty);
            const value = qty === remainingQty
              ? remainingValue
              : Math.round((acc.value * qty) / acc.qty);
            db.prepare(
              `UPDATE purchase_order_lines
                  SET quantity_received = quantity_received + ?,
                      line_total_received_pesewas = line_total_received_pesewas + ?,
                      updated_at = ?, updated_by = ?
                WHERE id = ?`,
            ).run(qty, value, now, input.workerId, poLine.id);
            remainingQty -= qty;
            remainingValue -= value;
          }
        }
        db.prepare(
          `UPDATE purchase_orders
              SET total_received_pesewas = total_received_pesewas + ?,
                  received_at = COALESCE(received_at, ?),
                  status = CASE
                    WHEN total_received_pesewas + ? >= total_ordered_pesewas THEN 'RECEIVED'
                    WHEN status IN ('DRAFT','PLACED') THEN 'PARTIALLY_RECEIVED'
                    ELSE status
                  END,
                  updated_at = ?, updated_by = ?
            WHERE id = ?`,
        ).run(totalValuePesewas, now, totalValuePesewas, now, input.workerId, input.purchaseOrderId);
      }
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
    for (const [productId, acc] of receiptCost) {
      if (acc.qty <= 0) continue;
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

    // Supplier receipts increase what we owe the supplier, so the payables
    // KPI reflects deliveries, not just whatever balance was keyed in by
    // hand. Supplier payments decrement this the same way they always have.
    if (!input.isOpeningStock && input.supplierId) {
      db.prepare(
        `UPDATE suppliers
            SET current_balance_pesewas = current_balance_pesewas + ?,
                updated_at = ?, updated_by = ?
            WHERE id = ?`,
      ).run(totalValuePesewas + transportCostPesewas + loadingCostPesewas, now, input.workerId, input.supplierId);
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
        transportCostPesewas,
        loadingCostPesewas,
        totalPayablePesewas: totalValuePesewas + transportCostPesewas + loadingCostPesewas,
        supplierInvoiceId,
        supplierInvoiceNumber: input.supplierInvoiceNumber?.trim() || null,
        supplierDueDate: input.supplierDueDate ?? null,
        purchaseOrderId: input.purchaseOrderId ?? null,
        productsCostUpdated: productsUpdated,
        supplierBalanceDeltaPesewas: !input.isOpeningStock && input.supplierId
          ? totalValuePesewas + transportCostPesewas + loadingCostPesewas
          : 0,
        supervisorApprovalId: input.supervisorApprovalId,
      },
      deviceId: input.deviceId,
    });
  });

  tx();
  return {
    movementIds,
    supplierInvoiceId: createdSupplierInvoiceId,
    totalValuePesewas,
    totalPayablePesewas: totalValuePesewas + transportCostPesewas + loadingCostPesewas,
    productsUpdated,
  };
}

function allocateLandedCost(lineTotals: number[], costPesewas: number): number[] {
  if (costPesewas <= 0) return lineTotals.map(() => 0);
  const goodsTotal = lineTotals.reduce((sum, value) => sum + value, 0);
  if (goodsTotal <= 0) {
    return lineTotals.map((_, index) => (index === lineTotals.length - 1 ? costPesewas : 0));
  }
  let allocated = 0;
  return lineTotals.map((lineTotal, index) => {
    if (index === lineTotals.length - 1) return costPesewas - allocated;
    const share = Math.round((costPesewas * lineTotal) / goodsTotal);
    allocated += share;
    return share;
  });
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
