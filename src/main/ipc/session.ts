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

export type Session = { workerId: string; fullName: string; role: string } | null;

/** Request-scoped context for non-IPC transports. Set by the HTTP dispatcher
 *  for the duration of one request; unset everywhere else. Carries the session
 *  and the remote device id so handlers/audit attribute to the right device. */
export const requestSession = new AsyncLocalStorage<{ session: Session; deviceId?: string }>();

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

/** The device id in effect for the current call: the remote device on the
 *  HTTP path, else the supplied host id (IPC, or HTTP requests with no device
 *  header). Lets audit attribute remote actions to the device that did them. */
export function currentDeviceId(fallback: string): string {
  return requestSession.getStore()?.deviceId ?? fallback;
}

// --- Token store (HTTP transport) ------------------------------------------
// In-memory and opaque (server-side lookup, not signed). Tokens die with the
// process, so remote clients re-login after a host restart. Two ceilings: an
// idle window (refreshed on use) and an absolute lifetime (never refreshed),
// so a captured-and-kept-alive token still expires within a day.

const TOKEN_IDLE_MS = 2 * 60 * 60 * 1000;    // 2h since last use
const TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h since issue, hard cap

type TokenEntry = {
  session: NonNullable<Session>;
  /** Remote device id the token was issued to (audit / future binding). */
  deviceId: string;
  createdAt: number;
  lastSeen: number;
};
const tokens = new Map<string, TokenEntry>();

export function mintToken(session: NonNullable<Session>, deviceId: string): string {
  const token = randomUUID();
  const now = Date.now();
  tokens.set(token, { session, deviceId, createdAt: now, lastSeen: now });
  return token;
}

/** Resolve a bearer token to its session, refreshing the idle window. Returns
 *  null for unknown or expired tokens (and reaps the expired entry). Expiry is
 *  whichever comes first: idle timeout or absolute max age. */
export function resolveToken(token?: string): Session {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.lastSeen > TOKEN_IDLE_MS || now - entry.createdAt > TOKEN_MAX_AGE_MS) {
    tokens.delete(token);
    return null;
  }
  entry.lastSeen = now;
  return entry.session;
}

export function revokeToken(token?: string): void {
  if (token) tokens.delete(token);
}
