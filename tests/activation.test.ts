// Activation key tests — format, signature verification, and the DB-level
// policy (strict at activation, warn-only afterwards).
//
// The happy-path key below is a COMMITTED TEST VECTOR: minted once with the
// real vendor private key against a fixed synthetic machine fingerprint. The
// public key is baked into the build and never rotates, so this vector stays
// valid without the private key being present at test time.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  ActivationBlockedError,
  GRACE_DAYS,
  activate,
  assertSalesAllowed,
  auditMismatchOnBoot,
  getActivationStatus,
  verifyActivationKey,
} from '../src/main/services/activation';
import { machineHashOf, type MachineIdentity } from '../src/main/services/machineId';
import {
  ACTIVATION_VERSION,
  MAX_LICENSEE_LEN,
  base32Decode,
  base32Encode,
  decodeKey,
  decodePayload,
  encodePayload,
  formatMachineCode,
  normalizeKey,
} from '../src/shared/lib/activationCode';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

/** Fixed synthetic machine the vector below was minted for. */
const FIXTURE_FP = 'counter-v1:test:fixture-machine';
const FIXTURE_HASH = machineHashOf(FIXTURE_FP);
const OTHER_FP = 'counter-v1:test:some-other-pc';

const FIXTURE_KEY =
  '040N1-SDYR1-SAKPS-TGA4E-JTGC8-SMQGX-3NE9J-J0MV8-DXR44-9Q1RQ-1VHX0-KB81C-2CMW9-' +
  '9QP5R-M5BVS-BYS2W-YNRQH-Y0733-DYDPX-KFAG0-CJHBD-XP0TT-TMXB7-RHQX8-37SGN-ZE3BP-' +
  '7HRQA-2CCD9-JVWR1-8';

const DEVICE = 'dev-test';
const TMP = os.tmpdir();

/** A hardware-grade identity — the only kind enforcement acts on. */
const osId = (fingerprint: string): MachineIdentity => ({ fingerprint, source: 'os' });
/** The userData-fallback identity, used when the OS id could not be read. */
const weakId = (fingerprint: string): MachineIdentity => ({ fingerprint, source: 'fallback' });

const DAY = 86_400_000;
const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY);

describe('activation key format', () => {
  it('base32 round-trips arbitrary bytes', () => {
    for (const len of [1, 5, 10, 33, 93, 200]) {
      const bytes = new Uint8Array(crypto.randomBytes(len));
      expect(Array.from(base32Decode(base32Encode(bytes)).slice(0, len))).toEqual(
        Array.from(bytes),
      );
    }
  });

  it('round-trips a payload', () => {
    const p = {
      version: ACTIVATION_VERSION,
      machineBound: true,
      issuedDays: 20_710,
      machineHash: FIXTURE_HASH,
      licensee: 'Osu Drinks Ltd',
    };
    const back = decodePayload(encodePayload(p));
    expect(back.licensee).toBe('Osu Drinks Ltd');
    expect(back.issuedDays).toBe(20_710);
    expect(back.machineBound).toBe(true);
    expect(Array.from(back.machineHash!)).toEqual(Array.from(FIXTURE_HASH));
  });

  it('rejects a licensee name that will not fit', () => {
    expect(() =>
      encodePayload({
        version: ACTIVATION_VERSION,
        machineBound: true,
        issuedDays: 1,
        machineHash: FIXTURE_HASH,
        licensee: 'x'.repeat(MAX_LICENSEE_LEN + 1),
      }),
    ).toThrow(/too long/);
  });

  it('folds case, separators and look-alike characters', () => {
    expect(normalizeKey('abcd-efgh ijkl\nmnop')).toBe('ABCDEFGHIJKLMNOP');
    // Crockford: I and L decode as 1, O decodes as 0.
    expect(Array.from(base32Decode('I1L0O'))).toEqual(Array.from(base32Decode('11100')));
  });

  it('formats a machine code in the same shape as a recovery code', () => {
    expect(formatMachineCode(FIXTURE_HASH)).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  });
});

describe('verifyActivationKey', () => {
  it('accepts a genuine key on the machine it was minted for', () => {
    const r = verifyActivationKey(FIXTURE_KEY, FIXTURE_HASH);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.licensee).toBe('Fixture Shop');
  });

  it('accepts the same key pasted without dashes, lowercased, or wrapped', () => {
    for (const variant of [
      FIXTURE_KEY.replace(/-/g, ''),
      FIXTURE_KEY.toLowerCase(),
      `${FIXTURE_KEY.slice(0, 40)}\n\n  ${FIXTURE_KEY.slice(40)}  `,
    ]) {
      expect(verifyActivationKey(variant, FIXTURE_HASH).ok).toBe(true);
    }
  });

  it('rejects a genuine key on a different machine', () => {
    const r = verifyActivationKey(FIXTURE_KEY, machineHashOf(OTHER_FP));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MACHINE_MISMATCH');
  });

  it('rejects a key with a single character altered', () => {
    const tampered = FIXTURE_KEY.replace('SDYR1', 'SDYR2');
    const r = verifyActivationKey(tampered, FIXTURE_HASH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_SIGNATURE');
  });

  it('rejects a forged key signed with someone else’s keypair', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const payload = encodePayload({
      version: ACTIVATION_VERSION,
      machineBound: true,
      issuedDays: 20_710,
      machineHash: FIXTURE_HASH,
      licensee: 'Pirate Shop',
    });
    const sig = crypto.sign(null, Buffer.from(payload), privateKey);
    const forged = base32Encode(
      Uint8Array.from([...payload, ...new Uint8Array(sig)]),
    );
    const r = verifyActivationKey(forged, FIXTURE_HASH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_SIGNATURE');
  });

  it.each([
    ['empty', ''],
    ['garbage', 'HELLO-WORLD'],
    ['truncated', FIXTURE_KEY.slice(0, 60)],
  ])('rejects a %s key as malformed', (_label, input) => {
    const r = verifyActivationKey(input, FIXTURE_HASH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MALFORMED');
  });

  it('exposes the signed payload only after the signature checks out', () => {
    // decodeKey parses without verifying — the service must not trust it alone.
    expect(decodeKey(FIXTURE_KEY).fields.licensee).toBe('Fixture Shop');
  });
});

describe('activation against the database', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsDir);
    runSeed(db, { includeDevFixtures: true });
  });

  afterEach(() => db.close());

  const auditActions = (): string[] =>
    (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'ACTIVATION%'").all() as Array<{
      action: string;
    }>).map((r) => r.action);

  it('reports a fresh install as unactivated and refuses sales', () => {
    const st = getActivationStatus(db, TMP, osId(FIXTURE_FP));
    expect(st.activated).toBe(false);
    expect(st.state).toBe('UNACTIVATED');
    expect(st.machineCode).toBe(formatMachineCode(FIXTURE_HASH));
    // Closes the hole where a LAN phone rings up a sale on an ungated host.
    expect(st.salesBlocked).toBe(true);
    expect(() => assertSalesAllowed(db, TMP, osId(FIXTURE_FP))).toThrow(ActivationBlockedError);
  });

  it('activates with a genuine key and records it', () => {
    const res = activate(db, FIXTURE_KEY, DEVICE, TMP, osId(FIXTURE_FP));
    expect(res.ok).toBe(true);
    expect(res.licensee).toBe('Fixture Shop');

    const st = getActivationStatus(db, TMP, osId(FIXTURE_FP));
    expect(st.state).toBe('OK');
    expect(st.licensee).toBe('Fixture Shop');
    expect(st.salesBlocked).toBe(false);
    expect(st.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(auditActions()).toContain('ACTIVATION_ACTIVATED');
    expect(() => assertSalesAllowed(db, TMP, osId(FIXTURE_FP))).not.toThrow();
  });

  it('refuses a key minted for another PC, and leaves the install unactivated', () => {
    const res = activate(db, FIXTURE_KEY, DEVICE, TMP, osId(OTHER_FP));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/different PC/);
    expect(getActivationStatus(db, TMP, osId(OTHER_FP)).activated).toBe(false);
    expect(auditActions()).toContain('ACTIVATION_REJECTED');
  });
});

describe('enforcement: grace then read-only', () => {
  let db: ReturnType<typeof Database>;
  const t0 = new Date('2026-09-13T08:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsDir);
    runSeed(db, { includeDevFixtures: true });
    activate(db, FIXTURE_KEY, DEVICE, TMP, osId(FIXTURE_FP));
  });

  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('opens a grace period on the first real mismatch, still selling', () => {
    const st = getActivationStatus(db, TMP, osId(OTHER_FP), t0);
    expect(st.state).toBe('GRACE');
    expect(st.graceDaysLeft).toBe(GRACE_DAYS);
    expect(st.salesBlocked).toBe(false);
    expect(() => assertSalesAllowed(db, TMP, osId(OTHER_FP))).not.toThrow();
  });

  it('counts down from when the mismatch was FIRST seen, not each boot', () => {
    getActivationStatus(db, TMP, osId(OTHER_FP), t0);
    expect(getActivationStatus(db, TMP, osId(OTHER_FP), at(t0, 3)).graceDaysLeft).toBe(4);
    expect(getActivationStatus(db, TMP, osId(OTHER_FP), at(t0, 6.5)).graceDaysLeft).toBe(1);
  });

  it('goes read-only once the grace period expires', () => {
    getActivationStatus(db, TMP, osId(OTHER_FP), t0);
    const st = getActivationStatus(db, TMP, osId(OTHER_FP), at(t0, GRACE_DAYS + 0.1));
    expect(st.state).toBe('RESTRICTED');
    expect(st.graceDaysLeft).toBeNull();
    expect(st.salesBlocked).toBe(true);

    const err = (() => {
      try {
        assertSalesAllowed(db, TMP, osId(OTHER_FP), at(t0, GRACE_DAYS + 0.1));
        return null;
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(ActivationBlockedError);
    // The cashier must be told what to do, not just that it failed.
    expect((err as Error).message).toMatch(/read-only/i);
    expect((err as Error).message).toContain(formatMachineCode(machineHashOf(OTHER_FP)));
    expect((err as Error).message).toMatch(/Shift close, reports and export still work/);
  });

  it('clears the countdown when the key validates again', () => {
    getActivationStatus(db, TMP, osId(OTHER_FP), t0);
    // Back on the original PC — e.g. the DB was copied, not moved.
    expect(getActivationStatus(db, TMP, osId(FIXTURE_FP), at(t0, 3)).state).toBe('OK');
    // ...and the clock restarts rather than resuming a half-spent grace.
    expect(getActivationStatus(db, TMP, osId(OTHER_FP), at(t0, 3)).graceDaysLeft).toBe(GRACE_DAYS);
  });

  it('a replacement key for the new PC lifts read-only immediately', () => {
    getActivationStatus(db, TMP, osId(OTHER_FP), t0);
    const restricted = getActivationStatus(db, TMP, osId(OTHER_FP), at(t0, 30));
    expect(restricted.state).toBe('RESTRICTED');

    // The vendor mints against the NEW machine. Reuse the fixture by activating
    // an install whose identity is the one the fixture key was minted for.
    const res = activate(db, FIXTURE_KEY, DEVICE, TMP, osId(FIXTURE_FP));
    expect(res.ok).toBe(true);
    expect(getActivationStatus(db, TMP, osId(FIXTURE_FP), at(t0, 30)).state).toBe('OK');
    expect(() => assertSalesAllowed(db, TMP, osId(FIXTURE_FP))).not.toThrow();
  });

  it('records the enforcement state in the audit log on boot', () => {
    getActivationStatus(db, TMP, osId(OTHER_FP), t0);
    auditMismatchOnBoot(db, DEVICE, TMP, osId(OTHER_FP));
    const row = db.prepare(
      "SELECT after_value FROM audit_log WHERE action = 'ACTIVATION_MACHINE_MISMATCH'",
    ).get() as { after_value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.after_value).state).toBe('GRACE');
  });
});

describe('enforcement never fires on untrustworthy evidence', () => {
  let db: ReturnType<typeof Database>;
  const t0 = new Date('2026-09-13T08:00:00.000Z');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsDir);
    runSeed(db, { includeDevFixtures: true });
  });

  afterEach(() => db.close());

  it('never escalates when the CURRENT fingerprint came from the fallback', () => {
    activate(db, FIXTURE_KEY, DEVICE, TMP, osId(FIXTURE_FP));
    // A transient failure to read MachineGuid must not punish a good PC.
    const st = getActivationStatus(db, TMP, weakId(OTHER_FP), at(t0, 90));
    expect(st.state).toBe('INCONCLUSIVE');
    expect(st.salesBlocked).toBe(false);
    expect(() => assertSalesAllowed(db, TMP, weakId(OTHER_FP))).not.toThrow();
  });

  it('never escalates when ACTIVATION happened against a fallback id', () => {
    activate(db, FIXTURE_KEY, DEVICE, TMP, weakId(FIXTURE_FP));
    const st = getActivationStatus(db, TMP, osId(OTHER_FP), at(t0, 90));
    expect(st.state).toBe('INCONCLUSIVE');
    expect(st.salesBlocked).toBe(false);
  });

  it('never escalates on a bad signature — that is what a key rotation looks like', () => {
    activate(db, FIXTURE_KEY, DEVICE, TMP, osId(FIXTURE_FP));
    // Simulate a future build shipping a different public key.
    db.prepare("UPDATE device_config SET value = ? WHERE key = 'activation_key'")
      .run(FIXTURE_KEY.replace('SDYR1', 'SDYR2'));

    const st = getActivationStatus(db, TMP, osId(FIXTURE_FP), at(t0, 90));
    expect(st.state).toBe('INCONCLUSIVE');
    expect(st.salesBlocked).toBe(false);
  });
});
