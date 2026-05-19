import { describe, expect, it } from 'vitest';
import { formatStockCompact, formatStockInMixedUnits, inCanonical } from './units';

const BOX_PIECE = [
  { unitName: 'BOX', conversionFactor: 12 },
  { unitName: 'PIECE', conversionFactor: 1 },
];

describe('formatStockInMixedUnits', () => {
  it('breaks down into mixed units', () => {
    expect(formatStockInMixedUnits(149, BOX_PIECE)).toBe('12 BOX + 5 PIECE');
  });
  it('uses smallest unit when below first factor', () => {
    expect(formatStockInMixedUnits(5, BOX_PIECE)).toBe('5 PIECE');
  });
  it('omits zero remainders for larger units', () => {
    expect(formatStockInMixedUnits(12, BOX_PIECE)).toBe('1 BOX');
    expect(formatStockInMixedUnits(24, BOX_PIECE)).toBe('2 BOX');
  });
  it('always emits something for zero (uses smallest unit)', () => {
    expect(formatStockInMixedUnits(0, BOX_PIECE)).toBe('0 PIECE');
  });
  it('handles negative quantities (sign prefix)', () => {
    expect(formatStockInMixedUnits(-13, BOX_PIECE)).toBe('-1 BOX + 1 PIECE');
  });
  it('handles three-tier units (case, crate, bottle)', () => {
    const units = [
      { unitName: 'CASE', conversionFactor: 144 },
      { unitName: 'CRATE', conversionFactor: 12 },
      { unitName: 'BOTTLE', conversionFactor: 1 },
    ];
    expect(formatStockInMixedUnits(155, units)).toBe('1 CASE + 11 BOTTLE');
    expect(formatStockInMixedUnits(168, units)).toBe('1 CASE + 2 CRATE');
  });
  it('is order-insensitive for the units array', () => {
    const reversed = [
      { unitName: 'PIECE', conversionFactor: 1 },
      { unitName: 'BOX', conversionFactor: 12 },
    ];
    expect(formatStockInMixedUnits(149, reversed)).toBe('12 BOX + 5 PIECE');
  });
  it('falls back to raw number with no units', () => {
    expect(formatStockInMixedUnits(7, [])).toBe('7');
  });
  it('truncates non-integer input rather than blowing up', () => {
    expect(formatStockInMixedUnits(12.9, BOX_PIECE)).toBe('1 BOX');
  });
});

describe('formatStockCompact', () => {
  it('returns "0" for zero', () => {
    expect(formatStockCompact(0, BOX_PIECE)).toBe('0');
  });
  it('drops "+" separators', () => {
    expect(formatStockCompact(149, BOX_PIECE)).toBe('12 BOX 5 PIECE');
  });
});

describe('inCanonical', () => {
  it('multiplies', () => {
    expect(inCanonical(3, { conversionFactor: 12 })).toBe(36);
  });
});
