// Money is integer pesewas. 1 cedi = 100 pesewas. GHS 5.50 is 550.
//
// This file is the only place where pesewas <-> cedis conversion is allowed
// to involve division. Everywhere else, math stays integer.
//
// Why so strict: floating point + currency = silent rounding bugs that
// compound across thousands of sales. Integer pesewas is the only honest way.

export const PESEWAS_PER_CEDI = 100;

export type Pesewas = number;

/**
 * Parse a user-entered cedi string into pesewas.
 * Accepts: "5.50", "5", "5.5", "1,234.56", " 12.30 ".
 * Rejects: negative, non-numeric, more than 2 decimal places.
 * Returns null on invalid input — caller decides UX.
 */
export function parseCedisToPesewas(input: string): Pesewas | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/,/g, '');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, decimal = ''] = trimmed.split('.');
  const wholePesewas = Number(whole) * PESEWAS_PER_CEDI;
  const decimalPesewas = Number((decimal + '00').slice(0, 2));
  return wholePesewas + decimalPesewas;
}

/**
 * Format pesewas as a cedi string with two decimals and thousands separators.
 * 550 -> "5.50". 123456 -> "1,234.56". 0 -> "0.00".
 * Negative values get a leading minus: -550 -> "-5.50".
 */
export function formatMoney(pesewas: Pesewas): string {
  if (!Number.isFinite(pesewas)) return '0.00';
  const negative = pesewas < 0;
  const abs = Math.abs(Math.trunc(pesewas));
  const cedis = Math.floor(abs / PESEWAS_PER_CEDI);
  const remainder = abs % PESEWAS_PER_CEDI;
  const cedisStr = cedis.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const remainderStr = remainder.toString().padStart(2, '0');
  return `${negative ? '-' : ''}${cedisStr}.${remainderStr}`;
}

/**
 * Compact format for tight UI (receipts, league tables).
 * 550 -> "5.50". 123456 -> "1234.56". No thousands separator.
 */
export function formatMoneyCompact(pesewas: Pesewas): string {
  if (!Number.isFinite(pesewas)) return '0.00';
  const negative = pesewas < 0;
  const abs = Math.abs(Math.trunc(pesewas));
  const cedis = Math.floor(abs / PESEWAS_PER_CEDI);
  const remainder = abs % PESEWAS_PER_CEDI;
  return `${negative ? '-' : ''}${cedis}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * Format with the GHS prefix. Used for headers and reports.
 * 550 -> "GHS 5.50".
 */
export function formatMoneyWithCurrency(pesewas: Pesewas): string {
  return `GHS ${formatMoney(pesewas)}`;
}

/**
 * Sum a list of pesewas values. Defends against accidental floats.
 */
export function sumMoney(values: readonly Pesewas[]): Pesewas {
  let total = 0;
  for (const v of values) {
    total += Math.trunc(v);
  }
  return total;
}

/**
 * Multiply a unit price by an integer quantity. Quantity must be a non-negative
 * integer; this function rejects fractions to prevent rounding sneaking in.
 */
export function multiplyMoney(unitPesewas: Pesewas, quantity: number): Pesewas {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`multiplyMoney: quantity must be non-negative integer, got ${quantity}`);
  }
  return Math.trunc(unitPesewas) * quantity;
}

/**
 * Apply a percentage discount in basis points (100 bps = 1%).
 * Always rounds down so we never give away more than intended.
 * applyDiscountBps(1000, 500) = 950 (5% off 10.00 = 9.50).
 */
export function applyDiscountBps(pesewas: Pesewas, bps: number): Pesewas {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(`applyDiscountBps: bps must be 0-10000, got ${bps}`);
  }
  const discount = Math.floor((pesewas * bps) / 10000);
  return pesewas - discount;
}
