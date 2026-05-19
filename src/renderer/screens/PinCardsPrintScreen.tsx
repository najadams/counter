// PinCardsPrintScreen — A6/4x6 cards, one per active worker.
//
// PINs are bcrypt-hashed; we cannot recover the plaintext. Each card has a
// hand-write line for the OWNER to fill in before handing it to a cashier.
// Print via window.print(); the included CSS @page rules size for A6.
//
// Reachable from Settings → Workers → "Print PIN cards" button.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';

interface Worker {
  id: string; fullName: string; phone: string; role: string; active: boolean;
}

const F_KEYS: Array<{ k: string; t: string }> = [
  { k: 'F1',  t: 'Sale' },
  { k: 'F2',  t: 'Cash drop' },
  { k: 'F3',  t: 'Drink (consumption)' },
  { k: 'F4',  t: 'Stocktake' },
  { k: 'F5',  t: 'Daily summary' },
  { k: 'F6',  t: 'Customers / debts' },
  { k: 'F7',  t: 'Breakage (with photo)' },
  { k: 'F8',  t: 'Stock receipt' },
  { k: 'F10', t: 'Close shift' },
  { k: 'F11', t: 'Recent sales / void' },
  { k: 'F12', t: 'Settings' },
];

export function PinCardsPrintScreen({ onExit }: { onExit: () => void }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [shopName] = useState<string>('Counter');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.adminListWorkers();
      if (!r.success) { setError(r.error); return; }
      setWorkers(r.data.workers.filter((w: Worker) => w.active));
      const ping = await counter.ping('shop');
      // shopName isn't in ping; we'll fall through to the device default.
      void ping;
    })();
  }, []);

  return (
    <>
      <style>{`
        @media print {
          @page { size: A6; margin: 8mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
          .pin-card-page { break-after: page; page-break-after: always; }
          .pin-card-page:last-child { break-after: auto; page-break-after: auto; }
        }
        .pin-card-page {
          width: 105mm; height: 148mm;
          padding: 8mm;
          box-sizing: border-box;
          background: white;
          color: black;
          font-family: ui-sans-serif, system-ui, sans-serif;
          margin: 8mm auto;
          border: 1px dashed #999;
          display: flex;
          flex-direction: column;
        }
        .pin-card-page .shop {
          font-size: 11pt; color: #555; letter-spacing: 1px; text-transform: uppercase;
        }
        .pin-card-page h2 {
          font-size: 22pt; margin: 4mm 0 2mm 0; line-height: 1.0;
        }
        .pin-card-page .role {
          font-size: 10pt; color: #555; text-transform: uppercase; letter-spacing: 1px;
          margin-bottom: 4mm;
        }
        .pin-card-page .pin-line {
          margin: 2mm 0 4mm;
          font-size: 11pt;
        }
        .pin-card-page .pin-line .write { display: inline-block; border-bottom: 2px solid black; min-width: 22mm; min-height: 7mm; }
        .pin-card-page .keys { display: grid; grid-template-columns: 18mm 1fr; row-gap: 1.4mm; column-gap: 2mm; font-size: 9pt; }
        .pin-card-page .keys .k { font-weight: 700; font-family: ui-monospace, monospace; }
        .pin-card-page .footer { margin-top: auto; font-size: 8pt; color: #555; }
      `}</style>

      <div className="no-print min-h-screen bg-bg-deep text-text-primary">
        <div className="max-w-3xl mx-auto px-12 py-6 flex items-center justify-between">
          <h1 className="text-text-secondary uppercase tracking-wider text-xs">PIN cards — {workers.length} active worker(s)</h1>
          <div className="flex gap-3">
            <button onClick={() => window.print()}
              className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light text-sm">
              Print
            </button>
            <button onClick={onExit}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Close
            </button>
          </div>
        </div>
        {error && (
          <div className="max-w-3xl mx-auto px-12 mb-4 bg-red-950/30 border border-red-900/50 text-red-300 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}
        <p className="max-w-3xl mx-auto px-12 text-text-tertiary text-xs mb-6">
          PINs are stored encrypted and cannot be printed. Write each worker's PIN on the card by hand
          before handing it out. Hit Print, then close this window when done.
        </p>
      </div>

      <div className="bg-white">
        {workers.length === 0 && (
          <div className="text-center text-gray-500 p-12 no-print">No active workers to print.</div>
        )}
        {workers.map((w) => (
          <div key={w.id} className="pin-card-page">
            <div className="shop">{shopName}</div>
            <h2>{w.fullName}</h2>
            <div className="role">{w.role} · {w.phone}</div>

            <div className="pin-line">
              PIN: <span className="write">&nbsp;</span>
              <span style={{ fontSize: '9pt', color: '#777', marginLeft: '4mm' }}>
                (write your 4–6 digit PIN here)
              </span>
            </div>

            <div style={{ fontSize: '10pt', fontWeight: 700, marginBottom: '2mm' }}>Keyboard shortcuts</div>
            <div className="keys">
              {F_KEYS.map((k) => (
                <span key={k.k} style={{ display: 'contents' }}>
                  <span className="k">{k.k}</span><span>{k.t}</span>
                </span>
              ))}
            </div>

            <div className="footer">
              Forgot your PIN? Ask the supervisor to reset it. Five wrong tries locks you out for 15 minutes.
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
