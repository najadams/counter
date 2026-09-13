// Activation key format — pure, dependency-free, shared by the app, the
// minting script, and the tests.
//
// WHY ASYMMETRIC. Activation must work with no internet (a shop's line is down
// more often than it is up), so the check runs entirely on the shop's PC. A
// short typed code can only be verified offline against a secret baked into the
// binary — and anyone who unpacks the .asar then owns that secret and can mint
// unlimited keys. So the key carries an Ed25519 SIGNATURE over its own payload:
// the vendor holds the private key, every build ships only the public key. A
// forged key cannot be produced from anything in the shipped app.
//
// The cost of that choice is length: a 64-byte signature can't be shrunk, so the
// key is ~190 characters and is PASTED (WhatsApp, email), never typed. We format
// it in dashed groups anyway so a human can read it back over the phone if they
// ever have to.
//
// Encoding is Crockford base32: no I, L, O, U, and the decoder folds the
// look-alikes (I/L -> 1, O -> 0) so a transcription slip still resolves.

/** Crockford base32. Excludes I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const DECODE = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) DECODE.set(ALPHABET[i]!, i);
// Fold the confusables the alphabet deliberately omits.
DECODE.set('I', 1);
DECODE.set('L', 1);
DECODE.set('O', 0);

/** Current payload version. Bump if the layout below changes. */
export const ACTIVATION_VERSION = 1;
/** flags bit 0 — the payload carries a machine hash and is bound to that PC. */
export const FLAG_MACHINE_BOUND = 0x01;
/** Bytes of sha256(fingerprint) used to identify a machine. 80 bits. */
export const MACHINE_HASH_BYTES = 10;
/** Ed25519 signature length. */
export const SIGNATURE_BYTES = 64;
/** Licensee names longer than this are rejected at mint time. */
export const MAX_LICENSEE_LEN = 40;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]!;
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of input) {
    const v = DECODE.get(ch);
    if (v === undefined) throw new Error(`invalid character '${ch}' in key`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Strip formatting so a key pasted with dashes, spaces or newlines still
 *  parses, and fold case + look-alike characters. */
export function normalizeKey(input: string): string {
  return input.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** Group into dashed 5-char blocks for display. */
export function formatKey(raw: string, group = 5): string {
  const clean = normalizeKey(raw);
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += group) parts.push(clean.slice(i, i + group));
  return parts.join('-');
}

/** Machine codes are shown to humans in the same shape as recovery codes. */
export function formatMachineCode(hash: Uint8Array): string {
  return formatKey(base32Encode(hash.slice(0, MACHINE_HASH_BYTES)), 4);
}

export interface ActivationPayload {
  version: number;
  /** Bound to one PC — false is reserved for a future portable key. */
  machineBound: boolean;
  /** Days since the Unix epoch. Perpetual keys never expire; this is for the
   *  record and for support ("when did I issue this?"). */
  issuedDays: number;
  /** Present iff machineBound. */
  machineHash: Uint8Array | null;
  /** Shop / business name, shown in Settings and on the activation screen. */
  licensee: string;
}

export function issuedDaysNow(now = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000);
}

export function issuedDaysToISO(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10);
}

export function encodePayload(p: ActivationPayload): Uint8Array {
  const name = new TextEncoder().encode(p.licensee);
  if (name.length > MAX_LICENSEE_LEN) {
    throw new Error(`licensee name too long (${name.length} > ${MAX_LICENSEE_LEN} bytes)`);
  }
  if (p.machineBound && (!p.machineHash || p.machineHash.length !== MACHINE_HASH_BYTES)) {
    throw new Error(`machine-bound payload needs a ${MACHINE_HASH_BYTES}-byte machine hash`);
  }
  if (p.issuedDays < 0 || p.issuedDays > 0xffff) throw new Error('issuedDays out of range');

  const machineLen = p.machineBound ? MACHINE_HASH_BYTES : 0;
  const buf = new Uint8Array(4 + machineLen + 1 + name.length);
  buf[0] = p.version;
  buf[1] = p.machineBound ? FLAG_MACHINE_BOUND : 0;
  buf[2] = (p.issuedDays >>> 8) & 0xff;
  buf[3] = p.issuedDays & 0xff;
  let o = 4;
  if (p.machineBound) {
    buf.set(p.machineHash!, o);
    o += MACHINE_HASH_BYTES;
  }
  buf[o++] = name.length;
  buf.set(name, o);
  return buf;
}

export function decodePayload(buf: Uint8Array): ActivationPayload {
  if (buf.length < 5) throw new Error('key payload truncated');
  const version = buf[0]!;
  if (version !== ACTIVATION_VERSION) {
    throw new Error(`key is version ${version}; this build understands version ${ACTIVATION_VERSION}`);
  }
  const machineBound = (buf[1]! & FLAG_MACHINE_BOUND) !== 0;
  const issuedDays = (buf[2]! << 8) | buf[3]!;
  let o = 4;
  let machineHash: Uint8Array | null = null;
  if (machineBound) {
    if (buf.length < o + MACHINE_HASH_BYTES + 1) throw new Error('key payload truncated');
    machineHash = buf.slice(o, o + MACHINE_HASH_BYTES);
    o += MACHINE_HASH_BYTES;
  }
  const nameLen = buf[o++]!;
  if (buf.length < o + nameLen) throw new Error('key payload truncated');
  const licensee = new TextDecoder().decode(buf.slice(o, o + nameLen));
  return { version, machineBound, issuedDays, machineHash, licensee };
}

/** payload || signature, base32'd and dashed. */
export function encodeKey(payload: Uint8Array, signature: Uint8Array): string {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error(`signature must be ${SIGNATURE_BYTES} bytes, got ${signature.length}`);
  }
  const joined = new Uint8Array(payload.length + signature.length);
  joined.set(payload, 0);
  joined.set(signature, payload.length);
  return formatKey(base32Encode(joined));
}

export interface DecodedKey {
  payload: Uint8Array;
  signature: Uint8Array;
  fields: ActivationPayload;
}

/** Split a pasted key back into its signed payload and signature. Throws with
 *  a human-readable reason — the activation screen shows it verbatim. */
export function decodeKey(key: string): DecodedKey {
  const clean = normalizeKey(key);
  if (!clean) throw new Error('no key entered');
  const bytes = base32Decode(clean);
  if (bytes.length <= SIGNATURE_BYTES) throw new Error('key is too short to be valid');
  const payload = bytes.slice(0, bytes.length - SIGNATURE_BYTES);
  const signature = bytes.slice(bytes.length - SIGNATURE_BYTES);
  return { payload, signature, fields: decodePayload(payload) };
}
