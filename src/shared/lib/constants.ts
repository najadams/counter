// Operational constants. Import these — do not duplicate values inline.
// Anything that appears here is referenced from CLAUDE.md.

export const PESEWAS_PER_CEDI = 100;

/** The single shop location for v1. Multi-location is wired in schema, not UI. */
export const DEFAULT_LOCATION_ID = 'loc-main-counter';

/** The SYSTEM worker used for migration/seed writes and scheduled jobs. */
export const SYSTEM_WORKER_ID = 'sys-system';

/** Bcrypt cost factor for worker PIN hashing.
 *  PINs have low entropy (10K-1M possibilities), so we compensate with high cost.
 *  At 12, login latency is ~250ms — invisible to the worker, fatal to a brute-forcer. */
export const PIN_BCRYPT_ROUNDS = 12;

/** Receipt width: 58mm thermal = 32 columns. */
export const RECEIPT_COLUMNS = 32;

/** Required reason if shift-close cash variance exceeds this (absolute value). */
export const VARIANCE_REASON_THRESHOLD_PESEWAS = 2000; // GHS 20

/** Default monthly consumption allowance for a worker (in units, not points yet). */
export const DEFAULT_CONSUMPTION_ALLOWANCE_UNITS = 8;

/** Lockout: max wrong PIN attempts before temporary lockout, and lockout duration. */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MINUTES = 15;

/** Auto-backup trigger: shift closes at or after this local hour (24h) count
 *  as "last close of the day" and trigger an automatic backup, provided no
 *  backup heartbeat has been written for today yet. Closes before this hour
 *  do not trigger — they're assumed to be mid-day handovers, not end-of-day.
 *  Default 18 (6pm); adjust here if the shop typically closes earlier. */
export const END_OF_BUSINESS_DAY_HOUR = 18;

/** Discount thresholds. Above either, the sale needs supervisor approval.
 *  Both thresholds are checked against the discount amount; whichever is
 *  larger wins (so a small bill doesn't trigger supervisor for a 50p discount,
 *  and a big bill doesn't escape supervisor on a 5% discount that happens to
 *  fall under the absolute floor). */
export const DISCOUNT_PERCENT_THRESHOLD_BPS = 500; // 5.00%
export const DISCOUNT_ABS_THRESHOLD_PESEWAS = 200; // GHS 2.00
