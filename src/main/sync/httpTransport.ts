// HTTP transport for push sync: POST the batch to <central>/ingest with the
// shop's bearer token, parse the { ackedSeq } reply. Swappable via SyncTransport.

import http from 'node:http';
import https from 'node:https';
import type { SyncTransport, PullTransport, PushBatch, PushAck, PullResponse } from '../../shared/sync.js';

export function createHttpTransport(centralUrl: string, token: string): SyncTransport & PullTransport {
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
  };
}
