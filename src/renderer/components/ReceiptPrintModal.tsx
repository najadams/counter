// ReceiptPrintModal — on-screen receipt preview with a Print button that
// opens the OS print dialog via window.print().
//
// The shape is configurable via ReceiptConfig (paper width, side margin,
// density, font weight, header/footer text, visibility toggles). The print
// CSS uses `@page { size: <width>mm auto; margin: 0 }` so the OS treats the
// output as a continuous roll — no page break in the middle of the
// receipt, no fixed page margins eating paper.
//
// ReceiptBody is the pure renderer; the AppearanceTab preview reuses it.

import { useEffect, useRef, useState } from 'react';
import { type SaleReceipt } from '../../shared/lib/receipt';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import { counter } from '../lib/ipc';
import type { ReceiptConfigResponse } from '../../shared/types/ipc';

const FALLBACK_CONFIG: ReceiptConfigResponse = {
  shopName: 'COUNTER SHOP',
  shopSubtitle: null,
  headerLine3: null,
  headerLine4: null,
  footerText: 'Thank you. Come again.',
  paperWidthMm: 80,
  sideMarginMm: 2,
  density: 'normal',
  bold: true,
  showCashier: true,
  showChannel: true,
  showCustomer: true,
};

interface Props {
  receipt: SaleReceipt;
  onClose: () => void;
  amountPaidPesewas?: number | null;
  amountOutstandingPesewas?: number | null;
  /** Optional override — when omitted, fetches via IPC on mount. */
  config?: ReceiptConfigResponse;
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

interface DensityTokens {
  rowGap: string;       // gap between meta rows
  sectionGap: string;   // margin between sections
  itemRow: string;      // padding between item rows
  headerGap: string;    // gap below the shop header
  lineHeight: string;
}

function densityTokens(d: ReceiptConfigResponse['density']): DensityTokens {
  switch (d) {
    case 'compact':
      return { rowGap: '1px', sectionGap: '4px', itemRow: '1px', headerGap: '4px', lineHeight: '1.15' };
    case 'spacious':
      return { rowGap: '5px', sectionGap: '14px', itemRow: '5px', headerGap: '12px', lineHeight: '1.45' };
    case 'normal':
    default:
      return { rowGap: '3px', sectionGap: '8px', itemRow: '3px', headerGap: '8px', lineHeight: '1.3' };
  }
}

/** Receipt content — used inside the modal and inside the AppearanceTab preview. */
export function ReceiptBody({
  receipt, config, amountPaidPesewas, amountOutstandingPesewas,
}: {
  receipt: SaleReceipt;
  config: ReceiptConfigResponse;
  amountPaidPesewas?: number | null;
  amountOutstandingPesewas?: number | null;
}): JSX.Element {
  const tokens = densityTokens(config.density);
  const baseWeight = config.bold ? 700 : 500;
  const strongWeight = config.bold ? 800 : 700;

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
    <div
      className="receipt-print-body text-black"
      style={{
        padding: `${tokens.sectionGap} ${config.sideMarginMm}mm`,
        fontFamily: '"Helvetica Neue", Arial, sans-serif',
        fontWeight: baseWeight,
        fontSize: '12pt',
        lineHeight: tokens.lineHeight,
      }}
    >
      {/* Shop header */}
      <div style={{ textAlign: 'center', marginBottom: tokens.headerGap }}>
        <div style={{ fontSize: '15pt', fontWeight: 900, letterSpacing: '0.5px' }}>
          {config.shopName || receipt.shopName}
        </div>
        {(config.shopSubtitle ?? receipt.shopSubtitle) && (
          <div style={{ fontWeight: baseWeight }}>{config.shopSubtitle ?? receipt.shopSubtitle}</div>
        )}
        {config.headerLine3 && <div style={{ fontWeight: baseWeight }}>{config.headerLine3}</div>}
        {config.headerLine4 && <div style={{ fontWeight: baseWeight }}>{config.headerLine4}</div>}
      </div>

      <Hr />

      {/* Meta block */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.rowGap, marginTop: tokens.rowGap, marginBottom: tokens.sectionGap }}>
        <Row left="Date" right={fmtDateTime(receipt.saleAt)} weight={baseWeight} />
        <Row left="Receipt" right={`#${receipt.receiptId.slice(-8)}`} weight={baseWeight} mono />
        {config.showCashier && <Row left="Cashier" right={receipt.workerName} weight={baseWeight} />}
        {config.showChannel && receipt.channel !== 'WALK_IN' && (
          <Row left="Channel" right={receipt.channel.replace('_', ' ').toLowerCase()} weight={baseWeight} />
        )}
        {config.showCustomer && receipt.customerName && (
          <Row left="Customer" right={receipt.customerName} weight={baseWeight} />
        )}
      </div>

      <Hr />

      {/* Items — no column header to save space; price-per-unit shown inline */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: tokens.rowGap, marginBottom: tokens.sectionGap, fontWeight: baseWeight }}>
        <tbody>
          {receipt.lines.map((line, i) => (
            <tr key={i} style={{ verticalAlign: 'top' }}>
              <td style={{ padding: `${tokens.itemRow} 4px ${tokens.itemRow} 0`, width: '2em', fontVariantNumeric: 'tabular-nums' }}>
                {line.quantity}
              </td>
              <td style={{ padding: `${tokens.itemRow} 4px` }}>
                <div>{line.name}</div>
                {line.quantity > 1 && (
                  <div style={{ fontSize: '10pt', fontWeight: 500 }}>
                    @ {formatMoneyWithCurrency(line.unitPricePesewas)}
                  </div>
                )}
              </td>
              <td style={{ padding: `${tokens.itemRow} 0 ${tokens.itemRow} 4px`, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontWeight: strongWeight }}>
                {formatMoneyWithCurrency(line.lineTotalPesewas)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Hr />

      {/* Totals */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.rowGap, marginTop: tokens.rowGap }}>
        <Row left="Subtotal" right={formatMoneyWithCurrency(receipt.subtotalPesewas)} weight={baseWeight} mono />
        {receipt.discountPesewas > 0 && (
          <Row left="Discount" right={`−${formatMoneyWithCurrency(receipt.discountPesewas)}`} weight={baseWeight} mono />
        )}
        <Row
          left="TOTAL"
          right={formatMoneyWithCurrency(receipt.totalPesewas)}
          weight={900}
          fontSize="13pt"
          mono
        />
      </div>

      <Hr />

      {/* Payment block */}
      <div style={{ marginTop: tokens.rowGap, display: 'flex', flexDirection: 'column', gap: tokens.rowGap }}>
        {tenders.map((t, i) => (
          <Row
            key={i}
            left={`${paymentLabel(t.method)}${t.reference ? ` · ${t.reference}` : ''}`}
            right={formatMoneyWithCurrency(t.amountPesewas)}
            weight={strongWeight}
            mono
          />
        ))}
        {totalCashGiven > 0 && (
          <>
            <Row left="Cash given" right={formatMoneyWithCurrency(totalCashGiven)} weight={baseWeight} mono />
            {totalChange > 0 && (
              <Row left="Change" right={formatMoneyWithCurrency(totalChange)} weight={strongWeight} mono />
            )}
          </>
        )}
      </div>

      {/* Credit status (only shown when reviewing a past sale) */}
      {amountOutstandingPesewas != null && (
        <>
          <Hr />
          <div style={{ marginTop: tokens.rowGap, display: 'flex', flexDirection: 'column', gap: tokens.rowGap }}>
            <Row left="Paid" right={formatMoneyWithCurrency(amountPaidPesewas ?? 0)} weight={baseWeight} mono />
            <Row
              left="Outstanding"
              right={formatMoneyWithCurrency(amountOutstandingPesewas)}
              weight={strongWeight}
              mono
            />
          </div>
        </>
      )}

      <Hr />

      {/* Footer */}
      <div style={{ textAlign: 'center', marginTop: tokens.sectionGap, fontWeight: baseWeight }}>
        {config.footerText}
      </div>
    </div>
  );
}

function Hr(): JSX.Element {
  return (
    <div
      aria-hidden
      style={{ borderTop: '1px dashed #000', margin: '0' }}
    />
  );
}

function Row({
  left, right, weight, mono, fontSize,
}: { left: string; right: string; weight: number; mono?: boolean; fontSize?: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px', fontWeight: weight, fontSize }}>
      <span>{left}</span>
      <span style={mono ? { fontVariantNumeric: 'tabular-nums' } : undefined}>{right}</span>
    </div>
  );
}

export function ReceiptPrintModal({ receipt, onClose, amountPaidPesewas, amountOutstandingPesewas, config: configProp }: Props): JSX.Element {
  const [config, setConfig] = useState<ReceiptConfigResponse>(configProp ?? FALLBACK_CONFIG);
  const [configLoaded, setConfigLoaded] = useState<boolean>(!!configProp);

  useEffect(() => {
    if (configProp) {
      setConfig(configProp);
      setConfigLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await counter.receiptGetConfig();
      if (cancelled) return;
      if (r.success) setConfig(r.data);
      setConfigLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [configProp]);

  function doPrint(): void {
    window.print();
  }

  const printBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    printBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'F8') { e.preventDefault(); doPrint(); return; }
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

  // Print CSS — continuous-roll page sized to the paper width, zero
  // margin so the OS doesn't break the receipt into separate pages.
  const printCss = `
    @media print {
      @page { size: ${config.paperWidthMm}mm auto; margin: 0; }
      html, body { background: white !important; margin: 0 !important; padding: 0 !important; }
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
        border-radius: 0 !important;
        max-height: none !important;
        max-width: none !important;
        width: ${config.paperWidthMm}mm !important;
        background: white !important;
        color: black !important;
        overflow: visible !important;
      }
      .receipt-print-card > div { width: 100% !important; max-width: 100% !important; margin: 0 !important; }
      .receipt-print-controls { display: none !important; }
      .receipt-print-body { color: black !important; }
      .receipt-print-body * { color: black !important; }
    }
  `;

  // Screen preview width — approximate the paper roll in CSS px (96dpi → ~3.78 px/mm).
  const previewPx = Math.round(config.paperWidthMm * 3.78);

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-4 z-[70] receipt-print-overlay" onClick={onClose}>
      <style>{printCss}</style>
      <div
        className="receipt-print-card bg-white text-gray-900 rounded-lg shadow-2xl max-h-[90vh] overflow-auto"
        style={{ width: `${previewPx + 20}px` }}
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
              disabled={!configLoaded}
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

        {/* Receipt body — width capped to the paper roll so the preview
            matches what prints. */}
        <div style={{ width: `${previewPx}px`, margin: '0 auto', background: 'white' }}>
          <ReceiptBody
            receipt={receipt}
            config={config}
            amountPaidPesewas={amountPaidPesewas}
            amountOutstandingPesewas={amountOutstandingPesewas}
          />
        </div>
      </div>
    </div>
  );
}
