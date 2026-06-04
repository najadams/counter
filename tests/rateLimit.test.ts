// SlidingWindowLimiter: the per-IP login throttle at the HTTP edge.

import { describe, it, expect } from 'vitest';
import { SlidingWindowLimiter } from '../src/main/http/rateLimit';

describe('SlidingWindowLimiter', () => {
  it('allows up to max within the window, then blocks', () => {
    const lim = new SlidingWindowLimiter(3, 1000);
    expect(lim.check('ip', 0)).toBe(true);
    expect(lim.check('ip', 10)).toBe(true);
    expect(lim.check('ip', 20)).toBe(true);
    expect(lim.check('ip', 30)).toBe(false); // 4th in-window
  });

  it('tracks keys independently', () => {
    const lim = new SlidingWindowLimiter(1, 1000);
    expect(lim.check('a', 0)).toBe(true);
    expect(lim.check('b', 0)).toBe(true); // different key, own budget
    expect(lim.check('a', 1)).toBe(false);
  });

  it('decays as the window slides forward', () => {
    const lim = new SlidingWindowLimiter(2, 1000);
    expect(lim.check('ip', 0)).toBe(true);
    expect(lim.check('ip', 0)).toBe(true);
    expect(lim.check('ip', 500)).toBe(false);   // still within window
    expect(lim.check('ip', 1001)).toBe(true);    // first hit aged out
  });

  it('sweep drops fully-decayed keys', () => {
    const lim = new SlidingWindowLimiter(1, 1000);
    lim.check('ip', 0);
    lim.sweep(2000);
    // After sweep the key is gone, so a fresh attempt is allowed.
    expect(lim.check('ip', 2001)).toBe(true);
  });
});
