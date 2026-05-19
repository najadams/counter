// Mixed-unit display helpers.
//
// Stock lives in the schema as a single integer in the canonical unit (the
// smallest sellable piece). Users think in their natural units — boxes,
// crates, bags — so we format the canonical integer back into mixed-unit
// notation for display: 149 canonical pieces becomes "12 boxes + 5 pieces"
// when the BOX/PIECE units are defined with factors 12 and 1.
//
// Math is always integer. We never introduce fractions.

export interface UnitDef {
  /** Display name. Capitalized however the user wants it. */
  unitName: string;
  /** How many canonical units make up one of this unit. Positive integer. */
  conversionFactor: number;
}

/**
 * Greedy mixed-unit breakdown.
 *
 *   formatStockInMixedUnits(149, [
 *     { unitName: 'BOX', conversionFactor: 12 },
 *     { unitName: 'PIECE', conversionFactor: 1 },
 *   ])  // -> "12 BOX + 5 PIECE"
 *
 *   formatStockInMixedUnits(0, [...])              // -> "0 PIECE" (smallest unit)
 *   formatStockInMixedUnits(-3, [...])             // -> "-3 PIECE"
 *   formatStockInMixedUnits(12, [...])             // -> "1 BOX"  (no remainder)
 *
 * Units are sorted internally largest-first; the order you pass them in
 * doesn't matter. If no units are passed, we just stringify the number.
 */
export function formatStockInMixedUnits(
  canonicalQty: number,
  units: readonly UnitDef[],
): string {
  if (!Number.isFinite(canonicalQty)) return '0';
  const qty = Math.trunc(canonicalQty);
  if (units.length === 0) return `${qty}`;

  const sign = qty < 0 ? '-' : '';
  let remaining = Math.abs(qty);

  const sorted = [...units]
    .filter((u) => u.conversionFactor > 0)
    .sort((a, b) => b.conversionFactor - a.conversionFactor);

  if (sorted.length === 0) return `${qty}`;

  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i]!;
    if (i === sorted.length - 1) {
      // Last (smallest) unit gobbles the remainder regardless of whether
      // it's zero — so we always emit something, even for qty=0.
      if (remaining > 0 || parts.length === 0) {
        parts.push(`${remaining} ${u.unitName}`);
      }
    } else if (remaining >= u.conversionFactor) {
      const count = Math.floor(remaining / u.conversionFactor);
      remaining -= count * u.conversionFactor;
      parts.push(`${count} ${u.unitName}`);
    }
  }

  return sign + parts.join(' + ');
}

/**
 * Compact variant: drops trailing "+ 0 X" segments, and if there's only one
 * level uses just the count. For dense table cells where space is at a
 * premium.
 *
 *   formatStockCompact(12, units)   // -> "1 BOX"
 *   formatStockCompact(149, units)  // -> "12 BOX 5 PIECE"
 *   formatStockCompact(0, units)    // -> "0"
 */
export function formatStockCompact(
  canonicalQty: number,
  units: readonly UnitDef[],
): string {
  if (canonicalQty === 0) return '0';
  return formatStockInMixedUnits(canonicalQty, units).replace(/ \+ /g, ' ');
}

/**
 * Convert a quantity expressed in some unit to canonical.
 *   inCanonical(3, { conversionFactor: 12 }) → 36
 */
export function inCanonical(quantityInUnit: number, unit: Pick<UnitDef, 'conversionFactor'>): number {
  return quantityInUnit * unit.conversionFactor;
}
