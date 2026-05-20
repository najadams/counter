// CustomerStatementModal — printable statement opened from CustomerDetailScreen.
//
// On open, fetches the statement via IPC and renders a print-friendly
// layout. window.print() is invoked when the user clicks "Print" — the
// browser's print dialog will let them save as PDF or send to a printer.
//
// Print styling is in @media print rules so the modal chrome (close button,
// the modal background, etc.) is hidden when printing — only the statement
// body shows on paper.
//
// Wave C.1.

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import type { CustomerStatementResponse } from '../../shared/types/ipc';

interface Props {
  customerId: string;
  onClose: () => void;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function CustomerStatementModal({ customerId, onClose }: Props): JSX.Element {
  const [data, setData] = useState<CustomerStatementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printArea = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await counter.customerStatement(customerId);
      if (cancelled) return;
      if (!r.success) setError(r.error);
      else setData(r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  function doPrint(): void {
    window.print();
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-4 z-50 statement-overlay">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .statement-overlay,
          .statement-overlay * { visibility: visible; }
          .statement-overlay {
            position: static !important;
            background: white !important;
            padding: 0 !important;
            inset: auto !important;
          }
          .statement-modal {
            box-shadow: none !important;
            border: none !important;
            max-height: none !important;
            max-width: none !important;
            width: 100% !important;
            background: white !important;
            color: black !important;
          }
          .statement-controls { display: none !important; }
          .statement-page { padding: 0 !important; }
          .statement-page * { color: black !important; }
        }
      `}</style>
      <div className="statement-modal bg-white text-black rounded shadow-xl max-w-3xl w-full max-h-[90vh] overflow-auto">
        {error && (
          <div className="p-6 text-red-600">Failed to load statement: {error}</div>
        )}
        {!error && !data && (
          <div className="p-12 text-center text-gray-600">Loading statement…</div>
        )}
        {data && (
          <>
            <div className="statement-controls flex items-center justify-end gap-3 p-3 border-b border-gray-300 bg-gray-50">
              <button onClick={doPrint}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">
                Print
              </button>
              <button onClick={onClose}
                className="px-4 py-2 border border-gray-400 text-sm rounded hover:bg-gray-100">
                Close
              </button>
            </div>
            <div ref={printArea} className="statement-page p-10 text-sm leading-relaxed">
              {/* --- HEADER ----------------------------------------------- */}
              <div className="flex justify-between items-start border-b-2 border-black pb-4 mb-6">
                <div>
                  <div className="text-2xl font-bold tracking-wide">{data.shop.name}</div>
                  {data.shop.subtitle && (
                    <div className="text-sm text-gray-700">{data.shop.subtitle}</div>
                  )}
                  {data.shop.phone && (
                    <div className="text-sm text-gray-700 font-mono">{data.shop.phone}</div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold uppercase tracking-wider">Statement of Account</div>
                  <div className="text-sm text-gray-700">As of {fmtDate(data.asOfDate)}</div>
                </div>
              </div>

              {/* --- CUSTOMER BLOCK -------------------------------------- */}
              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Customer</div>
                  <div className="font-semibold text-base">{data.customer.displayName}</div>
                  <div className="font-mono text-sm">{data.customer.phone}</div>
                  <div className="text-xs text-gray-600">{data.customer.customerType}</div>
                  {data.customer.blocked && (
                    <div className="text-xs text-red-700 mt-1 font-semibold">
                      Account blocked: {data.customer.blockedReason ?? '(no reason)'}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Credit limit</div>
                  <div className="font-mono text-base">
                    {data.customer.creditLimitPesewas > 0
                      ? formatMoneyWithCurrency(data.customer.creditLimitPesewas)
                      : '—'}
                  </div>
                </div>
              </div>

              {/* --- AGING SUMMARY --------------------------------------- */}
              <div className="mb-6">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Aging summary</div>
                <table className="w-full border border-gray-400 text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border border-gray-400 px-3 py-2 text-left">0–30 days</th>
                      <th className="border border-gray-400 px-3 py-2 text-left">31–60 days</th>
                      <th className="border border-gray-400 px-3 py-2 text-left">61–90 days</th>
                      <th className="border border-gray-400 px-3 py-2 text-left">90+ days</th>
                      <th className="border border-gray-400 px-3 py-2 text-left">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="font-mono">
                      <td className="border border-gray-400 px-3 py-2">{formatMoneyWithCurrency(data.totals.bucket0_30)}</td>
                      <td className="border border-gray-400 px-3 py-2">{formatMoneyWithCurrency(data.totals.bucket31_60)}</td>
                      <td className="border border-gray-400 px-3 py-2">{formatMoneyWithCurrency(data.totals.bucket61_90)}</td>
                      <td className="border border-gray-400 px-3 py-2">{formatMoneyWithCurrency(data.totals.bucket90_plus)}</td>
                      <td className="border border-gray-400 px-3 py-2 font-semibold">{formatMoneyWithCurrency(data.totals.outstandingPesewas)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* --- OPEN INVOICES --------------------------------------- */}
              <div className="mb-6">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
                  Open invoices ({data.openInvoices.length})
                </div>
                {data.openInvoices.length === 0 ? (
                  <div className="text-sm text-gray-600 italic">No outstanding invoices.</div>
                ) : (
                  <table className="w-full border border-gray-400 text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="border border-gray-400 px-3 py-2 text-left">Date</th>
                        <th className="border border-gray-400 px-3 py-2 text-left">Ref</th>
                        <th className="border border-gray-400 px-3 py-2 text-right">Total</th>
                        <th className="border border-gray-400 px-3 py-2 text-right">Paid</th>
                        <th className="border border-gray-400 px-3 py-2 text-right">Outstanding</th>
                        <th className="border border-gray-400 px-3 py-2 text-right">Age</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {data.openInvoices.map((inv) => (
                        <tr key={inv.saleId}>
                          <td className="border border-gray-400 px-3 py-1">{fmtDate(inv.createdAt)}</td>
                          <td className="border border-gray-400 px-3 py-1">{inv.shortRef}</td>
                          <td className="border border-gray-400 px-3 py-1 text-right">{formatMoneyWithCurrency(inv.totalPesewas)}</td>
                          <td className="border border-gray-400 px-3 py-1 text-right">{formatMoneyWithCurrency(inv.paidPesewas)}</td>
                          <td className="border border-gray-400 px-3 py-1 text-right font-semibold">{formatMoneyWithCurrency(inv.outstandingPesewas)}</td>
                          <td className="border border-gray-400 px-3 py-1 text-right">{inv.ageDays}d</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-mono font-semibold bg-gray-100">
                        <td className="border border-gray-400 px-3 py-2" colSpan={4}>Total outstanding</td>
                        <td className="border border-gray-400 px-3 py-2 text-right">{formatMoneyWithCurrency(data.totals.outstandingPesewas)}</td>
                        <td className="border border-gray-400 px-3 py-2"></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              {/* --- RECENT PAYMENTS ------------------------------------- */}
              <div className="mb-6">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
                  Recent payments ({data.recentPayments.length})
                </div>
                {data.recentPayments.length === 0 ? (
                  <div className="text-sm text-gray-600 italic">No payments recorded in the period shown.</div>
                ) : (
                  <table className="w-full border border-gray-400 text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="border border-gray-400 px-3 py-2 text-left">Received</th>
                        <th className="border border-gray-400 px-3 py-2 text-left">Method</th>
                        <th className="border border-gray-400 px-3 py-2 text-left">Reference</th>
                        <th className="border border-gray-400 px-3 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {data.recentPayments.map((p) => (
                        <tr key={p.paymentId}>
                          <td className="border border-gray-400 px-3 py-1">{fmtDateTime(p.receivedAt)}</td>
                          <td className="border border-gray-400 px-3 py-1">{p.paymentMethod}</td>
                          <td className="border border-gray-400 px-3 py-1">{p.paymentReference ?? '—'}</td>
                          <td className="border border-gray-400 px-3 py-1 text-right">{formatMoneyWithCurrency(p.amountPesewas)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-mono font-semibold bg-gray-100">
                        <td className="border border-gray-400 px-3 py-2" colSpan={3}>Paid in period</td>
                        <td className="border border-gray-400 px-3 py-2 text-right">{formatMoneyWithCurrency(data.totals.paidThisPeriodPesewas)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              {/* --- FOOTER ---------------------------------------------- */}
              <div className="border-t-2 border-black pt-4 text-sm">
                <div className="font-semibold mb-1">
                  Please settle 31+ day balances by {fmtDate(data.pleaseSettleByDate)}.
                </div>
                {data.shop.phone && (
                  <div>
                    Questions or to arrange payment, please contact{' '}
                    <span className="font-mono">{data.shop.phone}</span>.
                  </div>
                )}
                <div className="text-xs text-gray-500 mt-3">
                  This statement was generated on {fmtDateTime(new Date().toISOString())}. Amounts in Ghanaian cedi.
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default CustomerStatementModal;
