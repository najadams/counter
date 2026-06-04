// Tiny in-memory sliding-window rate limiter for the HTTP edge.
//
// The per-(worker,device) PIN lockout in verifyPin stops one account being
// hammered, but it can't see an attacker spraying one PIN across many worker
// ids from one device. A per-IP cap on the login channel blunts that, and
// throttles worker-name enumeration over the LAN.

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  /** @param max  allowed events per window
   *  @param windowMs  window length in ms */
  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Record an attempt for `key`. Returns true if allowed, false if the key
   *  is over its limit for the current window. */
  check(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent); // keep pruned list so it can decay
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop empty/expired keys so the map doesn't grow unbounded over a long
   *  uptime. Cheap to call periodically. */
  sweep(now: number = Date.now()): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
