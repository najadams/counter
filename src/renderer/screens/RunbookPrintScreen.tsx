// RunbookPrintScreen — printable worker handbook in plain English.
// One double-sided A4 ideally; cashier reference behind the till.

export function RunbookPrintScreen({ onExit }: { onExit: () => void }) {
  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
        }
        .runbook {
          background: white;
          color: black;
          font-family: ui-sans-serif, system-ui, sans-serif;
          font-size: 11pt;
          line-height: 1.45;
          max-width: 180mm;
          margin: 14mm auto;
          padding: 0 8mm;
        }
        .runbook h1 { font-size: 20pt; margin: 0 0 2mm; }
        .runbook h2 { font-size: 13pt; margin: 6mm 0 2mm; border-bottom: 2px solid #000; padding-bottom: 1mm; }
        .runbook h3 { font-size: 11pt; margin: 4mm 0 1mm; font-weight: 700; }
        .runbook p { margin: 0 0 2mm; }
        .runbook ol, .runbook ul { margin: 0 0 3mm 6mm; padding: 0; }
        .runbook li { margin-bottom: 1mm; }
        .runbook .kbd {
          font-family: ui-monospace, monospace; font-weight: 700;
          padding: 0 1mm; border: 1px solid #999; border-radius: 1mm; background: #f5f5f5;
        }
        .runbook .keys-grid {
          display: grid; grid-template-columns: 14mm 1fr 14mm 1fr;
          row-gap: 1mm; column-gap: 4mm; font-size: 10pt; margin: 2mm 0 4mm;
        }
        .runbook .grid-pair { display: contents; }
        .runbook .callout {
          border-left: 3px solid #000; padding: 2mm 3mm; margin: 2mm 0;
          background: #f5f5f5; font-size: 10pt;
        }
        .runbook .footer { margin-top: 6mm; font-size: 9pt; color: #555; border-top: 1px solid #ccc; padding-top: 2mm; }
      `}</style>

      <div className="no-print min-h-screen bg-bg-deep text-text-primary">
        <div className="max-w-3xl mx-auto px-12 py-6 flex items-center justify-between">
          <h1 className="text-text-secondary uppercase tracking-wider text-xs">Worker handbook — printable</h1>
          <div className="flex gap-3">
            <button onClick={() => window.print()}
              className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light text-sm">
              Print
            </button>
            <button onClick={onExit}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Close
            </button>
          </div>
        </div>
      </div>

      <div className="runbook">
        <h1>Counter — Cashier Handbook</h1>
        <p style={{ color: '#555' }}>Quick reference for the till. Keep this behind the counter.</p>

        <h2>Keyboard shortcuts</h2>
        <div className="keys-grid">
          <span className="grid-pair"><span className="kbd">F1</span><span>Sell to a customer</span><span className="kbd">F7</span><span>Report breakage (with photo)</span></span>
          <span className="grid-pair"><span className="kbd">F2</span><span>Hand cash to owner / safe</span><span className="kbd">F8</span><span>Receive stock from supplier</span></span>
          <span className="grid-pair"><span className="kbd">F3</span><span>Log a drink you took</span><span className="kbd">F10</span><span>Close shift (cash count)</span></span>
          <span className="grid-pair"><span className="kbd">F4</span><span>Stocktake (count physical stock)</span><span className="kbd">F11</span><span>See recent sales / void one</span></span>
          <span className="grid-pair"><span className="kbd">F5</span><span>Daily summary report</span><span className="kbd">F12</span><span>Settings (admin only)</span></span>
          <span className="grid-pair"><span className="kbd">F6</span><span>Customers — debts and payments</span><span className="kbd">Esc</span><span>Cancel / go back</span></span>
        </div>

        <h2>Starting your shift</h2>
        <ol>
          <li>Pick your name from the list and enter your PIN.</li>
          <li>Count the cash in the drawer. Type that number into the opening cash field.</li>
          <li>If the system rejects your PIN five times, you are locked out for 15 minutes. Ask the supervisor for help.</li>
        </ol>

        <h2>Recording a sale</h2>
        <ol>
          <li>Press <span className="kbd">F1</span> to open the sale screen.</li>
          <li>Type part of the product name (e.g. "star") to search. Press Enter on the highlighted result to add it.</li>
          <li>Set the quantity. Use the unit picker if selling by case/pack.</li>
          <li>Add more items the same way.</li>
          <li>Press the payment button. Pick CASH, MOMO, or CREDIT.
            <ul>
              <li>CASH: type how much the customer gave you. The screen shows the change.</li>
              <li>MOMO: type the reference number from the SMS.</li>
              <li>CREDIT: pick the customer. They must already exist or be added in this flow.</li>
            </ul>
          </li>
          <li>Wait for the receipt to print. If it fails, the supervisor can reprint later from Settings.</li>
        </ol>

        <h2>Reporting breakage</h2>
        <p>Every breakage needs a photo. No photo, no entry — by design.</p>
        <ol>
          <li>Press <span className="kbd">F7</span>.</li>
          <li>Pick the broken product and the quantity.</li>
          <li>Select the cause (dropped, customer accident, expired, etc.).</li>
          <li>Take or attach the photo.</li>
          <li>Submit. The supervisor's PIN is required to confirm.</li>
        </ol>

        <h2>Closing your shift</h2>
        <p>Two-step blind cash count. Don't peek at the expected total before counting.</p>
        <ol>
          <li>Press <span className="kbd">F10</span>.</li>
          <li>Count the drawer. Type the counted amount.</li>
          <li>The screen shows the variance. If it is large, the supervisor will ask why.</li>
          <li>Confirm to close.</li>
        </ol>

        <h2>When something breaks</h2>
        <h3>Receipt printer is silent</h3>
        <ul>
          <li>Finish the sale anyway — the system records it.</li>
          <li>Tell the supervisor; reprints are queued under Settings → Reprint queue.</li>
        </ul>
        <h3>I'm locked out</h3>
        <ul>
          <li>Wait 15 minutes, OR ask the OWNER / FOUNDER to reset your PIN.</li>
        </ul>
        <h3>I made a mistake on a sale</h3>
        <ul>
          <li>Press <span className="kbd">F11</span>, find the sale, void it. A supervisor PIN is needed.</li>
          <li>Then re-do the sale correctly.</li>
        </ul>
        <h3>A customer has no money but wants the goods</h3>
        <ul>
          <li>Only add to credit if the customer is already on file and not blocked.</li>
          <li>Their balance shows on the customer screen (<span className="kbd">F6</span>). Don't sell on credit if they are over their limit.</li>
        </ul>

        <div className="callout">
          <strong>Honesty rules.</strong> The system records every sale, void, drink, and breakage with your name on it.
          Do not try to delete or hide entries — the audit log keeps the original. If you make an honest mistake,
          tell the supervisor immediately. Mistakes are fixable; cover-ups are not.
        </div>

        <div className="footer">
          Counter v0.1 · keep this card visible at the till · ask the owner if you have questions.
        </div>
      </div>
    </>
  );
}
