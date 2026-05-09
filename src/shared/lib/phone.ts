// Ghanaian phone numbers, normalized to +233XXXXXXXXX (12 chars after +).
//
// Local writing is messy: "0555547998", "555547998", "+233 555 547 998",
// "233-555-547998". We accept any of these and emit one canonical form.
// The DB column has CHECK (phone ~ '^\+233[0-9]{9}$') — anything that fails
// to normalize cannot be persisted.

const E164_GHANA = /^\+233[0-9]{9}$/;

/**
 * Normalize a Ghanaian phone number to +233XXXXXXXXX.
 * Returns null if the input cannot be made into a valid Ghana number.
 *
 * Accepts:
 *  - "+233555547998"  -> "+233555547998"
 *  - "233555547998"   -> "+233555547998"
 *  - "0555547998"     -> "+233555547998"  (drops leading 0, prepends +233)
 *  - "555547998"      -> "+233555547998"  (9-digit local, prepends +233)
 *  - whitespace, dashes, parens are stripped
 *
 * Rejects: anything that doesn't reduce to a valid 9-digit Ghana subscriber
 * number after stripping +233 / leading 0.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  // Strip everything that isn't a digit or leading +.
  const stripped = input.trim().replace(/[\s\-()]/g, '');
  if (stripped === '') return null;
  let digits = stripped;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  let local: string;
  if (digits.startsWith('233')) {
    local = digits.slice(3);
  } else if (digits.startsWith('0')) {
    local = digits.slice(1);
  } else {
    local = digits;
  }
  if (local.length !== 9) return null;
  if (!/^\d{9}$/.test(local)) return null;
  // Ghana mobile numbers start with 2/3/5 (MTN/Vodafone/AirtelTigo blocks).
  // Land lines start with other digits but we only care about mobile for SMS.
  // We don't enforce the carrier prefix here — let the caller decide.
  return `+233${local}`;
}

/**
 * Validate that a phone string is in canonical +233XXXXXXXXX form.
 * Used at DB-write boundary as a defensive double-check.
 */
export function isValidGhanaPhone(phone: string): boolean {
  return E164_GHANA.test(phone);
}

/**
 * Format a normalized number for human display.
 * "+233555547998" -> "+233 55 554 7998"
 * Returns the input unchanged if it isn't valid (caller can decide).
 */
export function formatPhoneForDisplay(phone: string): string {
  if (!isValidGhanaPhone(phone)) return phone;
  // +233 NN NNN NNNN
  return `+233 ${phone.slice(4, 6)} ${phone.slice(6, 9)} ${phone.slice(9, 13)}`;
}
