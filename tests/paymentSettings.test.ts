import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { getPaymentSettings, setPaymentSettings } from '../src/main/services/paymentSettings';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrationsDir);
});

afterEach(() => db?.close());

describe('payment settings', () => {
  it('treats the bank as in use until the owner says otherwise', () => {
    expect(getPaymentSettings(db)).toEqual({ bankInUse: true });
  });

  it("keeps the owner's choice", () => {
    expect(setPaymentSettings(db, { bankInUse: false })).toEqual({ bankInUse: false });
    expect(getPaymentSettings(db)).toEqual({ bankInUse: false });
    expect(setPaymentSettings(db, { bankInUse: true })).toEqual({ bankInUse: true });
    expect(getPaymentSettings(db)).toEqual({ bankInUse: true });
  });

  it('reads anything it does not recognise as in use, and refuses a non-boolean', () => {
    db.prepare(`INSERT INTO device_config (key, value) VALUES ('bank_in_use', 'maybe')`).run();
    expect(getPaymentSettings(db)).toEqual({ bankInUse: true });
    expect(() => setPaymentSettings(db, { bankInUse: 'no' as unknown as boolean }))
      .toThrow(/true or false/);
  });
});
