// Session resolution: desktop global vs request-scoped (HTTP) precedence,
// and the bearer-token store the HTTP transport dispatches against.

import { describe, expect, it, beforeEach } from 'vitest';
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
    const token = mintToken(alice);
    expect(typeof token).toBe('string');
    expect(resolveToken(token)).toEqual(alice);
  });

  it('returns null for unknown or missing tokens', () => {
    expect(resolveToken('nope')).toBeNull();
    expect(resolveToken(undefined)).toBeNull();
  });

  it('revokes a token (logout)', () => {
    const token = mintToken(bob);
    revokeToken(token);
    expect(resolveToken(token)).toBeNull();
  });

  it('issues distinct tokens per login', () => {
    expect(mintToken(alice)).not.toBe(mintToken(alice));
  });
});
