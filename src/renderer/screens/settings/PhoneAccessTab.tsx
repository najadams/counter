// PhoneAccessTab: one toggle to start/stop the LAN server so phones can open the
// till in a browser. Shows the QR + URL when on. Replaces the COUNTER_HTTP env
// var / .bat dance for the operator.

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { counter } from '../../lib/ipc';
import type { HttpStatusResponse } from '../../../shared/types/ipc';

export function PhoneAccessTab() {
  const [status, setStatus] = useState<HttpStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await counter.httpStatus();
    if (r.success) setStatus(r.data);
  }
  useEffect(() => { void refresh(); }, []);

  async function toggle(enabled: boolean) {
    setBusy(true); setError(null);
    const r = await counter.setHttp(enabled, true);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setStatus(r.data);
  }

  const on = status?.enabled ?? false;
  const access = status?.access ?? null;
  const url = access?.urls?.[0] ?? null;

  return (
    <div className="flex flex-col gap-5 max-w-xl">
      <div>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-1">Phone access (LAN)</h2>
        <p className="text-text-secondary text-sm">
          Let phones and tablets on the same wi-fi open the till in a browser — no app to install.
          This PC stays the server: it holds the one database and the receipt printer.
        </p>
      </div>

      {!on ? (
        <button
          onClick={() => void toggle(true)}
          disabled={busy}
          className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 self-start">
          {busy ? 'Starting…' : 'Enable phone access'}
        </button>
      ) : (
        <>
          <div className="flex gap-4 items-start border border-border p-4">
            {url && <div className="bg-white p-2 rounded"><QRCodeSVG value={url} size={120} /></div>}
            <div className="flex flex-col gap-1 text-sm min-w-0">
              <span className="text-success">● On</span>
              {url ? (
                <>
                  <span className="text-text-tertiary">Scan the code, or open on the phone:</span>
                  <span className="font-mono break-all text-text-primary">{url}</span>
                  {access?.mdnsUrl && (
                    <span className="font-mono break-all text-text-tertiary">{access.mdnsUrl}</span>
                  )}
                </>
              ) : (
                <span className="text-text-tertiary">
                  Listening, but no LAN address yet — this PC may not be on wi-fi/ethernet.
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => void toggle(false)}
            disabled={busy}
            className="border border-border px-5 py-2 text-text-primary hover:bg-bg-elevated disabled:opacity-40 self-start">
            {busy ? 'Stopping…' : 'Disable'}
          </button>
        </>
      )}

      {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

      <div className="text-text-tertiary text-xs border-t border-border pt-3 flex flex-col gap-2">
        <p><span className="text-text-secondary">First time only:</span> Windows (or macOS) will ask to
          "Allow Counter to accept incoming network connections" — click <span className="text-text-secondary">Allow</span>.
          The app can't click that for you; it appears once per PC.</p>
        <p><span className="text-text-secondary">Same network:</span> the phone must be on the same wi-fi as this PC.</p>
        <p><span className="text-text-secondary">Security:</span> use a trusted private network. Without TLS, PINs travel
          unencrypted over wi-fi (supply COUNTER_HTTPS_KEY/CERT to encrypt).</p>
      </div>
    </div>
  );
}
