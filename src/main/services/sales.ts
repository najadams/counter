// Sales service. completeSale() is the most safety-critical transaction in
// the system: sales + sale_lines + stock_movements + audit_log all written
// atomically, or none at all.
//
// This is the function that the pushback-fix #5 integration test guards.
// Don't add code paths here without a test that covers them.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { insertStockMovement, unitsOnHand } from './stockMovements.js';
import { bestTierFor } from './pricingTiers.js';
import { findBestOverride } from './customerPriceOverrides.js';
import { computeBonusLines } from './promotions.js';
import { convertToCanonical, defaultSaleUnit, getUnit } from './productUnits.js';
import { verifyPin } from './workers.js';
import {
  DISCOUNT_ABS_THRESHOLD_PESEWAS,
  DISCOUNT_PERCENT_THRESHOLD_BPS,
} from '../../shared/lib/constants.js';
import { getPrinter } from '../printer/printer.js';
import type { SaleReceipt } from '../printer/receipt.js';

export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface ProductSearchResult {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string;
  /** Per-unit price for the default sale unit (smallest sellable). */
  unitPricePesewas: number;
  /** Per-canonical-unit cost (unchanged from before). */
  costPricePesewas: number;
  /** Stock on hand in canonical units. */
  unitsOnHand: number;
  isReturnable: boolean;
  /** Default sale unit info — what the cart will use when this product is added. */
  defaultUnitId: string | null;
  defaultUnitName: string;          // 'UNIT' for legacy, otherwise actual name
  defaultUnitFactor: number;         // 1 for legacy, multiplier otherwise
  /** Canonical-unit price (channel base) for tier lookups in the renderer. */
  canonicalChannelPricePesewas: number;
}

/**
 * Search products by SKU prefix or name substring (case-insensitive).
 * Returns channel-priced rows with current stock at the given location.
 */
export function searchProducts(
  db: DB,
  query: string,
  channel: SaleChannel,
  locationId: string,
  limit = 12,
): ProductSearchResult[] {
  const priceCol =
    channel === 'WHOLESALE' ? 'wholesale_price_pesewas'
    : channel === 'ROUTE'   ? 'route_price_pesewas'
    : 'walk_in_price_pesewas';

  const trimmed = query.trim();
  let sql: string;
  let params: unknown[];

  if (trimmed === '') {
    sql = `
      SELECT id, sku, name, brand, category,
             ${priceCol} AS unit_price_pesewas,
             cost_price_pesewas,
             is_returnable
        FROM products
        WHERE active = 1 AND deleted_at IS NULL
        ORDER BY name ASC
        LIMIT ?`;
    params = [limit];
  } else {
    const like = `%${trimmed}%`;
    const skuPrefix = `${trimmed}%`;
    sql = `
      SELECT id, sku, name, brand, category,
             ${priceCol} AS unit_price_pesewas,
             cost_price_pesewas,
             is_returnable
        FROM products
        WHERE active = 1 AND deleted_at IS NULL
          AND (sku LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE OR barcode = ?)
        ORDER BY
          CASE WHEN sku LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
          name ASC
        LIMIT ?`;
    params = [skuPrefix, like, trimmed, skuPrefix, limit];
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    sku: string;
    name: string;
    brand: string | null;
    category: string;
    unit_price_pesewas: number;
    cost_price_pesewas: number;
    is_returnable: number;
  }>;

  return rows.map((r) => {
    const def = defaultSaleUnit(db, r.id);
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      brand: r.brand,
      category: r.category,
      // Default sale unit price for display. If no unit defined (shouldn't happen
      // post-migration but defensive), fall back to channel base.
      unitPricePesewas: def ? def.pricePesewas : r.unit_price_pesewas,
      costPricePesewas: r.cost_price_pesewas,
      unitsOnHand: unitsOnHand(db, r.id, locationId),
      isReturnable: r.is_returnable === 1,
      defaultUnitId: def ? def.id : null,
      defaultUnitName: def ? def.unitName : 'UNIT',
      defaultUnitFactor: def ? def.conversionFactor : 1,
      canonicalChannelPricePesewas: r.unit_price_pesewas,
    };
  });
}

export interface CompleteSaleLine {
  productId: string;
  /** Quantity expressed in the chosen unit (or canonical if unitId is omitted). */
  quantity: number;
  /** Optional sellable unit id. If omitted, defaultSaleUnit() picks the smallest. */
  unitId?: string | null;
  /** Per-unit price the worker quoted to the customer. */
  unitPricePesewas: number;
}

export interface SalePaymentInput {
  method: string;                       // 'CASH' | 'MOMO_*' | 'CREDIT' | 'BANK_TRANSFER'
  amountPesewas: number;                // tender amount, must be > 0
  reference?: string | null;            // MoMo ref, check #, etc
  cashGivenPesewas?: number | null;     // only when method = CASH
}

export interface CompleteSaleInput {
  shiftId: string;
  workerId: string;
  workerName: string;
  locationId: string;
  channel: SaleChannel;
  lines: CompleteSaleLine[];
  discountPesewas?: number;
  discountReason?: string | null;
  /** Required when discount crosses the threshold (5% or GHS 2.00 absolute). */
  supervisorWorkerId?: string | null;
  supervisorPin?: string | null;

  // --- Payment: either a single tender (legacy) or a payments[] array (split) ---
  /** New: array of tenders. Sum of amountPesewas must equal total_pesewas. */
  payments?: SalePaymentInput[];
  /** Legacy single-tender shortcut. If `payments` is omitted, these fields
   *  build a single-row payments array. */
  paymentMethod?: string;
  paymentReference?: string | null;
  cashGivenPesewas?: number | null;

  customerId?: string | null;
  deviceId: string;
  shopName: string;
  shopSubtitle?: string | null;
}

export interface CompleteSaleResult {
  saleId: string;
  totalPesewas: number;
  changePesewas: number | null;
  printerFailed: boolean;
  printerError?: string;
}

/**
 * Atomic sale: writes sales + sale_lines + stock_movements + audit_log
 * in one DB transaction. Then attempts to print the receipt; if the
 * printer fails, flips sales.printer_failed and inserts a
 * pending_receipt_reprints row. The sale is NOT rolled back on a
 * printer failure — we trust the DB write, and let the supervisor
 * reprint later.
 */
export async function completeSale(
  db: DB,
  input: CompleteSaleInput,
): Promise<CompleteSaleResult> {
  // --- input validation -----------------------------------------------------
  if (input.lines.length === 0) {
    throw new Error('completeSale: cart is empty');
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`completeSale: line quantity must be a positive integer, got ${line.quantity}`);
    }
    if (!Number.isInteger(line.unitPricePesewas) || line.unitPricePesewas < 0) {
      throw new Error(`completeSale: line unitPricePesewas must be a non-negative integer`);
    }
  }
  const discount = input.discountPesewas ?? 0;
  if (!Number.isInteger(discount) || discount < 0) {
    throw new Error(`completeSale: discountPesewas must be a non-negative integer`);
  }
  if (discount > 0 && !input.discountReason) {
    throw new Error(`completeSale: discount > 0 requires a discountReason`);
  }

  // Normalize legacy single-payment -> payments[] array. After this block,
  // `payments` is the source of truth and `input.paymentMethod` etc are
  // ignored.
  let payments: SalePaymentInput[];
  if (input.payments && input.payments.length > 0) {
    payments = input.payments;
  } else if (input.paymentMethod) {
    payments = [{
      method: input.paymentMethod,
      amountPesewas: 0, // placeholder — filled below once we know totalPesewas
      reference: input.paymentReference ?? null,
      cashGivenPesewas: input.cashGivenPesewas ?? null,
    }];
  } else {
    throw new Error('completeSale: must provide either `payments` or `paymentMethod`');
  }

  // Invariant 10: every MoMo tender must carry a reference.
  for (const p of payments) {
    if (p.method.startsWith('MOMO_')) {
      if (!p.reference || p.reference.trim() === '') {
        throw new Error(
          'MoMo payment requires a transaction reference. Ask the customer for the txn ID.',
        );
      }
    }
  }

  // CREDIT can be a tender within a split — but if any line is CREDIT we need
  // a customer. (You can pay 30 cash + 50 credit; the 50 needs a customer.)
  const hasCredit = payments.some((p) => p.method === 'CREDIT');
  if (hasCredit && !input.customerId) {
    throw new Error('completeSale: credit tender requires a customer');
  }
  // Legacy isCredit boolean used downstream for stock movement reason +
  // sales.is_credit flag. Keep meaning: "this sale has any credit tender."
  const isCredit = hasCredit;
  if (input.customerId) {
    const cust = db
      .prepare(
        `SELECT id, blocked, current_balance_pesewas, credit_limit_pesewas
           FROM customers WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(input.customerId) as
      | { id: string; blocked: number; current_balance_pesewas: number; credit_limit_pesewas: number }
      | undefined;
    if (!cust) throw new Error(`completeSale: customer ${input.customerId} not found`);
    if (cust.blocked === 1) throw new Error(`completeSale: customer is blocked from credit`);
  }

  // --- compute totals -------------------------------------------------------
  // Snapshot cost from products at sale time.
  const productRows = new Map<
    string,
    { name: string; cost: number; isReturnable: number }
  >();
  for (const line of input.lines) {
    const p = db
      .prepare(
        `SELECT name, cost_price_pesewas, is_returnable
           FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL`,
      )
      .get(line.productId) as
      | { name: string; cost_price_pesewas: number; is_returnable: number }
      | undefined;
    if (!p) {
      throw new Error(`completeSale: product ${line.productId} not found or inactive`);
    }
    productRows.set(line.productId, {
      name: p.name,
      cost: p.cost_price_pesewas,
      isReturnable: p.is_returnable,
    });
  }

  // Resolve sellable unit per line. If unitId is omitted, fall back to the
  // product's defaultSaleUnit(). Convert quantity to canonical for stock
  // movements; line totals stay in unit-priced math.
  type ResolvedLine = {
    productId: string; unitId: string; unitName: string;
    factor: number;                      // unit -> canonical
    quantityInUnit: number;
    quantityCanonical: number;
    unitPricePesewas: number;
    canonicalUnitCostPesewas: number;    // products.cost_price_pesewas / factor (rounded down — see note)
  };
  const resolvedLines: ResolvedLine[] = [];
  const appliedTierIds: Array<string | null> = [];

  for (const l of input.lines) {
    let unit;
    if (l.unitId) {
      unit = getUnit(db, l.unitId);
      if (!unit) throw new Error(`completeSale: unit ${l.unitId} not found`);
      if (!unit.active) throw new Error(`completeSale: unit ${l.unitId} is inactive`);
      if (unit.productId !== l.productId) {
        throw new Error(`completeSale: unit ${l.unitId} does not belong to product ${l.productId}`);
      }
      if (!unit.isSaleUnit) {
        throw new Error(`completeSale: unit '${unit.unitName}' is not flagged as a sale unit`);
      }
    } else {
      unit = defaultSaleUnit(db, l.productId);
      if (!unit) {
        // No defined units yet — accept the legacy "canonical-only" path.
        // We synthesize a virtual unit on the fly: factor=1, no DB id.
        unit = null;
      }
    }
    const factor = unit ? unit.conversionFactor : 1;
    const productRow = productRows.get(l.productId)!;
    // Cost per canonical unit. Floor to keep integer math; the per-line cost
    // is then quantityCanonical * canonicalUnitCost.
    const canonicalCost = Math.floor(productRow.cost / factor);
    const quantityCanonical = l.quantity * factor;

    // Volume tier: lookup is canonical-quantity, channel-aware, AND
    // unit-aware. A tier with applies_to_unit_id = unit.id only matches when
    // this line is sold in that unit; tiers with applies_to_unit_id = NULL
    // apply across all units.
    const tier = bestTierFor(
      db, l.productId, input.channel, quantityCanonical,
      unit ? unit.id : null,
    );
    let unitPrice = l.unitPricePesewas;
    let appliedTierId: string | null = null;

    // Wave C.2: per-customer price override beats the line's input price.
    // Override is per-display-unit (same units as l.unitPricePesewas), so
    // no factor conversion needed here. Tier may still beat the override
    // if a volume break gives a better price.
    if (input.customerId && unit) {
      const ov = findBestOverride(db, input.customerId, l.productId, unit.id, input.channel);
      if (ov && ov.pricePesewas < unitPrice) {
        unitPrice = ov.pricePesewas;
      }
    }

    if (tier && tier.unitPricePesewas < unitPrice) {
      // Tier is per-canonical-unit; convert to per-unit for line math.
      const tierUnitPrice = tier.unitPricePesewas * factor;
      if (tierUnitPrice < unitPrice) {
        unitPrice = tierUnitPrice;
        appliedTierId = tier.id;
      }
    }
    appliedTierIds.push(appliedTierId);

    resolvedLines.push({
      productId: l.productId,
      unitId: unit ? unit.id : '',          // empty = legacy canonical-only path
      unitName: unit ? unit.unitName : 'UNIT',
      factor,
      quantityInUnit: l.quantity,
      quantityCanonical,
      unitPricePesewas: unitPrice,
      canonicalUnitCostPesewas: canonicalCost,
    });
  }

  const subtotalPesewas = resolvedLines.reduce(
    (sum, l) => sum + l.unitPricePesewas * l.quantityInUnit,
    0,
  );
  const totalPesewas = subtotalPesewas - discount;
  if (totalPesewas < 0) {
    throw new Error(`completeSale: discount exceeds subtotal`);
  }

  // Discount supervisor gate: above either threshold, supervisor PIN required.
  if (discount > 0) {
    const percentLimit = Math.floor((subtotalPesewas * DISCOUNT_PERCENT_THRESHOLD_BPS) / 10000);
    const limit = Math.max(percentLimit, DISCOUNT_ABS_THRESHOLD_PESEWAS);
    if (discount > limit) {
      if (!input.supervisorWorkerId || !input.supervisorPin) {
        throw new Error(
          `discount of ${discount} pesewas exceeds the ${limit}-pesewa limit and requires supervisor approval`,
        );
      }
      const sup = db
        .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
        .get(input.supervisorWorkerId) as
        | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
        | undefined;
      if (!sup || sup.active !== 1 || sup.deleted_at || sup.terminated_at) {
        throw new Error('discount supervisor not found or inactive');
      }
      if (!['SUPERVISOR', 'OWNER', 'FOUNDER'].includes(sup.role)) {
        throw new Error(`${sup.role} cannot approve a discount; need SUPERVISOR/OWNER/FOUNDER`);
      }
      const auth = verifyPin(db, input.supervisorWorkerId, input.supervisorPin, input.deviceId);
      if (!auth.ok) {
        throw new Error(
          auth.reason === 'LOCKED_OUT'
            ? `discount supervisor locked out until ${auth.lockedUntil}`
            : `discount supervisor PIN check failed (${auth.reason})`,
        );
      }
    }
  }

  // CASH: compute change. We allow cashGiven to equal total (no change).
  let changePesewas: number | null = null;
  // For legacy single-tender callers we filled amountPesewas = 0 above.
  // Now that totalPesewas is known, set the legacy cash tender to total
  // (the cashier may have given MORE — stored on cash_given_pesewas).
  if (input.payments == null && payments.length === 1) {
    payments[0]!.amountPesewas = totalPesewas;
  }

  // Validate every tender amount + cash overpay rules.
  for (const p of payments) {
    if (!Number.isInteger(p.amountPesewas) || p.amountPesewas <= 0) {
      throw new Error(`completeSale: tender amount must be a positive integer (${p.method}: ${p.amountPesewas})`);
    }
    if (p.method === 'CASH' && p.cashGivenPesewas != null) {
      if (!Number.isInteger(p.cashGivenPesewas) || p.cashGivenPesewas < 0) {
        throw new Error(`completeSale: cashGivenPesewas must be a non-negative integer`);
      }
      if (p.cashGivenPesewas < p.amountPesewas) {
        throw new Error(`completeSale: cash given (${p.cashGivenPesewas}) less than tender (${p.amountPesewas})`);
      }
    }
  }

  const tendersTotal = payments.reduce((sum, p) => sum + p.amountPesewas, 0);
  if (tendersTotal !== totalPesewas) {
    throw new Error(
      `completeSale: tenders total ${tendersTotal} ≠ sale total ${totalPesewas}. ` +
      `Adjust amounts so payments sum exactly to the sale total.`,
    );
  }

  // Pick the "primary" method = largest tender. Stable tiebreaker: first occurrence.
  let primary = payments[0]!;
  for (const p of payments) if (p.amountPesewas > primary.amountPesewas) primary = p;

  // Aggregate change across all CASH tenders.
  changePesewas = payments
    .filter((p) => p.method === 'CASH' && p.cashGivenPesewas != null)
    .reduce((acc, p) => acc + ((p.cashGivenPesewas ?? p.amountPesewas) - p.amountPesewas), 0);
  if (changePesewas === 0) changePesewas = null; // null when no cash overpay

  // Map channel -> stock-movement reason code.
  const reasonCode =
    isCredit ? 'SALE_CREDIT'
    : input.channel === 'ROUTE' ? 'SALE_ROUTE'
    : 'SALE_WALK_IN';

  const saleId = `sa-${uuidv4()}`;
  const now = new Date().toISOString();

  // --- atomic transaction ---------------------------------------------------
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sales (
        id, shift_id, worker_id, location_id, customer_id, channel,
        subtotal_pesewas, discount_pesewas, discount_reason, total_pesewas,
        payment_method, payment_reference, is_credit,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      saleId,
      input.shiftId,
      input.workerId,
      input.locationId,
      input.customerId ?? null,
      input.channel,
      subtotalPesewas,
      discount,
      discount > 0 ? input.discountReason ?? null : null,
      totalPesewas,
      primary.method,
      primary.reference ?? null,
      isCredit ? 1 : 0,
      input.workerId,
      input.workerId,
      input.deviceId,
    );

    // Insert one row per tender in sale_payments. Source of truth for splits.
    for (let pIdx = 0; pIdx < payments.length; pIdx++) {
      const pay = payments[pIdx]!;
      const payChange = (pay.method === 'CASH' && pay.cashGivenPesewas != null)
        ? (pay.cashGivenPesewas - pay.amountPesewas)
        : null;
      db.prepare(
        `INSERT INTO sale_payments (
          id, sale_id, payment_method, amount_pesewas, reference,
          cash_given_pesewas, change_pesewas, display_order,
          created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `s-pay-${uuidv4()}`,
        saleId,
        pay.method,
        pay.amountPesewas,
        pay.reference ?? null,
        pay.method === 'CASH' ? (pay.cashGivenPesewas ?? null) : null,
        payChange,
        pIdx,
        input.workerId,
        input.workerId,
        input.deviceId,
      );
    }

    for (let i = 0; i < resolvedLines.length; i++) {
      const line = resolvedLines[i]!;
      const tierId = appliedTierIds[i] ?? null;
      const lineId = `sl-${uuidv4()}`;
      // Line totals are computed in the unit the worker chose; quantity on
      // sale_lines is the unit-quantity (legacy semantics for non-unit products).
      const lineTotal = line.unitPricePesewas * line.quantityInUnit;
      // Margin uses canonical cost × canonical quantity for honesty across units.
      const totalCogsForLine = line.canonicalUnitCostPesewas * line.quantityCanonical;
      const margin = lineTotal - totalCogsForLine;

      db.prepare(
        `INSERT INTO sale_lines (
          id, sale_id, product_id, quantity,
          unit_price_pesewas, unit_cost_pesewas,
          line_total_pesewas, margin_pesewas, applied_tier_id, applied_unit_id,
          created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lineId,
        saleId,
        line.productId,
        line.quantityInUnit,
        line.unitPricePesewas,
        // sale_lines.unit_cost_pesewas snapshots cost-per-unit-sold (NOT canonical).
        // We compute it as canonicalCost * factor so margin = unit_price - unit_cost.
        line.canonicalUnitCostPesewas * line.factor,
        lineTotal,
        margin,
        tierId,
        line.unitId || null,
        input.workerId,
        input.workerId,
        input.deviceId,
      );

      // Stock movement is in CANONICAL units. Source unit recorded for audit.
      const sm = insertStockMovement(db, {
        productId: line.productId,
        locationId: input.locationId,
        quantity: line.quantityCanonical,
        reasonCode,
        shiftId: input.shiftId,
        workerId: input.workerId,
        saleId,
        unitCostPesewas: line.canonicalUnitCostPesewas,
        deviceId: input.deviceId,
      });
      if (line.unitId) {
        // Stash the source unit on the stock_movement row so reports can show
        // "1 crate sold (24 bottles canonical)".
        db.prepare('UPDATE stock_movements SET source_unit_id = ?, updated_at = ? WHERE id = ?')
          .run(line.unitId, new Date().toISOString(), sm.id);
      }
      if (!sm.id) throw new Error(`completeSale: stock movement insert returned no id`);
    }

    // --- Wave D: bonus-unit promotions --------------------------------
    // Compute bonus lines from the regular lines just rung up. Bonus lines
    // are priced at zero but still post a real stock movement (the goods
    // physically leave the shelf). The applied_promotion_id ties the row
    // back to the firing promo so reports can attribute supplier rebates.
    const bonuses = computeBonusLines(
      db,
      input.channel,
      resolvedLines.map((l) => ({
        productId: l.productId,
        unitId: l.unitId || null,
        quantity: l.quantityInUnit,
      })),
    );
    for (const b of bonuses) {
      // Look up the unit's conversion factor + product cost so the stock
      // movement is in canonical units and the margin maths stay honest.
      let factor = 1;
      if (b.unitId) {
        const u = db.prepare(
          `SELECT conversion_factor FROM product_units WHERE id = ?`,
        ).get(b.unitId) as { conversion_factor: number } | undefined;
        if (u) factor = u.conversion_factor;
      }
      const prodRow = db.prepare(
        `SELECT cost_price_pesewas FROM products WHERE id = ?`,
      ).get(b.productId) as { cost_price_pesewas: number } | undefined;
      const canonicalCost = prodRow ? Math.floor(prodRow.cost_price_pesewas / factor) : 0;
      const canonicalQty = b.bonusQty * factor;
      const unitCostForLine = canonicalCost * factor;
      const margin = -(unitCostForLine * b.bonusQty); // pure cost loss

      const lineId = `sl-${uuidv4()}`;
      db.prepare(
        `INSERT INTO sale_lines (
          id, sale_id, product_id, quantity,
          unit_price_pesewas, unit_cost_pesewas,
          line_total_pesewas, margin_pesewas, applied_tier_id, applied_unit_id,
          kind, applied_promotion_id,
          created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, NULL, ?, 'BONUS', ?, ?, ?, ?)`,
      ).run(
        lineId, saleId, b.productId, b.bonusQty,
        unitCostForLine, margin, b.unitId, b.promotionId,
        input.workerId, input.workerId, input.deviceId,
      );

      const sm = insertStockMovement(db, {
        productId: b.productId,
        locationId: input.locationId,
        quantity: canonicalQty,
        reasonCode,
        shiftId: input.shiftId,
        workerId: input.workerId,
        saleId,
        unitCostPesewas: canonicalCost,
        deviceId: input.deviceId,
      });
      if (b.unitId) {
        db.prepare('UPDATE stock_movements SET source_unit_id = ?, updated_at = ? WHERE id = ?')
          .run(b.unitId, new Date().toISOString(), sm.id);
      }
    }

    // Update credit balance for credit sales.
    if (isCredit && input.customerId) {
      db.prepare(
        `UPDATE customers
           SET current_balance_pesewas = current_balance_pesewas + ?,
               updated_at = ?,
               updated_by = ?
           WHERE id = ?`,
      ).run(totalPesewas, now, input.workerId, input.customerId);
    }

    if (discount > 0) {
      logAudit(db, {
        workerId: input.workerId,
        action: 'DISCOUNT_APPLIED',
        entityType: 'sales',
        entityId: saleId,
        afterValue: {
          discountPesewas: discount,
          discountReason: input.discountReason ?? null,
          subtotalPesewas,
          supervisorWorkerId: input.supervisorWorkerId ?? null,
        },
        deviceId: input.deviceId,
      });
    }

    logAudit(db, {
      workerId: input.workerId,
      action: 'SALE_COMPLETED',
      entityType: 'sales',
      entityId: saleId,
      afterValue: {
        channel: input.channel,
        totalPesewas,
        paymentMethod: primary.method,
        paymentBreakdown: payments.map((p) => ({ method: p.method, amount: p.amountPesewas })),
        lineCount: input.lines.length,
        customerId: input.customerId ?? null,
        appliedTierCount: appliedTierIds.filter((id) => id !== null).length,
        unitsSummary: resolvedLines.map((l) => ({ unitName: l.unitName, quantityInUnit: l.quantityInUnit, canonicalQuantity: l.quantityCanonical })),
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  // --- print receipt (outside the transaction) ------------------------------
  let customerName: string | null = null;
  if (input.customerId) {
    const r = db
      .prepare('SELECT display_name FROM customers WHERE id = ?')
      .get(input.customerId) as { display_name: string } | undefined;
    customerName = r?.display_name ?? null;
  }

  const receipt: SaleReceipt = {
    shopName: input.shopName,
    shopSubtitle: input.shopSubtitle ?? null,
    receiptId: saleId,
    workerName: input.workerName,
    saleAt: now,
    channel: input.channel,
    customerName,
    lines: resolvedLines.map((l) => {
      const baseName = productRows.get(l.productId)!.name;
      const isCanonical = !l.unitId || l.unitName === 'UNIT';
      return {
        quantity: l.quantityInUnit,
        name: isCanonical ? baseName : `${baseName} (${l.unitName})`,
        unitPricePesewas: l.unitPricePesewas,
        lineTotalPesewas: l.unitPricePesewas * l.quantityInUnit,
      };
    }),
    subtotalPesewas,
    discountPesewas: discount,
    totalPesewas,
    payment: {
      method: primary.method,
      reference: primary.reference ?? null,
      cashGivenPesewas: primary.method === 'CASH' ? (primary.cashGivenPesewas ?? null) : null,
      changePesewas,
    },
    payments: payments.map((p) => ({
      method: p.method,
      amountPesewas: p.amountPesewas,
      reference: p.reference ?? null,
      cashGivenPesewas: p.method === 'CASH' ? (p.cashGivenPesewas ?? null) : null,
      changePesewas: (p.method === 'CASH' && p.cashGivenPesewas != null) ? (p.cashGivenPesewas - p.amountPesewas) : null,
    })),
  };

  let printerFailed = false;
  let printerError: string | undefined;
  try {
    const result = await getPrinter().print(receipt);
    if (!result.ok) {
      printerFailed = true;
      printerError = `${result.reason}: ${result.message}`;
    }
  } catch (err) {
    printerFailed = true;
    printerError = err instanceof Error ? err.message : String(err);
  }

  if (printerFailed) {
    // Mark the sale + queue a reprint. Outside the original txn so a printer
    // hiccup never fails the sale.
    const flagTx = db.transaction(() => {
      db.prepare('UPDATE sales SET printer_failed = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), saleId);
      db.prepare(
        `INSERT INTO pending_receipt_reprints
          (id, sale_id, reason, created_by, updated_by, device_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        `prr-${uuidv4()}`,
        saleId,
        printerError ? printerError.slice(0, 80) : 'OFFLINE',
        input.workerId,
        input.workerId,
        input.deviceId,
      );
      logAudit(db, {
        workerId: input.workerId,
        action: 'SALE_RECEIPT_FAILED',
        entityType: 'sales',
        entityId: saleId,
        afterValue: { error: printerError ?? 'unknown' },
        deviceId: input.deviceId,
      });
    });
    flagTx();
  }

  return { saleId, totalPesewas, changePesewas, printerFailed, printerError };
}

/** Convenience: read shop_name / shop_subtitle from device_config. */
export function getShopHeader(db: DB): { shopName: string; shopSubtitle: string | null } {
  const rows = db
    .prepare('SELECT key, value FROM device_config WHERE key IN (?, ?)')
    .all('shop_name', 'shop_subtitle') as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    shopName: map.get('shop_name') ?? 'COUNTER SHOP',
    shopSubtitle: map.get('shop_subtitle') ?? null,
  };
}

export interface SaleWithLinesForDuplicate {
  saleId: string;
  channel: SaleChannel;
  customerId: string | null;
  customerName: string | null;
  lines: Array<{
    productId: string; productSku: string; productName: string;
    quantity: number; unitPricePesewas: number; unitsOnHand: number;
  }>;
}

/**
 * Fetch a sale's lines, suitable for "duplicate as new sale". Returns
 * channel + customer + each line with current stock so the renderer
 * can pre-fill the cart and warn if stock has changed since.
 */
export function getSaleWithLines(db: DB, saleId: string): SaleWithLinesForDuplicate {
  const sale = db
    .prepare(
      `SELECT s.id, s.channel, s.customer_id AS customerId, c.display_name AS customerName,
              s.location_id AS locationId
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.id = ?`,
    )
    .get(saleId) as
    | { id: string; channel: SaleChannel; customerId: string | null; customerName: string | null; locationId: string }
    | undefined;
  if (!sale) throw new Error(`getSaleWithLines: sale ${saleId} not found`);

  const rows = db
    .prepare(
      `SELECT sl.product_id AS productId, p.sku AS productSku, p.name AS productName,
              sl.quantity, sl.unit_price_pesewas AS unitPricePesewas
         FROM sale_lines sl
         JOIN products p ON p.id = sl.product_id
         WHERE sl.sale_id = ?
         ORDER BY sl.created_at ASC`,
    )
    .all(saleId) as Array<{
      productId: string; productSku: string; productName: string;
      quantity: number; unitPricePesewas: number;
    }>;

  const lines = rows.map((r) => ({
    ...r,
    unitsOnHand: unitsOnHand(db, r.productId, sale.locationId),
  }));

  return {
    saleId: sale.id,
    channel: sale.channel,
    customerId: sale.customerId,
    customerName: sale.customerName,
    lines,
  };
}
