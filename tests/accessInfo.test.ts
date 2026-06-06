// Unit test for the pure URL-building helper behind the "scan to join" QR.
// The mDNS/listen wiring around it is integration-only (needs a real socket
// and an mDNS responder), so we test the deterministic part here.

import { describe, it, expect } from 'vitest';
import { accessUrls } from '../src/main/http/server';

describe('accessUrls', () => {
  it('builds scheme://ip:port for each address', () => {
    expect(accessUrls('http', ['192.168.1.20', '10.0.0.5'], 4317)).toEqual([
      'http://192.168.1.20:4317',
      'http://10.0.0.5:4317',
    ]);
  });

  it('carries the https scheme through', () => {
    expect(accessUrls('https', ['192.168.1.20'], 4317)).toEqual([
      'https://192.168.1.20:4317',
    ]);
  });

  it('is empty when there are no reachable addresses', () => {
    expect(accessUrls('http', [], 4317)).toEqual([]);
  });
});
