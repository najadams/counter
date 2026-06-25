// Session resolution for both transports.
//
// Desktop IPC is one OS process, one window, one signed-in worker — a single
// global is correct there and stays the default. The Phase 1 HTTP transport
// serves many devices at once, so it resolves a per-request session from a
// bearer token and runs each handler inside `requestSession.run(...)`.
//
// `requireWorker()` (in handlers.ts) calls currentSession(): request scope
// wins when present, else the desktop global. That one seam is why ~130
// handlers needed no changes to become multi-session aware.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import type { Station } from '../printer/printer.js';

export type Session = { workerId: string; fullName: string; role: string } | null;

/** Request-scoped context for non-IPC transports. Set by the HTTP dispatcher
 *  for the duration of one request; unset everywhere else. Carries the session,
 *  the remote device id (so audit attributes to the right device), and the
 *  print station (HTTP/phone -> 'door', desktop -> 'counter') so receipts route
 *  to the exit printer for phone sales. */
export const requestSession = new AsyncLocalStorage<{
  session: Session;
  deviceId?: string;
  station?: Station;
}>();

/** Desktop single-window session. */
let globalSession: Session = null;
export function setGlobalSession(session: Session): void {
  globalSession = session;
}

/** The session in effect for the current call. Request scope (HTTP) wins;
 *  otherwise the desktop global (IPC). */
export function currentSession(): Session {
  const scoped = requestSession.getStore();
  return scoped ? scoped.session : globalSession;
}

/** The print station for the current call. Set by the HTTP dispatcher to
 *  'door' (phones clear at the exit); the desktop IPC path leaves it unset and
 *  defaults to 'counter'. This is the single seam that routes phone receipts to
 *  the door printer without inferring origin from sale data. */
export function currentStation(): Station {
  return requestSession.getStore()?.station ?? 'counter';
}

/** The device id in effect for the current call: the remote device on the
 *  HTTP path, else the supplied host id (IPC, or HTTP requests with no device
 *  header). Lets audit attribute remote actions to the device that did them. */
export function currentDeviceId(fallback: string): string {
  return requestSession.getStore()?.deviceId ?? fallback;
}

// --- Token store (HTTP transport) ------------------------------------------
// Opaque, server-side bearer tokens (not signed). An in-memory Map is the hot
// path; a SQLite table (auth_tokens) is its durable backing, so a host reboot
// — routine under load-shedding — doesn't sign every LAN device out mid-shift.
// On boot, initTokenStore() rehydrates the still-valid rows. Two ceilings bound
// a token: an idle window (refreshed on use) and an absolute lifetime (never
// refreshed), so a captured-and-kept-alive token still expires within a day.
// Desktop IPC sessions never touch this store — they use the global above.

const TOKEN_IDLE_MS = 2 * 60 * 60 * 1000;    // 2h since last use
const TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h since issue, hard cap
// Don't write last_seen to disk on every request; only once it has advanced
// past this, so a busy device isn't a write amplifier. The exact in-memory
// last_seen still governs expiry — the persisted value only needs to be close
// enough to survive a reboot.
const LAST_SEEN_PERSIST_MS = 60 * 1000;

type TokenEntry = {
  session: NonNullable<Session>;
  /** Remote device id the token was issued to (audit / future binding). */
  deviceId: string;
  createdAt: number;
  lastSeen: number;
  /** last_seen value last written to disk; for write throttling. */
  lastPersisted: number;
};
const tokens = new Map<string, TokenEntry>();

// Durable backing. Null until initTokenStore() runs — and in tests/headless
// paths that never call it — so every disk write is guarded and the store
// works purely in memory when no DB is attached.
let store: DB | null = null;

function expired(entry: TokenEntry, now: number): boolean {
  return now - entry.lastSeen > TOKEN_IDLE_MS || now - entry.createdAt > TOKEN_MAX_AGE_MS;
}

/** Attach the SQLite backing and rehydrate the in-memory map from it, dropping
 *  rows that have already expired. Call once at boot, after migrations. Clears
 *  in-memory state first, so re-calling it also models a fresh process. */
export function initTokenStore(db: DB): void {
  store = db;
  tokens.clear();
  pruneExpiredTokens();
  const rows = db.prepare(
    'SELECT token, worker_id, full_name, role, device_id, created_at, last_seen FROM auth_tokens',
  ).all() as Array<{
    token: string; worker_id: string; full_name: string; role: string;
    device_id: string; created_at: number; last_seen: number;
  }>;
  for (const r of rows) {
    tokens.set(r.token, {
      session: { workerId: r.worker_id, fullName: r.full_name, role: r.role },
      deviceId: r.device_id,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
      lastPersisted: r.last_seen,
    });
  }
}

export function mintToken(session: NonNullable<Session>, deviceId: string): string {
  const token = randomUUID();
  const now = Date.now();
  tokens.set(token, { session, deviceId, createdAt: now, lastSeen: now, lastPersisted: now });
  store?.prepare(
    `INSERT INTO auth_tokens (token, worker_id, full_name, role, device_id, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, session.workerId, session.fullName, session.role, deviceId, now, now);
  return token;
}

/** Resolve a bearer token to its session, refreshing the idle window. Returns
 *  null for unknown or expired tokens (reaping the expired entry from memory
 *  and disk). Expiry is whichever comes first: idle timeout or absolute max. */
export function resolveToken(token?: string): Session {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  const now = Date.now();
  if (expired(entry, now)) {
    tokens.delete(token);
    store?.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return null;
  }
  entry.lastSeen = now;
  // Throttle disk writes: persist last_seen only once it has moved enough.
  if (store && now - entry.lastPersisted > LAST_SEEN_PERSIST_MS) {
    entry.lastPersisted = now;
    store.prepare('UPDATE auth_tokens SET last_seen = ? WHERE token = ?').run(now, token);
  }
  return entry.session;
}

export function revokeToken(token?: string): void {
  if (!token) return;
  tokens.delete(token);
  store?.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
}

/** Drop expired tokens from disk and memory. Cheap; called on boot and safe to
 *  call periodically over a long uptime. */
export function pruneExpiredTokens(now: number = Date.now()): void {
  for (const [token, entry] of tokens) {
    if (expired(entry, now)) tokens.delete(token);
  }
  store?.prepare(
    'DELETE FROM auth_tokens WHERE (? - last_seen) > ? OR (? - created_at) > ?',
  ).run(now, TOKEN_IDLE_MS, now, TOKEN_MAX_AGE_MS);
}
