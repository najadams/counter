// Session resolution: desktop global vs request-scoped (HTTP) precedence,
// and the bearer-token store the HTTP transport dispatches against.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  currentSession, setGlobalSession, requestSession,
  mintToken, resolveToken, revokeToken,
} from '../src/main/ipc/session';

const alice = { workerId: 'w-alice', fullName: 'Alice', role: 'OWNER' };
const bob = { workerId: 'w-bob', fullName: 'Bob', role: 'CASHIER' };

beforeEach(() => { setGlobalSession(null); });

describe('currentSession precedence', () => {
  it('defaults to null with no global and no request scope', () => {
    expect(currentSession()).toBeNull();
  });

  it('returns the desktop global when set (IPC path)', () => {
    setGlobalSession(alice);
    expect(currentSession()).toEqual(alice);
  });

  it('request scope wins over the global (HTTP path)', () => {
    setGlobalSession(alice);
    requestSession.run({ session: bob }, () => {
      expect(currentSession()).toEqual(bob);
    });
    // Outside the scope, the global is untouched.
    expect(currentSession()).toEqual(alice);
  });

  it('a null request scope is still a scope — it shadows the global', () => {
    setGlobalSession(alice);
    requestSession.run({ session: null }, () => {
      expect(currentSession()).toBeNull();
    });
  });

  it('concurrent request scopes do not leak into each other', async () => {
    setGlobalSession(null);
    await Promise.all([
      requestSession.run({ session: alice }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        expect(currentSession()).toEqual(alice);
      }),
      requestSession.run({ session: bob }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        expect(currentSession()).toEqual(bob);
      }),
    ]);
  });
});

describe('token store', () => {
  it('mints an opaque token that resolves back to its session', () => {
    const token = mintToken(alice, 'dev-a');
    expect(typeof token).toBe('string');
    expect(resolveToken(token)).toEqual(alice);
  });

  it('returns null for unknown or missing tokens', () => {
    expect(resolveToken('nope')).toBeNull();
    expect(resolveToken(undefined)).toBeNull();
  });

  it('revokes a token (logout)', () => {
    const token = mintToken(bob, 'dev-b');
    revokeToken(token);
    expect(resolveToken(token)).toBeNull();
  });

  it('issues distinct tokens per login', () => {
    expect(mintToken(alice, 'dev-a')).not.toBe(mintToken(alice, 'dev-a'));
  });
});

describe('token expiry', () => {
  const HOUR = 60 * 60 * 1000;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('expires after the idle window with no use', () => {
    const token = mintToken(alice, 'dev-a');
    vi.setSystemTime(2 * HOUR + 1); // past idle, untouched
    expect(resolveToken(token)).toBeNull();
  });

  it('stays alive while used within the idle window', () => {
    const token = mintToken(alice, 'dev-a');
    vi.setSystemTime(1 * HOUR);
    expect(resolveToken(token)).toEqual(alice); // refreshes idle
    vi.setSystemTime(2.5 * HOUR);               // 1.5h since last use < 2h
    expect(resolveToken(token)).toEqual(alice);
  });

  it('expires at the absolute max age even when kept active', () => {
    const token = mintToken(alice, 'dev-a');
    // Touch every hour so the idle window never trips...
    for (let h = 1; h <= 11; h++) {
      vi.setSystemTime(h * HOUR);
      expect(resolveToken(token)).toEqual(alice);
    }
    // ...but the 12h hard cap still kills it.
    vi.setSystemTime(12 * HOUR + 1);
    expect(resolveToken(token)).toBeNull();
  });
});
