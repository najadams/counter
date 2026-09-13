// Hardware fingerprint for machine-bound activation keys.
//
// Deliberately NOT the device_id from db/deviceId.ts: that one lives inside
// counter.db and travels with the database on purpose ("moving the DB carries
// its identity with it"). An activation key has to bind to the PC, so it needs
// an identifier that does the opposite — one that stays behind when the DB is
// copied elsewhere, and survives the app being uninstalled and reinstalled.
//
// Each platform exposes an OS-level install id that fits:
//   Windows  HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
//   macOS    IOPlatformUUID from IOPlatformExpertDevice
//   Linux    /etc/machine-id (or the dbus copy)
//
// If none can be read we fall back to a random id persisted in userData. That
// is weaker (wiping userData re-rolls it), so the fallback is reported as such:
// callers MUST NOT treat a mismatch as proof of a different PC when either side
// of the comparison came from the fallback. A transient failure to read
// MachineGuid (a wedged `reg` on a loaded PC) would otherwise punish a shop
// that did nothing wrong — see enforcement policy in activation.ts.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MACHINE_HASH_BYTES, formatMachineCode } from '../../shared/lib/activationCode.js';

const EXEC_TIMEOUT_MS = 4000;
const FALLBACK_FILE = 'machine-fingerprint';

/** Where the fingerprint came from. 'fallback' means the OS lookup failed and
 *  the identity is a random id we persisted ourselves — usable, but never
 *  strong enough to enforce against. */
export type FingerprintSource = 'os' | 'fallback';

export interface MachineIdentity {
  fingerprint: string;
  source: FingerprintSource;
}

let cached: MachineIdentity | null = null;

function readWindowsGuid(): string | null {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
      { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readMacUuid(): string | null {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      timeout: EXEC_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readLinuxMachineId(): string | null {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Random id persisted next to the database. Last resort only. */
function readOrCreateFallback(fallbackDir: string): string {
  const file = path.join(fallbackDir, FALLBACK_FILE);
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  } catch {
    // not written yet
  }
  const v = crypto.randomUUID();
  try {
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(file, v, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Read-only dir: we still return a value so activation can proceed, but it
    // will not be stable across restarts. The mismatch banner is the safety net.
  }
  return v;
}

/** Platform fingerprint plus how confidently we got it. Cached per process. */
export function machineIdentity(fallbackDir: string): MachineIdentity {
  if (cached) return cached;
  const platform = os.platform();
  const osId =
    platform === 'win32'
      ? readWindowsGuid()
      : platform === 'darwin'
        ? readMacUuid()
        : readLinuxMachineId();
  const source: FingerprintSource = osId ? 'os' : 'fallback';
  const raw = osId ?? readOrCreateFallback(fallbackDir);
  // Namespace it so the same OS id used by another product yields a different
  // hash here, and normalise case/whitespace across platforms.
  cached = { fingerprint: `counter-v1:${platform}:${raw.trim().toLowerCase()}`, source };
  return cached;
}

/** Convenience for callers that only need the string. */
export function machineFingerprint(fallbackDir: string): string {
  return machineIdentity(fallbackDir).fingerprint;
}

/** First MACHINE_HASH_BYTES of sha256(fingerprint) — what a key binds to. */
export function machineHashOf(fingerprint: string): Uint8Array {
  return new Uint8Array(
    crypto.createHash('sha256').update(fingerprint, 'utf8').digest().subarray(0, MACHINE_HASH_BYTES),
  );
}

/** The dashed code the shop reads out to the vendor to get a key minted. */
export function machineCode(fallbackDir: string): string {
  return formatMachineCode(machineHashOf(machineFingerprint(fallbackDir)));
}

/** Test-only: drop the process cache. */
export function _resetMachineIdCache(): void {
  cached = null;
}
