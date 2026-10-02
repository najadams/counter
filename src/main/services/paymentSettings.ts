// Payment settings: which ways of moving money this shop actually uses.
//
// Stored as rows in device_config (no new table). Today there is one switch:
//
//   bank_in_use   '1' | '0'   does the shop pay and get paid through a bank?
//
// Unset reads as on, so an install that never opened Settings → Payments
// behaves exactly as before. This is a preference that tidies the payment
// choices and the owner reports, not a control: nothing refuses a bank
// transfer, and past bank payments stay in the records.

import type { Database as DB } from 'better-sqlite3';

export interface PaymentSettings {
  bankInUse: boolean;
}

const BANK_IN_USE_KEY = 'bank_in_use';

export function getPaymentSettings(db: DB): PaymentSettings {
  const row = db
    .prepare(`SELECT value FROM device_config WHERE key = ?`)
    .get(BANK_IN_USE_KEY) as { value: string } | undefined;
  return { bankInUse: row?.value !== '0' };
}

export function setPaymentSettings(db: DB, settings: PaymentSettings): PaymentSettings {
  if (typeof settings.bankInUse !== 'boolean') {
    throw new Error('bankInUse must be true or false');
  }
  db.prepare(
    `INSERT INTO device_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(BANK_IN_USE_KEY, settings.bankInUse ? '1' : '0');
  return getPaymentSettings(db);
}
