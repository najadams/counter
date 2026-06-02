// Renderer-side IPC wrapper.
//
// The API shape is derived from shared/counterApi.ts (the single source of
// truth shared with preload and the Phase 1 HTTP client). This module only
// adds the renderer-only concerns: a not-in-Electron stub and a humanizing
// pass over error strings before they reach the till UI.

import { IPC_CHANNELS, type IpcResponse } from '../../shared/types/ipc';
import type { CounterApi } from '../../shared/counterApi';

declare global {
  interface Window { counter: CounterApi }
}

if (typeof window !== 'undefined' && !window.counter) {
  const stub: IpcResponse<unknown> = { success: false, error: 'IPC bridge not initialized (not in Electron)' };
  const stubFn = () => Promise.resolve(stub);
  (window as unknown as { counter: unknown }).counter = new Proxy({}, { get: () => stubFn });
}

// --- Friendly error translation ------------------------------------------
//
// Wrap the raw counter API so that error strings get a humanizing pass
// before they reach UI components. Operators (cashiers, supervisors) read
// these on the till — translate developer-speak to plain English.

interface ErrorPattern {
  match: RegExp;
  replace: (m: RegExpMatchArray) => string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  { match: /^FOREIGN KEY constraint failed/i,
    replace: () => "That action references a record that doesn't exist or has been removed. Refresh and try again." },
  { match: /^UNIQUE constraint failed:\s*(\w+\.\w+)/i,
    replace: (m) => `A record with that ${m[1]?.split('.')[1] || 'value'} already exists. Pick a different value.` },
  { match: /^CHECK constraint failed:\s*(.+)/i,
    replace: (m) => `That value isn't allowed (${m[1]?.trim() ?? 'invalid'}). Check the input and try again.` },
  { match: /^NOT NULL constraint failed:\s*(\w+\.\w+)/i,
    replace: (m) => `Missing a required field (${m[1]?.split('.')[1] ?? 'unknown'}). Fill it in and try again.` },
  { match: /^Not authenticated/i,
    replace: () => 'You are signed out. Sign in again to continue.' },
  { match: /No open shift/i,
    replace: () => 'No shift is open. Open a shift before doing this.' },
  { match: /^Supervisor PIN check failed/i,
    replace: () => 'That supervisor PIN is wrong. Try again, or get a different supervisor.' },
  { match: /Locked out until\s+(.+)/i,
    replace: (m) => `Account locked until ${m[1]}. Wait or have an OWNER reset the PIN.` },
  { match: /^EBUSY|database is locked/i,
    replace: () => 'The database is busy. Wait a second and try again.' },
  { match: /^ENOSPC|disk.*full/i,
    replace: () => 'The disk is full. Tell the owner — backups may need to be cleared.' },
  { match: /printer.*offline|OFFLINE/i,
    replace: () => 'Receipt printer is offline. The sale was saved; the receipt will be queued for reprint.' },
  { match: /^path '.*' escapes/i,
    replace: () => 'Could not load that file (security check failed).' },
];

export function humanizeError(err: string): string {
  for (const p of ERROR_PATTERNS) {
    const m = err.match(p.match);
    if (m) return p.replace(m);
  }
  return err;
}

const _rawCounter = (typeof window !== 'undefined' ? window.counter : ({} as Window['counter']));

/** counter — humanizing wrapper. Calls the underlying IPC, then if the
 *  response is { success: false, error }, runs `humanizeError` on the
 *  error string before returning. Successful responses pass through.
 *
 *  Implemented as an explicit object-rebuild rather than a Proxy because
 *  contextBridge exposes methods as non-configurable, read-only data
 *  properties — Proxy `get` invariants forbid returning a different value
 *  than the target stores on such properties, which threw at boot.
 */
function buildHumanizingCounter(raw: Window['counter']): Window['counter'] {
  const out: Record<string, unknown> = {};
  // Walk the prototype chain too — contextBridge exposes methods on the
  // object itself, but defensive iteration costs nothing.
  const seen = new Set<string>();
  for (const key of Object.keys(raw as object)) seen.add(key);
  for (const key of seen) {
    const value = (raw as unknown as Record<string, unknown>)[key];
    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => Promise<IpcResponse<unknown>>;
    out[key] = async (...args: unknown[]) => {
      const res = await fn.apply(raw, args);
      if (res && res.success === false && typeof res.error === 'string') {
        return { success: false, error: humanizeError(res.error) };
      }
      return res;
    };
  }
  return out as unknown as Window['counter'];
}

export const counter: Window['counter'] = (typeof window !== 'undefined' && window.counter)
  ? buildHumanizingCounter(_rawCounter)
  : _rawCounter;

export { IPC_CHANNELS };
