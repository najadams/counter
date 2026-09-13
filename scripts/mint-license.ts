#!/usr/bin/env tsx
// Vendor-side activation key minting. Runs on YOUR machine, never ships.
//
//   npm run license:mint -- --licensee "Osu Drinks" --machine ABCD-EFGH-JKMN-PQRS
//
// The shop installs Counter, reads the machine code off the activation screen,
// sends it to you; you run this and send the key back. See CLAUDE.md §12.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  base32Decode,
  encodeKey,
  encodePayload,
  formatMachineCode,
  issuedDaysNow,
  ACTIVATION_VERSION,
  MACHINE_HASH_BYTES,
  MAX_LICENSEE_LEN,
  normalizeKey,
} from '../src/shared/lib/activationCode.js';

const DEFAULT_KEY_PATH = path.join(os.homedir(), '.counter', 'license-ed25519.key');

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function die(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

function keygen(): void {
  const keyPath = arg('out') ?? DEFAULT_KEY_PATH;
  if (fs.existsSync(keyPath) && !flag('force')) {
    die(
      `${keyPath} already exists.\n` +
        `  Overwriting it INVALIDATES every key you have ever issued.\n` +
        `  Pass --force only if you are certain.`,
    );
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  console.log(`\n  private key written to ${keyPath} (mode 0600) — back this up, never commit it`);
  console.log(`\n  paste this into PUBLIC_KEY_B64 in src/main/services/activation.ts:\n`);
  console.log(`  '${der}'\n`);
}

function mint(): void {
  const licensee = arg('licensee');
  const machine = arg('machine');
  const keyPath = arg('key') ?? process.env['COUNTER_LICENSE_KEY'] ?? DEFAULT_KEY_PATH;

  if (!licensee) die('--licensee "Shop Name" is required');
  if (!machine) die('--machine ABCD-EFGH-JKMN-PQRS is required (read it off the activation screen)');
  if (Buffer.byteLength(licensee, 'utf8') > MAX_LICENSEE_LEN) {
    die(`--licensee is longer than ${MAX_LICENSEE_LEN} bytes`);
  }
  if (!fs.existsSync(keyPath)) {
    die(`no signing key at ${keyPath}\n  run: npm run license:keygen`);
  }

  let machineHash: Uint8Array;
  try {
    machineHash = base32Decode(normalizeKey(machine));
  } catch (err) {
    die(`machine code is not readable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (machineHash.length !== MACHINE_HASH_BYTES) {
    die(
      `machine code decodes to ${machineHash.length} bytes, expected ${MACHINE_HASH_BYTES}\n` +
        `  it should look like ABCD-EFGH-JKMN-PQRS (16 characters)`,
    );
  }

  const issuedDays = issuedDaysNow();
  const payload = encodePayload({
    version: ACTIVATION_VERSION,
    machineBound: true,
    issuedDays,
    machineHash,
    licensee,
  });

  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const signature = crypto.sign(null, Buffer.from(payload), privateKey);
  const key = encodeKey(payload, new Uint8Array(signature));

  console.log(`\n  Licensee     ${licensee}`);
  console.log(`  Machine      ${formatMachineCode(machineHash)}`);
  console.log(`  Issued       ${new Date(issuedDays * 86_400_000).toISOString().slice(0, 10)}`);
  console.log(`  Key length   ${key.replace(/-/g, '').length} chars\n`);
  console.log('  ---- send everything between the lines ----\n');
  console.log(key);
  console.log('\n  ---- end ----\n');
}

if (flag('keygen')) keygen();
else if (flag('help') || process.argv.length <= 2) {
  console.log(`
  Counter licence minting

    npm run license:keygen
        Create the vendor signing keypair (once, ever).

    npm run license:mint -- --licensee "Osu Drinks" --machine ABCD-EFGH-JKMN-PQRS
        Mint a perpetual, machine-bound activation key.

  Options
    --key <path>   signing key (default ~/.counter/license-ed25519.key,
                   or $COUNTER_LICENSE_KEY)
`);
} else mint();
