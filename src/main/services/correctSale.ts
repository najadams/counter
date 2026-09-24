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
//
// Money: the customer already paid the original total, so the original
// tenders carry over UNCHANGED (cash stays cash, MoMo stays MoMo with its
// reference, pay-later stays on the same customer with the same due date).
// Only the extra is new, paid however the client says. Tenders are rebuilt
// here, never taken from the client, so a correction cannot quietly turn a
// debt or a MoMo payment into cash.
//
// Shift: the extra money goes into the drawer of the shift the sale was rung
// in, so that shift must still be open and the corrector must be working it
// (or have no shift of their own: a supervisor at the cashier's till). After
// the shift closes, missed items are a new sale in the current shift.

import type { Database as DB } from 'better-sqlite3';
import { logAudit } from '../db/audit.js';
import { assertNotSealed } from './periods.js';
import { getPrinter, type Station } from '../printer/printer.js';
import { loadSaleOutflows, voidSaleCore } from './voids.js';
import {
  completeSaleCore, flagReceiptFailed,
  type CompleteSaleLine, type SalePaymentInput, type SaleChannel,
} from './sales.js';
import type { SaleReceipt } from '../printer/receipt.js';

export const EXTRA_PAYMENT_METHODS = [
  'CASH', 'MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO', 'BANK_TRANSFER', 'CREDIT',
] as const;
export type ExtraPaymentMethod = (typeof EXTRA_PAYMENT_METHODS)[number];

/** How the customer pays for the ADDED items only. */
export interface CorrectSaleExtraPayment {
  method: ExtraPaymentMethod;
  /** MoMo / bank reference. */
  reference?: string | null;
  /** CASH only: what the customer handed over, for change. Defaults to exact. */
  cashGivenPesewas?: number | null;
}

export interface CorrectSaleInput {
  originalSaleId: string;
  /** ONLY the missed items. Original lines are rebuilt server-side. */
  addedLines: CompleteSaleLine[];
  /** How the extra is paid. The original tenders carry over as they were. */
  extraPayment: CorrectSaleExtraPayment;
  /** The corrector's own open shift, or null when they have none. */
  correctorShiftId: string | null;
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
  if (!EXTRA_PAYMENT_METHODS.includes(input.extraPayment?.method)) {
    throw new Error('correctSale: choose how the customer pays for the added items');
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
            is_credit AS isCredit, credit_due_date AS creditDueDate,
            voided, superseded_by_sale_id AS supersededBy, created_at AS createdAt
       FROM sales WHERE id = ?`,
  ).get(input.originalSaleId) as
    | {
        id: string; shiftId: string; workerId: string; locationId: string;
        customerId: string | null; channel: SaleChannel; totalPesewas: number;
        discountPesewas: number; discountReason: string | null; isCredit: number;
        creditDueDate: string | null;
        voided: number; supersededBy: string | null; createdAt: string;
      }
    | undefined;
  if (!orig) throw new Error(`correctSale: sale ${input.originalSaleId} not found`);
  if (orig.voided === 1) throw new Error('correctSale: sale is already voided');
  if (orig.supersededBy) throw new Error('correctSale: sale was already corrected');
  const pendingVoid = db.prepare(
    "SELECT 1 FROM sale_void_requests WHERE sale_id = ? AND status = 'PENDING' LIMIT 1",
  ).get(orig.id);
  if (pendingVoid) throw new Error('correctSale: sale has a pending void request; resolve or withdraw it first');

  // Refuse if the sale has been (partly) returned — voiding it would
  // double-restore stock. Those use the existing void + re-ring path.
  const returned = db.prepare(
    'SELECT 1 FROM customer_returns WHERE original_sale_id = ? LIMIT 1',
  ).get(input.originalSaleId);
  if (returned) throw new Error('correctSale: sale has a linked return; use void + re-ring instead');

  // Same day, same open shift, same drawer (see the header).
  const today = new Date().toISOString().slice(0, 10);
  if (orig.createdAt.slice(0, 10) !== today) {
    throw new Error('correctSale: only sales from today can be corrected; ring the missed items as a new sale');
  }
  assertNotSealed(db, orig.locationId, today, `correcting sale ${orig.id}`);
  const origShift = db.prepare('SELECT closed_at AS closedAt FROM shifts WHERE id = ?')
    .get(orig.shiftId) as { closedAt: string | null } | undefined;
  if (!origShift || origShift.closedAt) {
    throw new Error("correctSale: this sale's shift is closed; ring the missed items as a new sale");
  }
  if (input.correctorShiftId && input.correctorShiftId !== orig.shiftId) {
    throw new Error(
      "correctSale: this sale was rung in another cashier's shift; correct it at that till, or ring the missed items as a new sale",
    );
  }
  // Pay-later sales already paid down would leave those payments allocated to
  // the voided original. Rare on the same day; a return handles it instead.
  const allocated = db.prepare(
    'SELECT 1 FROM customer_payment_allocations WHERE sale_id = ? LIMIT 1',
  ).get(orig.id);
  if (allocated) {
    throw new Error('correctSale: the customer has already paid towards this sale; ring the missed items as a new sale');
  }

  // Original lines for the RE-RING, at their snapshot prices + units.
  const origSaleLines = db.prepare(
    `SELECT product_id AS productId, quantity, unit_price_pesewas AS unitPricePesewas,
            applied_unit_id AS unitId
       FROM sale_lines WHERE sale_id = ? ORDER BY created_at ASC`,
  ).all(input.originalSaleId) as Array<{
    productId: string; quantity: number; unitPricePesewas: number; unitId: string | null;
  }>;
  if (origSaleLines.length === 0) throw new Error('correctSale: original has no lines (corrupt)');

  // Original stock outflows for the VOID reversal — exact canonical
  // quantities and cost values, immune to conversion-factor edits since
  // the sale (same rationale as voidSale).
  const voidLines = loadSaleOutflows(db, input.originalSaleId);
  if (voidLines.length === 0) throw new Error('correctSale: original has no stock movements (corrupt)');

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

  // Tenders: the original ones as they were, plus the extra.
  const extraPesewas = input.addedLines.reduce((sum, l) => sum + l.quantity * l.unitPricePesewas, 0);
  const payments = correctedPayments(db, orig.id, orig.customerId, extraPesewas, input.extraPayment);

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
      payments,
      customerId: orig.customerId,
      // Pay-later keeps the original due date; the customer's terms don't
      // restart because an item was added.
      creditDueDate: orig.creditDueDate,
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
        extraPaymentMethod: input.extraPayment.method,
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

/**
 * The corrected sale's tenders: every original tender verbatim, plus the
 * extra. An extra in cash or pay-later joins the original tender of the same
 * kind (one cash line, one pay-later line on the receipt); MoMo and bank
 * keep their own line and reference.
 */
function correctedPayments(
  db: DB,
  originalSaleId: string,
  customerId: string | null,
  extraPesewas: number,
  extra: CorrectSaleExtraPayment,
): SalePaymentInput[] {
  const original = db.prepare(
    `SELECT payment_method AS method, amount_pesewas AS amountPesewas, reference
       FROM sale_payments WHERE sale_id = ? ORDER BY display_order, created_at`,
  ).all(originalSaleId) as Array<{ method: string; amountPesewas: number; reference: string | null }>;
  if (original.length === 0) throw new Error('correctSale: original has no payments (corrupt)');

  // Original cash was exact by now: any change was handed back at the time.
  const payments: SalePaymentInput[] = original.map((p) => ({
    method: p.method,
    amountPesewas: p.amountPesewas,
    reference: p.reference,
    cashGivenPesewas: p.method === 'CASH' ? p.amountPesewas : null,
  }));

  if (extra.method === 'CREDIT' && !customerId) {
    throw new Error('correctSale: pay later needs a customer on the sale');
  }
  const cashGiven = extra.method === 'CASH' ? (extra.cashGivenPesewas ?? extraPesewas) : null;
  if (cashGiven != null && (!Number.isInteger(cashGiven) || cashGiven < extraPesewas)) {
    throw new Error('correctSale: cash given is less than the amount to collect');
  }

  const merge = extra.method === 'CASH' || extra.method === 'CREDIT'
    ? payments.find((p) => p.method === extra.method)
    : undefined;
  if (merge) {
    merge.amountPesewas += extraPesewas;
    if (cashGiven != null) merge.cashGivenPesewas = (merge.cashGivenPesewas ?? 0) + cashGiven;
  } else {
    payments.push({
      method: extra.method,
      amountPesewas: extraPesewas,
      reference: extra.reference?.trim() || null,
      cashGivenPesewas: cashGiven,
    });
  }
  return payments;
}
