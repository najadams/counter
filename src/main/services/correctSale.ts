// Correct a rung sale (Approach A, additive-only v1).
//
// The owner's common case: items were missed at ring time, so we ADD the missed
// products and collect more. We do NOT edit the finalized sale (that would break
// the append-only/immutable model the whole anti-shrinkage system rests on).
// Instead:
//
//   correctSale = void the original (voidSaleCore, append-only reversal)
//               + re-ring it pre-filled with the ORIGINAL lines at their snapshot
//                 prices + the added items (completeSaleCore, lockPrices)
//               + link the two (superseded_by / supersedes)
//               + SALE_CORRECTED audit + purge the original's pending reprint
//   ... all in ONE synchronous transaction, then print the "CORRECTED" receipt.
//
// v1 is STRICTLY ADDITIVE and cashier-allowed: the original lines are rebuilt
// server-side (the client only sends additions), so a removal/reduction is
// structurally impossible here — those keep using void + full re-ring. The
// supervisor-gated reduction path is deferred until the real-usage tally.

import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';
import { assertNotSealed } from './periods.js';
import { getPrinter, type Station } from '../printer/printer.js';
import { voidSaleCore } from './voids.js';
import {
  completeSaleCore, flagReceiptFailed,
  type CompleteSaleLine, type SalePaymentInput, type SaleChannel,
} from './sales.js';
import type { SaleReceipt } from '../printer/receipt.js';

export interface CorrectSaleInput {
  originalSaleId: string;
  /** ONLY the missed items. Original lines are rebuilt server-side. */
  addedLines: CompleteSaleLine[];
  /** Tenders for the FULL corrected total (completeSale requires they sum to it).
   *  The drawer nets the delta; the audit records it. */
  payments: SalePaymentInput[];
  workerId: string;
  workerName: string;
  deviceId: string;
  shopName: string;
  shopSubtitle?: string | null;
  station?: Station;
}

export interface CorrectSaleResult {
  originalSaleId: string;
  newSaleId: string;
  totalPesewas: number;
  /** newTotal − originalTotal; the extra collected. Always > 0 (additive). */
  deltaPesewas: number;
  changePesewas: number | null;
  printerFailed: boolean;
  printerError?: string;
  receipt: SaleReceipt;
  station: Station;
}

export async function correctSale(db: DB, input: CorrectSaleInput): Promise<CorrectSaleResult> {
  if (input.addedLines.length === 0) {
    throw new Error('correctSale: nothing added — a correction must add at least one item');
  }
  for (const l of input.addedLines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error('correctSale: added line quantity must be a positive integer');
    }
    if (!Number.isInteger(l.unitPricePesewas) || l.unitPricePesewas <= 0) {
      throw new Error('correctSale: added line unitPricePesewas must be a positive integer (additive only)');
    }
  }

  // --- load + guard the original (all before the transaction) ----------------
  const orig = db.prepare(
    `SELECT id, shift_id AS shiftId, worker_id AS workerId, location_id AS locationId,
            customer_id AS customerId, channel, total_pesewas AS totalPesewas,
            discount_pesewas AS discountPesewas, discount_reason AS discountReason,
            is_credit AS isCredit,
            voided, superseded_by_sale_id AS supersededBy, created_at AS createdAt
       FROM sales WHERE id = ?`,
  ).get(input.originalSaleId) as
    | {
        id: string; shiftId: string; workerId: string; locationId: string;
        customerId: string | null; channel: SaleChannel; totalPesewas: number;
        discountPesewas: number; discountReason: string | null; isCredit: number;
        voided: number; supersededBy: string | null; createdAt: string;
      }
    | undefined;
  if (!orig) throw new Error(`correctSale: sale ${input.originalSaleId} not found`);
  if (orig.voided === 1) throw new Error('correctSale: sale is already voided');
  if (orig.supersededBy) throw new Error('correctSale: sale was already corrected');

  // Refuse if the sale has been (partly) returned — voiding it would
  // double-restore stock. Those use the existing void + re-ring path.
  const returned = db.prepare(
    'SELECT 1 FROM customer_returns WHERE original_sale_id = ? LIMIT 1',
  ).get(input.originalSaleId);
  if (returned) throw new Error('correctSale: sale has a linked return; use void + re-ring instead');

  // Same-day only.
  assertNotSealed(db, orig.locationId, orig.createdAt.slice(0, 10), `correcting sale ${orig.id}`);

  // Original lines for the RE-RING, at their snapshot prices + units.
  const origSaleLines = db.prepare(
    `SELECT product_id AS productId, quantity, unit_price_pesewas AS unitPricePesewas,
            applied_unit_id AS unitId
       FROM sale_lines WHERE sale_id = ? ORDER BY created_at ASC`,
  ).all(input.originalSaleId) as Array<{
    productId: string; quantity: number; unitPricePesewas: number; unitId: string | null;
  }>;
  if (origSaleLines.length === 0) throw new Error('correctSale: original has no lines (corrupt)');

  // Original lines for the VOID reversal (need cost + conversion factor).
  const voidLines = db.prepare(
    `SELECT sl.product_id, sl.quantity, sl.unit_cost_pesewas,
            COALESCE(pu.conversion_factor, 1) AS conversion_factor
       FROM sale_lines sl
       LEFT JOIN product_units pu ON pu.id = sl.applied_unit_id
       WHERE sl.sale_id = ?`,
  ).all(input.originalSaleId) as Array<{
    product_id: string; quantity: number; unit_cost_pesewas: number; conversion_factor: number;
  }>;

  // The corrected cart = original lines (verbatim, snapshot-priced) + additions.
  const correctedLines: CompleteSaleLine[] = [
    ...origSaleLines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPricePesewas: l.unitPricePesewas,
      unitId: l.unitId ?? undefined,
    })),
    ...input.addedLines,
  ];

  const now = new Date().toISOString();
  const voidReason = `Superseded by correction of sale ${orig.id}`;

  // --- one atomic transaction: void + re-ring + link + audit + purge ---------
  // completeSaleCore runs its own inner transaction; nested inside this outer
  // one it becomes a savepoint, so the whole correction commits or rolls back
  // as a unit. Printing happens AFTER commit (below).
  const core = db.transaction(() => {
    voidSaleCore(db, {
      sale: { id: orig.id, location_id: orig.locationId, customer_id: orig.customerId, is_credit: orig.isCredit },
      lines: voidLines,
      workerId: input.workerId,
      reason: voidReason,
      deviceId: input.deviceId,
      supervisorApprovalId: null,
    });

    const built = completeSaleCore(db, {
      shiftId: orig.shiftId,
      workerId: input.workerId,
      workerName: input.workerName,
      locationId: orig.locationId,
      channel: orig.channel,
      lines: correctedLines,
      // Carry the original discount forward as a FIXED amount (premise 5: no
      // re-pricing). discountReason is required when discount > 0.
      discountPesewas: orig.discountPesewas,
      discountReason: orig.discountReason,
      payments: input.payments,
      customerId: orig.customerId,
      deviceId: input.deviceId,
      shopName: input.shopName,
      shopSubtitle: input.shopSubtitle ?? null,
      station: input.station,
      lockPrices: true,
      supersedesSaleId: orig.id,
    });

    // Bidirectional link: the original is now provably dead for the door/reports.
    db.prepare('UPDATE sales SET superseded_by_sale_id = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(built.saleId, now, input.workerId, orig.id);
    db.prepare('UPDATE sales SET supersedes_sale_id = ? WHERE id = ?')
      .run(orig.id, built.saleId);

    // Purge ONLY the original's open reprint so a stale receipt can't print
    // later and become a phantom exit token.
    db.prepare('DELETE FROM pending_receipt_reprints WHERE sale_id = ? AND resolved_at IS NULL')
      .run(orig.id);

    logAudit(db, {
      workerId: input.workerId,
      action: 'SALE_CORRECTED',
      entityType: 'sales',
      entityId: built.saleId,
      afterValue: {
        supersedesSaleId: orig.id,
        originalTotalPesewas: orig.totalPesewas,
        correctedTotalPesewas: built.totalPesewas,
        deltaPesewas: built.totalPesewas - orig.totalPesewas,
        addedLineCount: input.addedLines.length,
      },
      deviceId: input.deviceId,
    });

    return built;
  })();

  // --- print the corrected receipt (after commit) ----------------------------
  const station = core.station;
  let printerFailed = false;
  let printerError: string | undefined;
  try {
    const result = await getPrinter(station).print(core.receipt);
    if (!result.ok) { printerFailed = true; printerError = `${result.reason}: ${result.message}`; }
  } catch (err) {
    printerFailed = true;
    printerError = err instanceof Error ? err.message : String(err);
  }
  if (printerFailed) {
    flagReceiptFailed(db, core.saleId, station, printerError, input.workerId, input.deviceId);
  }

  return {
    originalSaleId: orig.id,
    newSaleId: core.saleId,
    totalPesewas: core.totalPesewas,
    deltaPesewas: core.totalPesewas - orig.totalPesewas,
    changePesewas: core.changePesewas,
    printerFailed,
    printerError,
    receipt: core.receipt,
    station,
  };
}
