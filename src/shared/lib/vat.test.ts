import { describe, it, expect } from 'vitest';
import {
  extractInclusiveVat,
  VAT_BPS,
  NHIL_BPS,
  GETFUND_BPS,
  COMBINED_BPS,
} from './vat.js';

describe('extractInclusiveVat', () => {
  it('matches the documented worked example (GH¢12.00 inclusive)', () => {
    // base 10.00, VAT 1.50, NHIL 0.25, GETFund 0.25 -> total 12.00
    expect(extractInclusiveVat(1200)).toEqual({
      taxablePesewas: 1000,
      vatPesewas: 150,
      nhilPesewas: 25,
      getfundPesewas: 25,
    });
  });

  it('uses the current rates (15% + 2.5% + 2.5% = 20%)', () => {
    expect(VAT_BPS).toBe(1500);
    expect(NHIL_BPS).toBe(250);
    expect(GETFUND_BPS).toBe(250);
    expect(COMBINED_BPS).toBe(2000);
  });

  it('returns all zeros for a zero total', () => {
    expect(extractInclusiveVat(0)).toEqual({
      taxablePesewas: 0,
      vatPesewas: 0,
      nhilPesewas: 0,
      getfundPesewas: 0,
    });
  });

  it('keeps the identity taxable + vat + nhil + getfund === total across a wide sweep', () => {
    const totals = [
      0, 1, 2, 3, 7, 99, 100, 101, 121, 199, 250, 333, 500, 599, 1000, 1200,
      1234, 4999, 9999, 10000, 12345, 99991, 123457, 1000000, 7777777,
    ];
    for (const total of totals) {
      const b = extractInclusiveVat(total);
      expect(b.taxablePesewas + b.vatPesewas + b.nhilPesewas + b.getfundPesewas).toBe(total);
      // No component is ever negative.
      expect(b.taxablePesewas).toBeGreaterThanOrEqual(0);
      expect(b.vatPesewas).toBeGreaterThanOrEqual(0);
      expect(b.nhilPesewas).toBeGreaterThanOrEqual(0);
      expect(b.getfundPesewas).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the identity for every total from 0..5000 (exhaustive rounding check)', () => {
    for (let total = 0; total <= 5000; total++) {
      const b = extractInclusiveVat(total);
      expect(b.taxablePesewas + b.vatPesewas + b.nhilPesewas + b.getfundPesewas).toBe(total);
    }
  });

  it('keeps the taxable base close to total / 1.20', () => {
    for (const total of [1200, 6000, 12000, 99999]) {
      const b = extractInclusiveVat(total);
      const expectedBase = Math.round((total * 10000) / 12000);
      expect(b.taxablePesewas).toBe(expectedBase);
    }
  });

  it('rejects negative or non-integer totals', () => {
    expect(() => extractInclusiveVat(-1)).toThrow();
    expect(() => extractInclusiveVat(12.5)).toThrow();
  });
});
