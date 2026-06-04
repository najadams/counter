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

/** Request-scoped session for non-IPC transports. Set by the HTTP dispatcher
 *  for the duration of one request; unset everywhere else. */
export const requestSession = new AsyncLocalStorage<{ session: Session }>();

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

// --- Token store (HTTP transport) ------------------------------------------
// In-memory and opaque (server-side lookup, not signed). Tokens die with the
// process, so remote clients re-login after a host restart — acceptable for
// v1; Phase 2 hardening can add rotation and persist across restarts.

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h idle window
type TokenEntry = { session: NonNullable<Session>; lastSeen: number };
const tokens = new Map<string, TokenEntry>();

export function mintToken(session: NonNullable<Session>): string {
  const token = randomUUID();
  tokens.set(token, { session, lastSeen: Date.now() });
  return token;
}

/** Resolve a bearer token to its session, refreshing the idle window. Returns
 *  null for unknown or expired tokens (and reaps the expired entry). */
export function resolveToken(token?: string): Session {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.lastSeen > TOKEN_TTL_MS) {
    tokens.delete(token);
    return null;
  }
  entry.lastSeen = Date.now();
  return entry.session;
}

export function revokeToken(token?: string): void {
  if (token) tokens.delete(token);
}
