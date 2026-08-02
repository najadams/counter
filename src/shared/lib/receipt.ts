// Receipt formatter. Pure — takes a SaleReceipt struct, returns string[].
//
// 32 columns wide, monospace. No external deps. Easy to test, easy to read.
// The print adapter joins the lines with '\n' and ships them to the device.

import { RECEIPT_COLUMNS } from './constants.js';
import { formatMoney } from './money.js';

export interface ReceiptLine {
  quantity: number;
  name: string;             // product name as displayed
  unitPricePesewas: number;
  lineTotalPesewas: number;
}

export interface ReceiptPayment {
  method: string;           // 'CASH', 'MOMO_MTN', etc.
  reference?: string | null;
  cashGivenPesewas?: number | null;
  changePesewas?: number | null;
}

export interface ReceiptTender {
  method: string;
  amountPesewas: number;
  reference?: string | null;
  cashGivenPesewas?: number | null;
  changePesewas?: number | null;
}

export interface SaleReceipt {
  shopName: string;
  shopSubtitle?: string | null;
  /** Optional extra header lines (e.g. phone, address). */
  headerLine3?: string | null;
  headerLine4?: string | null;
  receiptId: string;        // sale_id (typically uuid; we'll show the last 8)
  workerName: string;
  saleAt: string;           // ISO timestamp
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  customerName?: string | null;
  lines: ReceiptLine[];
  subtotalPesewas: number;
  discountPesewas: number;
  totalPesewas: number;
  /** Ghana VAT breakdown (Act 1151). Extracted from the VAT-inclusive total.
   *  All optional and 0/absent in the no-VAT build — the VAT block is then
   *  suppressed entirely so the no-VAT receipt is unchanged. */
  taxablePesewas?: number;
  vatPesewas?: number;
  nhilPesewas?: number;
  getfundPesewas?: number;
  /** False hides the VAT receipt block even when VAT is recorded on the sale. */
  showVatBreakdown?: boolean;
  /** Shop's VAT/TIN registration number, printed under the VAT block. */
  vatRegistrationNumber?: string | null;
  /** Legacy single-tender summary (always set; mirrors payments[0] for one-tender sales). */
  payment: ReceiptPayment;
  /** New: one entry per tender. If absent or single-row, formatter falls back to `payment`. */
  payments?: ReceiptTender[];
  printerFailedNotice?: boolean;
  /** Set on a sale-correction replacement receipt: prints a prominent
   *  "CORRECTED — supersedes #<id>" banner so the door-check honours this slip
   *  and not the superseded original. */
  correctedFromReceiptId?: string | null;
  /** Reprint-only operational warning, e.g. a pending void request. */
  statusNotice?: string | null;
  /** Customization. All optional — defaults preserve the legacy output. */
  footerText?: string | null;
  showCashier?: boolean;
  showChannel?: boolean;
  showCustomer?: boolean;
}

const W = RECEIPT_COLUMNS;

function center(s: string): string {
  if (s.length >= W) return s.slice(0, W);
  const pad = Math.floor((W - s.length) / 2);
  return ' '.repeat(pad) + s;
}

function divider(ch = '-'): string {
  return ch.repeat(W);
}

function wrapWords(value: string): string[] {
  const words = value.trim().split(/\s+/);
  const rows: string[] = [];
  let row = '';
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (next.length <= W) row = next;
    else {
      if (row) rows.push(row);
      row = word;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** Place a label on the left and a value on the right, padded to width W. */
function leftRight(left: string, right: string): string {
  if (left.length + right.length + 1 >= W) {
    // Truncate the left if too long.
    const room = W - right.length - 1;
    const lt = room > 0 ? left.slice(0, room) : '';
    return `${lt} ${right}`.padEnd(W).slice(0, W);
  }
  const pad = W - left.length - right.length;
  return left + ' '.repeat(pad) + right;
}

/** Format a sale line: "qty x name ............ total" */
function formatLine(line: ReceiptLine): string[] {
  const qtyAndName = `${line.quantity} x ${line.name}`;
  const totalStr = formatMoney(line.lineTotalPesewas);
  // Reserve right-side space for total (1 space + total). Wrap name if needed.
  const rightWidth = totalStr.length + 1;
  const leftWidth = W - rightWidth;

  if (qtyAndName.length <= leftWidth) {
    return [leftRight(qtyAndName, totalStr)];
  }
  // Wrap: first line has the qty + as much name as fits, second line continues.
  const firstChunk = qtyAndName.slice(0, leftWidth).trimEnd();
  const remaining = qtyAndName.slice(firstChunk.length).trimStart();
  const out: string[] = [leftRight(firstChunk, '')];
  // Subsequent lines hold (continuation) + total on last
  let cursor = remaining;
  while (cursor.length > leftWidth) {
    out.push(cursor.slice(0, leftWidth).trimEnd());
    cursor = cursor.slice(leftWidth).trimStart();
  }
  if (cursor.length > 0) out.push(leftRight(cursor, totalStr));
  else out[out.length - 1] = leftRight(out[out.length - 1]!.trimEnd(), totalStr);
  return out;
}

export function formatReceipt(r: SaleReceipt): string[] {
  const lines: string[] = [];

  lines.push(center(r.shopName.toUpperCase().slice(0, W)));
  if (r.shopSubtitle) lines.push(center(r.shopSubtitle.slice(0, W)));
  if (r.headerLine3) lines.push(center(r.headerLine3.slice(0, W)));
  if (r.headerLine4) lines.push(center(r.headerLine4.slice(0, W)));
  lines.push(divider('='));

  lines.push(`Receipt #${r.receiptId.slice(-8)}`);
  if (r.statusNotice) {
    lines.push(divider('!'));
    // Status notices deliberately use an em dash to separate the decision
    // from its consequence. Keep those clauses on distinct thermal lines so
    // a door checker can read the state at a glance instead of seeing an
    // arbitrary 32-column wrap such as "PENDING — SALE".
    const noticeClauses = r.statusNotice.split(/\s+—\s+/);
    for (const clause of noticeClauses) {
      for (const noticeLine of wrapWords(clause)) lines.push(center(noticeLine));
    }
    lines.push(divider('!'));
  }
  if (r.correctedFromReceiptId) {
    lines.push(center('*** CORRECTED ***'));
    lines.push(center(`supersedes #${r.correctedFromReceiptId.slice(-8)}`));
  }
  const dt = new Date(r.saleAt);
  // Compact "YYYY-MM-DD HH:mm" — local time, padded.
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dtStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  const showCashier = r.showCashier !== false;
  if (showCashier) {
    lines.push(leftRight(dtStr, r.workerName.slice(0, W - dtStr.length - 1)));
  } else {
    lines.push(dtStr);
  }

  if (r.showChannel !== false && r.channel !== 'WALK_IN') {
    lines.push(`Channel: ${r.channel}`);
  }
  if (r.showCustomer !== false && r.customerName) {
    lines.push(`Customer: ${r.customerName.slice(0, W - 10)}`);
  }
  lines.push(divider('-'));

  for (const line of r.lines) {
    for (const out of formatLine(line)) lines.push(out);
  }

  lines.push(divider('-'));
  lines.push(leftRight('Subtotal', formatMoney(r.subtotalPesewas)));
  if (r.discountPesewas > 0) {
    lines.push(leftRight('Discount', `-${formatMoney(r.discountPesewas)}`));
  }
  lines.push(leftRight('TOTAL', formatMoney(r.totalPesewas)));

  // VAT breakdown (Ghana, Act 1151). Inclusive prices, so this is informational:
  // it shows the tax already contained in TOTAL. Printed only when there is VAT
  // to show (VAT build); the no-VAT build leaves these 0 and prints nothing.
  const vatPesewas = r.vatPesewas ?? 0;
  const nhilPesewas = r.nhilPesewas ?? 0;
  const getfundPesewas = r.getfundPesewas ?? 0;
  if (r.showVatBreakdown !== false && (vatPesewas > 0 || nhilPesewas > 0 || getfundPesewas > 0)) {
    lines.push(center('TOTAL includes VAT'));
    lines.push(leftRight('Taxable (excl)', formatMoney(r.taxablePesewas ?? 0)));
    lines.push(leftRight('VAT 15%', formatMoney(vatPesewas)));
    lines.push(leftRight('NHIL 2.5%', formatMoney(nhilPesewas)));
    lines.push(leftRight('GETFund 2.5%', formatMoney(getfundPesewas)));
    if (r.vatRegistrationNumber) {
      lines.push(`VAT Reg: ${r.vatRegistrationNumber.slice(0, W - 9)}`);
    }
  }

  lines.push(divider('-'));

  // Payment block: split-tender aware. If `payments` has more than one entry,
  // print one line per tender. Otherwise use the legacy single-payment block.
  const tenders: ReceiptTender[] = (r.payments && r.payments.length > 0)
    ? r.payments
    : [{
        method: r.payment.method,
        amountPesewas: r.totalPesewas,
        reference: r.payment.reference ?? null,
        cashGivenPesewas: r.payment.cashGivenPesewas ?? null,
        changePesewas: r.payment.changePesewas ?? null,
      }];

  if (tenders.length === 1) {
    const t = tenders[0]!;
    lines.push(leftRight('Payment', paymentLabel(t.method)));
    if (t.reference) lines.push(leftRight('Ref', t.reference.slice(0, W - 5)));
    if (t.method === 'CASH' && t.cashGivenPesewas != null) {
      lines.push(leftRight('Cash given', formatMoney(t.cashGivenPesewas)));
      if (t.changePesewas != null && t.changePesewas !== 0) {
        lines.push(leftRight('Change', formatMoney(t.changePesewas)));
      }
    }
  } else {
    lines.push('Payments:');
    for (const t of tenders) {
      lines.push(leftRight(`  ${paymentLabel(t.method)}`, formatMoney(t.amountPesewas)));
      if (t.reference) lines.push(leftRight(`    Ref`, t.reference.slice(0, W - 9)));
      if (t.method === 'CASH' && t.cashGivenPesewas != null) {
        lines.push(leftRight(`    Cash given`, formatMoney(t.cashGivenPesewas)));
        if (t.changePesewas != null && t.changePesewas !== 0) {
          lines.push(leftRight(`    Change`, formatMoney(t.changePesewas)));
        }
      }
    }
  }
  lines.push(divider('='));

  if (r.printerFailedNotice) {
    lines.push(center('** REPRINT — PRINTER FAILED **'));
    lines.push('');
  }
  const footer = (r.footerText ?? 'Thank you. Come again.').trim();
  if (footer) lines.push(center(footer.slice(0, W)));

  return lines;
}

function paymentLabel(method: string): string {
  switch (method) {
    case 'CASH': return 'Cash';
    case 'MOMO_MTN': return 'MTN MoMo';
    case 'MOMO_VODAFONE': return 'Telecel Cash';
    case 'MOMO_AIRTELTIGO': return 'AirtelTigo';
    case 'BANK_TRANSFER': return 'Bank xfer';
    case 'CREDIT': return 'On account';
    default: return method;
  }
}

/** Renders the receipt as a single string, useful for logging/dev. */
export function renderReceiptText(r: SaleReceipt): string {
  return formatReceipt(r).join('\n');
}
