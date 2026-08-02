// Build-time app variants. Keep these flags tiny and side-effect free so they
// are safe to import from main, preload, renderer, tests, and scripts.

declare global {
  // Injected by Vite `define` at build time. Absent under vitest/tsx, where the
  // `process.env` fallback below takes over.
  // eslint-disable-next-line no-var
  var __COUNTER_VAT__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __COUNTERS_DECOY__: boolean | undefined;
}

export const VAT_ENABLED: boolean =
  typeof __COUNTER_VAT__ !== 'undefined'
    ? __COUNTER_VAT__
    : process.env['COUNTER_VAT'] === '1';

/** True only for the isolated fake-data "Counters" decoy build. */
export const COUNTERS_DECOY_ENABLED: boolean =
  typeof __COUNTERS_DECOY__ !== 'undefined'
    ? __COUNTERS_DECOY__
    : process.env['COUNTERS_DECOY'] === '1';
