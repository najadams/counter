// HTTP transport for push sync: POST the batch to <central>/ingest with the
// shop's bearer token, parse the { ackedSeq } reply. Swappable via SyncTransport.

import http from 'node:http';
import https from 'node:https';
import type {
  SyncTransport, PullTransport, PushBatch, PushAck, PullResponse,
  OrdersPullTransport, OrdersPullResponse,
} from '../../shared/sync.js';

export function createHttpTransport(
  centralUrl: string, token: string,
): SyncTransport & PullTransport & OrdersPullTransport {
  // Append endpoints RELATIVE to the central base so a base path is honoured
  // (Supabase serves functions under /functions/v1/, e.g. central_url
  // https://<project>.supabase.co/functions/v1/ → .../functions/v1/ingest).
  // A leading-slash path would strip the base. Normalise a trailing slash so
  // `new URL('ingest', base)` resolves correctly; a root host still works.
  const base = centralUrl.endsWith('/') ? centralUrl : `${centralUrl}/`;
  return {
    send(batch: PushBatch): Promise<PushAck> {
      return new Promise<PushAck>((resolve, reject) => {
        const url = new URL('ingest', base);
        const client = url.protocol === 'https:' ? https : http;
        const body = Buffer.from(JSON.stringify(batch), 'utf8');
        const req = client.request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            authorization: `Bearer ${token}`,
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`central ingest HTTP ${status}`));
              return;
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PushAck;
              if (typeof parsed.ackedSeq !== 'number') { reject(new Error('central ingest: malformed ack')); return; }
              resolve(parsed);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });
        req.on('error', reject);
        req.end(body);
      });
    },

    fetchCatalog(since: number, limit = 500): Promise<PullResponse> {
      return new Promise<PullResponse>((resolve, reject) => {
        const url = new URL('catalog', base);
        url.searchParams.set('since', String(since));
        url.searchParams.set('limit', String(limit));
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) { reject(new Error(`central catalog HTTP ${status}`)); return; }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PullResponse;
              if (!Array.isArray(parsed.rows) || typeof parsed.cursor !== 'number') {
                reject(new Error('central catalog: malformed response')); return;
              }
              resolve(parsed);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    },

    fetchOrders(since: number, limit = 200): Promise<OrdersPullResponse> {
      return new Promise<OrdersPullResponse>((resolve, reject) => {
        const url = new URL('orders-feed', base);
        url.searchParams.set('since', String(since));
        url.searchParams.set('limit', String(limit));
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) { reject(new Error(`central orders-feed HTTP ${status}`)); return; }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OrdersPullResponse;
              if (!Array.isArray(parsed.rows) || typeof parsed.cursor !== 'number') {
                reject(new Error('central orders-feed: malformed response')); return;
              }
              resolve(parsed);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    },
  };
}

export interface AddShopResult { shopId: string; role: 'SHOP'; token: string }

/** POST <central>/add-shop with THIS shop's own bearer token, asking the
 *  central store to mint a sibling shop under the SAME company — self-service
 *  branch onboarding (Settings -> Sync -> "Add a new branch"; see
 *  supabase/functions/add-shop). Standalone rather than part of SyncTransport
 *  since it's a one-off provisioning call, not part of the recurring
 *  push/pull contract. Always comes back role SHOP (see that function's
 *  header comment for why). */
export function addShopToCentral(
  centralUrl: string, token: string, newShopId: string,
): Promise<AddShopResult> {
  const base = centralUrl.endsWith('/') ? centralUrl : `${centralUrl}/`;
  return new Promise((resolve, reject) => {
    const url = new URL('add-shop', base);
    const client = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify({ shopId: newShopId }), 'utf8');
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        authorization: `Bearer ${token}`,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        let parsed: { error?: string; shopId?: string; role?: string; token?: string };
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new Error(parsed.error ?? `central add-shop HTTP ${status}`));
          return;
        }
        if (typeof parsed.shopId !== 'string' || typeof parsed.token !== 'string') {
          reject(new Error('central add-shop: malformed response'));
          return;
        }
        resolve({ shopId: parsed.shopId, role: 'SHOP', token: parsed.token });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
