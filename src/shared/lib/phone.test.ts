import { describe, expect, it } from 'vitest';
import { formatPhoneForDisplay, isValidGhanaPhone, normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('accepts already-normalized input', () => {
    expect(normalizePhone('+233555547998')).toBe('+233555547998');
  });
  it('accepts 233 without plus', () => {
    expect(normalizePhone('233555547998')).toBe('+233555547998');
  });
  it('accepts local 0-prefixed', () => {
    expect(normalizePhone('0555547998')).toBe('+233555547998');
  });
  it('accepts 9-digit local without prefix', () => {
    expect(normalizePhone('555547998')).toBe('+233555547998');
  });
  it('strips whitespace, dashes, parens', () => {
    expect(normalizePhone(' +233 555 547-998 ')).toBe('+233555547998');
    expect(normalizePhone('(0)555-547-998')).toBe('+233555547998');
  });
  it('rejects too short', () => {
    expect(normalizePhone('05555479')).toBeNull();
  });
  it('rejects too long', () => {
    expect(normalizePhone('05555479988')).toBeNull();
  });
  it('rejects non-digits', () => {
    expect(normalizePhone('055554799a')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('isValidGhanaPhone', () => {
  it('passes canonical', () => {
    expect(isValidGhanaPhone('+233555547998')).toBe(true);
  });
  it('fails non-canonical', () => {
    expect(isValidGhanaPhone('0555547998')).toBe(false);
    expect(isValidGhanaPhone('+233 555 547 998')).toBe(false);
    expect(isValidGhanaPhone('+23355554799')).toBe(false);
  });
});

describe('formatPhoneForDisplay', () => {
  it('formats with spaces', () => {
    expect(formatPhoneForDisplay('+233555547998')).toBe('+233 55 554 7998');
  });
  it('returns input on invalid', () => {
    expect(formatPhoneForDisplay('not a phone')).toBe('not a phone');
  });
});
