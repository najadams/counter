import { describe, expect, it } from 'vitest';
import {
  applyDiscountBps,
  formatMoney,
  formatMoneyCompact,
  formatMoneyWithCurrency,
  multiplyMoney,
  parseCedisToPesewas,
  sumMoney,
} from './money';

describe('parseCedisToPesewas', () => {
  it('parses whole cedis', () => {
    expect(parseCedisToPesewas('5')).toBe(500);
  });
  it('parses cedis with decimals', () => {
    expect(parseCedisToPesewas('5.50')).toBe(550);
    expect(parseCedisToPesewas('5.5')).toBe(550);
    expect(parseCedisToPesewas('5.05')).toBe(505);
  });
  it('parses with commas', () => {
    expect(parseCedisToPesewas('1,234.56')).toBe(123456);
  });
  it('trims whitespace', () => {
    expect(parseCedisToPesewas(' 12.30 ')).toBe(1230);
  });
  it('rejects invalid input', () => {
    expect(parseCedisToPesewas('')).toBeNull();
    expect(parseCedisToPesewas('abc')).toBeNull();
    expect(parseCedisToPesewas('-5')).toBeNull();
    expect(parseCedisToPesewas('5.123')).toBeNull();
    expect(parseCedisToPesewas('5.')).toBeNull();
  });
  it('handles zero', () => {
    expect(parseCedisToPesewas('0')).toBe(0);
    expect(parseCedisToPesewas('0.00')).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats with two decimals', () => {
    expect(formatMoney(550)).toBe('5.50');
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(5)).toBe('0.05');
  });
  it('inserts thousands separators', () => {
    expect(formatMoney(123456)).toBe('1,234.56');
    expect(formatMoney(100000000)).toBe('1,000,000.00');
  });
  it('handles negatives', () => {
    expect(formatMoney(-550)).toBe('-5.50');
  });
  it('survives bad input', () => {
    expect(formatMoney(NaN)).toBe('0.00');
    expect(formatMoney(Infinity)).toBe('0.00');
  });
});

describe('formatMoneyCompact', () => {
  it('omits thousands separator', () => {
    expect(formatMoneyCompact(123456)).toBe('1234.56');
  });
});

describe('formatMoneyWithCurrency', () => {
  it('prefixes GHS', () => {
    expect(formatMoneyWithCurrency(550)).toBe('GHS 5.50');
  });
});

describe('sumMoney', () => {
  it('sums a list', () => {
    expect(sumMoney([100, 200, 300])).toBe(600);
  });
  it('handles empty', () => {
    expect(sumMoney([])).toBe(0);
  });
  it('truncates fractional inputs', () => {
    // Defensive: caller shouldn't pass these but if they do, no float drift.
    expect(sumMoney([100.7, 200.3])).toBe(300);
  });
});

describe('multiplyMoney', () => {
  it('multiplies by integer quantity', () => {
    expect(multiplyMoney(550, 3)).toBe(1650);
  });
  it('zero quantity is zero', () => {
    expect(multiplyMoney(550, 0)).toBe(0);
  });
  it('rejects non-integer quantity', () => {
    expect(() => multiplyMoney(550, 1.5)).toThrow();
    expect(() => multiplyMoney(550, -1)).toThrow();
  });
});

describe('applyDiscountBps', () => {
  it('applies a percentage discount', () => {
    expect(applyDiscountBps(1000, 500)).toBe(950); // 5% off 10.00 = 9.50
    expect(applyDiscountBps(10000, 1000)).toBe(9000); // 10% off 100.00 = 90.00
  });
  it('rounds down', () => {
    // 7% of 333 pesewas = 23.31 pesewas; floor = 23. Result = 333 - 23 = 310.
    expect(applyDiscountBps(333, 700)).toBe(310);
  });
  it('zero discount is identity', () => {
    expect(applyDiscountBps(500, 0)).toBe(500);
  });
  it('rejects out-of-range bps', () => {
    expect(() => applyDiscountBps(500, -1)).toThrow();
    expect(() => applyDiscountBps(500, 10001)).toThrow();
    expect(() => applyDiscountBps(500, 1.5)).toThrow();
  });
});
