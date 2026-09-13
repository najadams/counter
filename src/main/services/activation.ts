// Activation gate — verify a vendor-signed key against this machine.
//
// Policy (see CLAUDE.md §12):
//   * Keys are MACHINE-BOUND. A key minted for one PC will not activate another.
//   * Keys are PERPETUAL. There is no expiry field to lapse.
//   * A real mismatch after activation starts a GRACE_DAYS countdown. The till
//     works normally throughout; after it expires the install goes READ-ONLY —
//     no new sales, but shift close, reports, export and re-activation all keep
//     working, so a shop is pressured, never trapped.
//   * A mismatch we cannot TRUST is never enforced. If either the activation-
//     time or the current fingerprint came from the userData fallback rather
//     than an OS machine id, we cannot tell "different PC" from "couldn't read
//     this PC", so the state is INCONCLUSIVE and only warns. Same for a bad
//     signature, which is what a future public-key rotation would look like —
//     enforcing that would restrict every shop on upgrade.
//
// Activation also blocks the very first run: no key on file means the app
// routes to the activation screen instead of the setup wizard, and the sale
// channel refuses (so a LAN phone cannot ring one up past the desktop gate).

import type { Database as DB } from 'better-sqlite3';
import crypto from 'node:crypto';
import os from 'node:os';
import { logAudit } from '../db/audit.js';
import {
  decodeKey,
  issuedDaysToISO,
  type ActivationPayload,
} from '../../shared/lib/activationCode.js';
import { machineHashOf, machineIdentity, type MachineIdentity } from './machineId.js';
import { formatMachineCode } from '../../shared/lib/activationCode.js';

// Vendor public key (Ed25519, SPKI DER, base64). The matching PRIVATE key never
// ships — it lives on the vendor's machine and is used by
// `npm run license:mint`. Replacing this constant invalidates every key already
// issued, so treat it as permanent once you have shipped a build.
const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEACrdtetbw5qr7qYM9NRHNfshzDAcRCNlWx9tY/kZZn1g=';

const SYSTEM_ID = 'sys-system';

const K_KEY = 'activation_key';
const K_LICENSEE = 'activation_licensee';
const K_MACHINE = 'activation_machine_code';
const K_AT = 'activation_activated_at';
const K_ISSUED = 'activation_issued_on';
const K_SOURCE = 'activation_machine_source';
const K_MISMATCH_SINCE = 'activation_mismatch_since';

/** Days a shop keeps full function after a real machine mismatch is first seen. */
export const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

let publicKey: crypto.KeyObject | null = null;
function vendorPublicKey(): crypto.KeyObject {
  if (!publicKey) {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }
  return publicKey;
}

function readConfig(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM device_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeConfig(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO device_config (key, value, set_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`,
  ).run(key, value, new Date().toISOString());
}

export type VerifyFailure =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'MACHINE_MISMATCH'
  | 'NOT_MACHINE_BOUND';

export type VerifyResult =
  | { ok: true; fields: ActivationPayload }
  | { ok: false; reason: VerifyFailure; message: string };

/**
 * Check a pasted key: is it well-formed, genuinely signed by the vendor, and
 * minted for THIS machine?
 *
 * Pure with respect to the database — callers decide what a failure means.
 */
export function verifyActivationKey(key: string, expectedMachineHash: Uint8Array): VerifyResult {
  let decoded;
  try {
    decoded = decodeKey(key);
  } catch (err) {
    return {
      ok: false,
      reason: 'MALFORMED',
      message: err instanceof Error ? err.message : 'that key could not be read',
    };
  }

  const signatureValid = crypto.verify(
    null,
    Buffer.from(decoded.payload),
    vendorPublicKey(),
    Buffer.from(decoded.signature),
  );
  if (!signatureValid) {
    return {
      ok: false,
      reason: 'BAD_SIGNATURE',
      message: 'that key was not issued for Counter — check you pasted all of it',
    };
  }

  // Signature is good, so the payload below is vendor-attested from here on.
  if (!decoded.fields.machineBound || !decoded.fields.machineHash) {
    return {
      ok: false,
      reason: 'NOT_MACHINE_BOUND',
      message: 'that key is not bound to a machine; this build requires a machine-bound key',
    };
  }

  const a = Buffer.from(decoded.fields.machineHash);
  const b = Buffer.from(expectedMachineHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return {
      ok: false,
      reason: 'MACHINE_MISMATCH',
      message: 'that key was issued for a different PC',
    };
  }

  return { ok: true, fields: decoded.fields };
}
/**
 * What the install is allowed to do right now.
 *
 *  OK           key validates here
 *  UNACTIVATED  no key on file — first run, or a LAN phone hitting an
 *               unactivated host
 *  INCONCLUSIVE key does not validate, but the evidence is not trustworthy
 *               enough to act on (fallback fingerprint, or a bad signature).
 *               Warn only, forever — never escalates.
 *  GRACE        real mismatch, still inside GRACE_DAYS. Full function.
 *  RESTRICTED   real mismatch, grace expired. Read-only: no new sales.
 */
export type ActivationState = 'OK' | 'UNACTIVATED' | 'INCONCLUSIVE' | 'GRACE' | 'RESTRICTED';

export interface ActivationStatus {
  /** A key is on file. False only before the first successful activation. */
  activated: boolean;
  state: ActivationState;
  /** Business the key was issued to. */
  licensee: string | null;
  activatedAt: string | null;
  /** Date the vendor minted the key (YYYY-MM-DD). */
  issuedOn: string | null;
  /** This PC's code — always present, so support can ask for it. */
  machineCode: string;
  /** The stored key does not validate here, for any reason. */
  machineMismatch: boolean;
  /** Why, for the banner text. */
  mismatchReason: string | null;
  /** Whole days left before read-only kicks in. Only set in GRACE. */
  graceDaysLeft: number | null;
  /** True in RESTRICTED and UNACTIVATED — the sale channel will refuse. */
  salesBlocked: boolean;
}

/** Is this mismatch solid enough to act on? Both sides of the comparison must
 *  come from a real OS machine id, and the failure must actually be "different
 *  PC" rather than something a key rotation or DB edit could cause. */
function isEnforceable(
  reason: VerifyFailure,
  activationSource: string | null,
  currentSource: string,
): boolean {
  return reason === 'MACHINE_MISMATCH' && activationSource === 'os' && currentSource === 'os';
}

/**
 * Read activation state and re-check the stored key against this machine.
 *
 * Idempotently records when an enforceable mismatch was FIRST seen, which is
 * what the grace countdown runs from. `identity` is injectable so tests can pin
 * a machine; production callers omit it.
 */
export function getActivationStatus(
  db: DB,
  fallbackDir: string,
  identity: MachineIdentity = machineIdentity(fallbackDir),
  now: Date = new Date(),
): ActivationStatus {
  const code = formatMachineCode(machineHashOf(identity.fingerprint));
  const base = {
    licensee: readConfig(db, K_LICENSEE),
    activatedAt: readConfig(db, K_AT),
    issuedOn: readConfig(db, K_ISSUED),
    machineCode: code,
  };

  const stored = readConfig(db, K_KEY);
  if (!stored) {
    return {
      ...base,
      activated: false,
      state: 'UNACTIVATED',
      licensee: null,
      activatedAt: null,
      issuedOn: null,
      machineMismatch: false,
      mismatchReason: null,
      graceDaysLeft: null,
      salesBlocked: true,
    };
  }

  const check = verifyActivationKey(stored, machineHashOf(identity.fingerprint));
  if (check.ok) {
    // Back on a machine the key is good for — drop any countdown in progress.
    if (readConfig(db, K_MISMATCH_SINCE)) {
      db.prepare('DELETE FROM device_config WHERE key = ?').run(K_MISMATCH_SINCE);
    }
    return {
      ...base,
      activated: true,
      state: 'OK',
      machineMismatch: false,
      mismatchReason: null,
      graceDaysLeft: null,
      salesBlocked: false,
    };
  }

  if (!isEnforceable(check.reason, readConfig(db, K_SOURCE), identity.source)) {
    return {
      ...base,
      activated: true,
      state: 'INCONCLUSIVE',
      machineMismatch: true,
      mismatchReason: check.message,
      graceDaysLeft: null,
      salesBlocked: false,
    };
  }

  // Enforceable. Start the clock the first time we see it.
  let since = readConfig(db, K_MISMATCH_SINCE);
  if (!since) {
    since = now.toISOString();
    writeConfig(db, K_MISMATCH_SINCE, since);
  }
  const elapsedDays = (now.getTime() - new Date(since).getTime()) / DAY_MS;
  const daysLeft = Math.max(0, Math.ceil(GRACE_DAYS - elapsedDays));

  return {
    ...base,
    activated: true,
    state: daysLeft > 0 ? 'GRACE' : 'RESTRICTED',
    machineMismatch: true,
    mismatchReason: check.message,
    graceDaysLeft: daysLeft > 0 ? daysLeft : null,
    salesBlocked: daysLeft <= 0,
  };
}

export interface ActivateResult {
  ok: boolean;
  licensee?: string;
  message?: string;
}

/**
 * Activate this install with a pasted key. Rejects anything that does not
 * verify — unlike the post-activation re-check, this path is strict, because
 * refusing here costs a brand-new install nothing.
 *
 * On success any mismatch countdown is cleared: this is how a shop that
 * replaced a PC gets back to normal.
 */
export function activate(
  db: DB,
  key: string,
  deviceId: string,
  fallbackDir: string,
  identity: MachineIdentity = machineIdentity(fallbackDir),
): ActivateResult {
  const code = formatMachineCode(machineHashOf(identity.fingerprint));
  const result = verifyActivationKey(key, machineHashOf(identity.fingerprint));

  if (!result.ok) {
    logAudit(db, {
      workerId: SYSTEM_ID,
      action: 'ACTIVATION_REJECTED',
      entityType: 'device_config',
      entityId: K_KEY,
      afterValue: { reason: result.reason, machineCode: code },
      deviceId,
    });
    return { ok: false, message: result.message };
  }

  const now = new Date().toISOString();
  const issuedOn = issuedDaysToISO(result.fields.issuedDays);
  const tx = db.transaction(() => {
    writeConfig(db, K_KEY, key.trim());
    writeConfig(db, K_LICENSEE, result.fields.licensee);
    writeConfig(db, K_MACHINE, code);
    writeConfig(db, K_AT, now);
    writeConfig(db, K_ISSUED, issuedOn);
    // Remember how strong this machine's identity was. A key activated against
    // a fallback id is never enforced against later.
    writeConfig(db, K_SOURCE, identity.source);
    db.prepare('DELETE FROM device_config WHERE key = ?').run(K_MISMATCH_SINCE);
    logAudit(db, {
      workerId: SYSTEM_ID,
      action: 'ACTIVATION_ACTIVATED',
      entityType: 'device_config',
      entityId: K_KEY,
      afterValue: {
        licensee: result.fields.licensee,
        issuedOn,
        machineCode: code,
        machineSource: identity.source,
      },
      deviceId,
    });
  });
  tx();

  return { ok: true, licensee: result.fields.licensee };
}

/** Thrown by assertSalesAllowed so the renderer and the HTTP transport get an
 *  explanation a cashier can act on, not a bare failure. */
export class ActivationBlockedError extends Error {
  readonly state: ActivationState;
  constructor(state: ActivationState, message: string) {
    super(message);
    this.name = 'ActivationBlockedError';
    this.state = state;
  }
}

/**
 * Gate on ringing up a NEW sale. Deliberately narrow: this is the only thing
 * read-only mode takes away. Shift close, reports, export, stock and
 * re-activation are all left alone so the shop can finish its day and get its
 * books out.
 *
 * Enforced at the IPC boundary, which both the desktop and the LAN phones go
 * through — putting it in the UI alone would leave the HTTP transport open.
 */
export function assertSalesAllowed(
  db: DB,
  fallbackDir: string = os.tmpdir(),
  identity?: MachineIdentity,
  now: Date = new Date(),
): void {
  const st = getActivationStatus(db, fallbackDir, identity ?? machineIdentity(fallbackDir), now);
  if (!st.salesBlocked) return;

  throw new ActivationBlockedError(
    st.state,
    st.state === 'UNACTIVATED'
      ? 'This copy of Counter has not been activated. Enter the activation key on the host PC before ringing up sales.'
      : `Counter is read-only: the activation key no longer matches this PC and the ${GRACE_DAYS}-day grace period has run out. ` +
        `Send machine code ${st.machineCode} to your supplier for a replacement key. ` +
        'Shift close, reports and export still work.',
  );
}

/** Log the current enforcement state once per boot, so the audit trail shows
 *  when a key stopped matching and when read-only actually began. */
export function auditMismatchOnBoot(
  db: DB,
  deviceId: string,
  fallbackDir: string,
  identity: MachineIdentity = machineIdentity(fallbackDir),
): void {
  const status = getActivationStatus(db, fallbackDir, identity);
  if (!status.activated || !status.machineMismatch) return;
  logAudit(db, {
    workerId: SYSTEM_ID,
    action: 'ACTIVATION_MACHINE_MISMATCH',
    entityType: 'device_config',
    entityId: K_KEY,
    afterValue: {
      state: status.state,
      reason: status.mismatchReason,
      graceDaysLeft: status.graceDaysLeft,
      activatedMachineCode: readConfig(db, K_MACHINE),
      currentMachineCode: status.machineCode,
      currentMachineSource: identity.source,
    },
    deviceId,
  });
}
