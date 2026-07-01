// Ghana VAT — output-tax extraction for sales.
//
// Built as a BUILD-TIME variant: the no-VAT binary and the VAT binary come from
// the same source. `VAT_ENABLED` is fixed at build time by the Vite `define`
// that replaces the `__COUNTER_VAT__` token (see vite.config.ts). When the flag
// is off, dead branches tree-shake out and every sale records zero tax.
//
// Current law: Value Added Tax Act, 2025 (Act 1151), effective 1 January 2026.
// VAT 15% + NHIL 2.5% + GETFund 2.5%, ALL on the same base (no cascading); the
// COVID-19 Health Recovery Levy is abolished. Combined effective rate = 20%.
//
// Prices in Counter are VAT-INCLUSIVE (Ghana law for consumer prices), so the
// customer's total is identical to the no-VAT build. We EXTRACT the tax out of
// the inclusive total for the receipt and records. All integer pesewas.

import type { Pesewas } from './money.js';

declare global {
  // Injected by Vite `define` at build time. Absent under vitest/tsx, where the
  // `process.env` fallback below takes over. `typeof` on an undeclared global is
  // safe in JS (returns 'undefined' rather than throwing).
  // eslint-disable-next-line no-var
  var __COUNTER_VAT__: boolean | undefined;
}

/** Rates in basis points (100 bps = 1%). */
export const VAT_BPS = 1500; // standard VAT, 15%
export const NHIL_BPS = 250; // National Health Insurance Levy, 2.5%
export const GETFUND_BPS = 250; // Ghana Education Trust Fund Levy, 2.5%
/** Combined levy load on the taxable base: 20%. */
export const COMBINED_BPS = VAT_BPS + NHIL_BPS + GETFUND_BPS;

/** True in the VAT build, false in the no-VAT build. Fixed at build time. */
export const VAT_ENABLED: boolean =
  typeof __COUNTER_VAT__ !== 'undefined'
    ? __COUNTER_VAT__
    : process.env['COUNTER_VAT'] === '1';

export interface VatBreakdown {
  /** VAT-exclusive base. */
  taxablePesewas: Pesewas;
  vatPesewas: Pesewas;
  nhilPesewas: Pesewas;
  getfundPesewas: Pesewas;
}

/** A zero breakdown — what the no-VAT build records on every sale. */
export const ZERO_VAT: VatBreakdown = {
  taxablePesewas: 0,
  vatPesewas: 0,
  nhilPesewas: 0,
  getfundPesewas: 0,
};

/**
 * Extract the VAT/NHIL/GETFund components out of a VAT-INCLUSIVE total.
 *
 * The base is rounded once; the two levies are rounded off the base; VAT then
 * absorbs the residual so the identity always holds exactly:
 *
 *   taxable + vat + nhil + getfund === total
 *
 * VAT is the largest component, so making it the residual keeps the recorded
 * VAT within a pesewa of the nominal 15% — the honest place to put rounding.
 */
export function extractInclusiveVat(totalPesewas: Pesewas): VatBreakdown {
  if (!Number.isInteger(totalPesewas) || totalPesewas < 0) {
    throw new Error(`extractInclusiveVat: total must be a non-negative integer, got ${totalPesewas}`);
  }
  const taxablePesewas = Math.round((totalPesewas * 10000) / (10000 + COMBINED_BPS));
  const nhilPesewas = Math.round((taxablePesewas * NHIL_BPS) / 10000);
  const getfundPesewas = Math.round((taxablePesewas * GETFUND_BPS) / 10000);
  const vatPesewas = totalPesewas - taxablePesewas - nhilPesewas - getfundPesewas;
  return { taxablePesewas, vatPesewas, nhilPesewas, getfundPesewas };
}

/** The breakdown for a sale, honouring the build flag. */
export function vatForSale(totalPesewas: Pesewas): VatBreakdown {
  return VAT_ENABLED ? extractInclusiveVat(totalPesewas) : ZERO_VAT;
}
