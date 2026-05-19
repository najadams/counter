// ReceiptPrintModal — clean, readable receipt preview with a Print button
// that opens the OS print dialog via window.print().
//
// Why this exists: on-counter PCs without a configured thermal printer can
// still hand the customer a receipt by printing to any installed printer
// (or "Save as PDF"). This is the manual escape hatch when the auto-print
// path in completeSale falls back to console (dev) or fails.
//
// The on-screen layout is intentionally simple: a clear shop header, a small
// meta block (date / cashier / customer), an item table with right-aligned
// money, totals, and the payment summary. @media print rules carry the same
// layout to paper with black text on white.

import { useEffect, useRef } from 'react';
import { type SaleReceipt } from '../../shared/lib/receipt';
import { formatMoneyWithCurrency } from '../../shared/lib/money';

interface Props {
  receipt: SaleReceipt;
  onClose: () => void;
  /** Optional: when viewing a past sale (e.g. from the customer-debt page),
   *  pass the outstanding balance so the receipt makes the credit status
   *  obvious. Omit for a freshly-completed sale. */
  amountPaidPesewas?: number | null;
  amountOutstandingPesewas?: number | null;
}

function paymentLabel(method: string): string {
  switch (method) {
    case 'CASH': return 'Cash';
    case 'MOMO_MTN': return 'MTN MoMo';
    case 'MOMO_VODAFONE': return 'Telecel Cash';
    case 'MOMO_AIRTELTIGO': return 'AirtelTigo';
    case 'BANK_TRANSFER': return 'Bank transfer';
    case 'CREDIT': return 'On account';
    default: return method;
  }
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function ReceiptPrintModal({ receipt, onClose, amountPaidPesewas, amountOutstandingPesewas }: Props): JSX.Element {
  function doPrint(): void {
    window.print();
  }

  const printBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the Print button on mount so the primary action is one Enter away.
    printBtnRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'F8') { e.preventDefault(); doPrint(); return; }
      // Trap Tab inside the modal — without this, Tab leaks to the background
      // and a keyboard-only operator loses context.
      if (e.key === 'Tab') {
        const first = printBtnRef.current;
        const last = closeBtnRef.current;
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tenders = receipt.payments && receipt.payments.length > 0
    ? receipt.payments
    : [{
        method: receipt.payment.method,
        amountPesewas: receipt.totalPesewas,
        reference: receipt.payment.reference ?? null,
        cashGivenPesewas: receipt.payment.cashGivenPesewas ?? null,
        changePesewas: receipt.payment.changePesewas ?? null,
      }];

  const totalCashGiven = tenders.reduce(
    (sum, t) => sum + (t.method === 'CASH' && t.cashGivenPesewas != null ? t.cashGivenPesewas : 0),
    0,
  );
  const totalChange = tenders.reduce(
    (sum, t) => sum + (t.method === 'CASH' && t.cashGivenPesewas != null
      ? Math.max(0, t.cashGivenPesewas - t.amountPesewas)
      : 0),
    0,
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[70] receipt-print-overlay" onClick={onClose}>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .receipt-print-overlay,
          .receipt-print-overlay * { visibility: visible; }
          .receipt-print-overlay {
            position: static !important;
            background: white !important;
            padding: 0 !important;
            inset: auto !important;
            display: block !important;
          }
          .receipt-print-card {
            box-shadow: none !important;
            border: none !important;
            max-height: none !important;
            max-width: none !important;
            width: auto !important;
            background: white !important;
            color: black !important;
            overflow: visible !important;
          }
          .receipt-print-controls { display: none !important; }
          .receipt-print-body { padding: 0 !important; }
          .receipt-print-body * { color: black !important; }
          @page { margin: 12mm; }
        }
      `}</style>
      <div
        className="receipt-print-card bg-white text-gray-900 rounded-lg shadow-2xl max-w-md w-full max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar (hidden on print) */}
        <div className="receipt-print-controls flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 bg-gray-50 sticky top-0">
          <span className="text-xs uppercase tracking-wider text-gray-500">
            Receipt #{receipt.receiptId.slice(-8)}
          </span>
          <div className="flex gap-2">
            <button
              ref={printBtnRef}
              onClick={doPrint}
              className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
            >
              Print
            </button>
            <button
              ref={closeBtnRef}
              onClick={onClose}
              className="px-4 py-1.5 border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-100"
            >
              Close
            </button>
          </div>
        </div>

        {/* Receipt body */}
        <div className="receipt-print-body px-6 py-6 text-gray-900">
          {/* Shop header */}
          <div className="text-center mb-5">
            <h1 className="text-xl font-bold tracking-wide">{receipt.shopName}</h1>
            {receipt.shopSubtitle && (
              <div className="text-sm text-gray-600 mt-0.5">{receipt.shopSubtitle}</div>
            )}
          </div>

          {/* Meta block */}
          <div className="text-sm space-y-1 mb-5 border-t border-b border-gray-200 py-3">
            <div className="flex justify-between">
              <span className="text-gray-500">Date</span>
              <span>{fmtDateTime(receipt.saleAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Receipt</span>
              <span className="font-mono">#{receipt.receiptId.slice(-8)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Cashier</span>
              <span>{receipt.workerName}</span>
            </div>
            {receipt.channel !== 'WALK_IN' && (
              <div className="flex justify-between">
                <span className="text-gray-500">Channel</span>
                <span>{receipt.channel.replace('_', ' ').toLowerCase()}</span>
              </div>
            )}
            {receipt.customerName && (
              <div className="flex justify-between">
                <span className="text-gray-500">Customer</span>
                <span>{receipt.customerName}</span>
              </div>
            )}
          </div>

          {/* Items */}
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left font-medium pb-2 w-10">Qty</th>
                <th className="text-left font-medium pb-2">Item</th>
                <th className="text-right font-medium pb-2">Amount</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line, i) => (
                <tr key={i} className="align-top">
                  <td className="py-1.5 font-mono tabular-nums">{line.quantity}</td>
                  <td className="py-1.5 pr-2">
                    <div>{line.name}</div>
                    {line.quantity > 1 && (
                      <div className="text-xs text-gray-500">
                        @ {formatMoneyWithCurrency(line.unitPricePesewas)}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                    {formatMoneyWithCurrency(line.lineTotalPesewas)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="border-t border-gray-300 pt-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-600">Subtotal</span>
              <span className="font-mono tabular-nums">{formatMoneyWithCurrency(receipt.subtotalPesewas)}</span>
            </div>
            {receipt.discountPesewas > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-600">Discount</span>
                <span className="font-mono tabular-nums">−{formatMoneyWithCurrency(receipt.discountPesewas)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold pt-1 border-t border-gray-300 mt-1">
              <span>Total</span>
              <span className="font-mono tabular-nums">{formatMoneyWithCurrency(receipt.totalPesewas)}</span>
            </div>
          </div>

          {/* Payment block */}
          <div className="mt-5 pt-4 border-t border-gray-200 text-sm">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Payment</div>
            <div className="space-y-1">
              {tenders.map((t, i) => (
                <div key={i} className="flex justify-between">
                  <span>
                    {paymentLabel(t.method)}
                    {t.reference && (
                      <span className="text-gray-500 text-xs ml-1.5">· {t.reference}</span>
                    )}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatMoneyWithCurrency(t.amountPesewas)}
                  </span>
                </div>
              ))}
              {totalCashGiven > 0 && (
                <>
                  <div className="flex justify-between text-gray-600 pt-1">
                    <span>Cash given</span>
                    <span className="font-mono tabular-nums">{formatMoneyWithCurrency(totalCashGiven)}</span>
                  </div>
                  {totalChange > 0 && (
                    <div className="flex justify-between font-medium">
                      <span>Change</span>
                      <span className="font-mono tabular-nums">{formatMoneyWithCurrency(totalChange)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Credit status (only shown when reviewing a past sale) */}
          {amountOutstandingPesewas != null && (
            <div className="mt-5 pt-4 border-t border-gray-200 text-sm">
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Credit status</div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-600">Paid</span>
                  <span className="font-mono tabular-nums">
                    {formatMoneyWithCurrency(amountPaidPesewas ?? 0)}
                  </span>
                </div>
                <div className={`flex justify-between font-medium ${amountOutstandingPesewas > 0 ? 'text-red-700' : 'text-green-700'}`}>
                  <span>Outstanding</span>
                  <span className="font-mono tabular-nums">
                    {formatMoneyWithCurrency(amountOutstandingPesewas)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="mt-6 pt-4 border-t border-gray-200 text-center text-xs text-gray-500">
            Thank you. Come again.
          </div>
        </div>
      </div>
    </div>
  );
}
