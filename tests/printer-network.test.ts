// Network (tcp://) receipt printers: the connection check says WHY a print
// failed — no answer, refused, or unreachable — instead of a bare "offline".

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTcpSpec, probeTcp, setPrinterInterfaceSpecs, getPrinter, _resetPrinter } from '../src/main/printer/printer';

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  _resetPrinter();
});

function listen(onData?: (b: Buffer) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (b) => onData?.(b));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function closedPort(): Promise<number> {
  const port = await listen();
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  return port;
}

describe('parseTcpSpec', () => {
  it('reads host and port, defaulting to 9100', () => {
    expect(parseTcpSpec('tcp://192.168.1.250:9100')).toEqual({ host: '192.168.1.250', port: 9100 });
    expect(parseTcpSpec(' tcp://printer.local ')).toEqual({ host: 'printer.local', port: 9100 });
    expect(parseTcpSpec('printer:POS-80')).toBeNull();
  });
});

describe('probeTcp', () => {
  it('returns null when the printer answers', async () => {
    expect(await probeTcp('127.0.0.1', await listen(), 1500)).toBeNull();
  });

  it('names a refused port', async () => {
    const msg = await probeTcp('127.0.0.1', await closedPort(), 1500);
    expect(msg).toMatch(/ECONNREFUSED/);
    expect(msg).toMatch(/not taking print jobs/);
  });

  it('times out on an address that never answers', async () => {
    // TEST-NET-1 (RFC 5737): routable nowhere, so the connect just hangs.
    const t0 = Date.now();
    const msg = await probeTcp('192.0.2.1', 9100, 300);
    expect(msg).toMatch(/printer offline/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('network printer adapter', () => {
  it('sends the receipt bytes to the printer', async () => {
    const chunks: Buffer[] = [];
    const port = await listen((b) => chunks.push(b));
    setPrinterInterfaceSpecs({ counterPrinterInterface: `tcp://127.0.0.1:${port}`, doorPrinterInterface: null });
    const r = await getPrinter('counter').print({
      shopName: 'NET TEST', shopSubtitle: null, receiptId: 'r1', workerName: 'W', saleAt: new Date().toISOString(),
      channel: 'WALK_IN', customerName: null,
      lines: [{ quantity: 1, name: 'Club', unitPricePesewas: 1500, lineTotalPesewas: 1500 }],
      subtotalPesewas: 1500, discountPesewas: 0, totalPesewas: 1500, showVatBreakdown: false,
      payment: { method: 'CASH' }, payments: [{ method: 'CASH', amountPesewas: 1500 }], footerText: 'thanks',
    } as never);
    expect(r).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 100));
    expect(Buffer.concat(chunks).toString('latin1')).toContain('NET TEST');
  });

  it('reports the reason when nothing is listening', async () => {
    setPrinterInterfaceSpecs({ counterPrinterInterface: `tcp://127.0.0.1:${await closedPort()}`, doorPrinterInterface: null });
    const r = await getPrinter('door').print({} as never);
    expect(r).toMatchObject({ ok: false, reason: 'OFFLINE' });
    expect(r.ok === false && r.message).toMatch(/ECONNREFUSED/);
  });
});

describe('receipt footer', () => {
  it('wraps a long footer instead of cutting its end off', async () => {
    const { formatReceipt } = await import('../src/shared/lib/receipt');
    const lines = formatReceipt({
      shopName: 'S', receiptId: 'r', workerName: 'W', saleAt: new Date().toISOString(), channel: 'WALK_IN',
      lines: [], subtotalPesewas: 0, discountPesewas: 0, totalPesewas: 0, showVatBreakdown: false,
      payment: { method: 'CASH' }, footerText: 'If you can read this, setup works.',
    } as never);
    const tail = lines.slice(-2).map((l) => l.trim());
    expect(tail.join(' ')).toBe('If you can read this, setup works.');
    expect(lines.every((l) => l.length <= 32)).toBe(true);
  });
});

describe('receipt layout follows Settings → Receipt', () => {
  it('fits the paper: 48 characters on 80 mm, 32 on 58 mm, fewer with a wide margin', async () => {
    const { receiptColumns } = await import('../src/shared/lib/receipt');
    expect(receiptColumns(80, 2)).toBe(48);
    expect(receiptColumns(80, 0)).toBe(48);
    expect(receiptColumns(80, 6)).toBe(45);
    expect(receiptColumns(58, 2)).toBe(32);
    expect(receiptColumns(58, 6)).toBe(30);
  });

  it('formats every line to the chosen width', async () => {
    const { formatReceiptRows } = await import('../src/shared/lib/receipt');
    const { lines, emphasis } = formatReceiptRows({
      shopName: 'Osu Drinks', receiptId: 'sa-12345678', workerName: 'Ama', saleAt: new Date().toISOString(),
      channel: 'WALK_IN', lines: [{ quantity: 2, name: 'Club Beer 625ml', unitPricePesewas: 1500, lineTotalPesewas: 3000 }],
      subtotalPesewas: 3000, discountPesewas: 0, totalPesewas: 3000, showVatBreakdown: false, payment: { method: 'CASH' },
    } as never, { columns: 48 });
    expect(lines.filter((l) => /^[-=]+$/.test(l)).every((l) => l.length === 48)).toBe(true);
    expect(lines.find((l) => l.startsWith('TOTAL'))).toHaveLength(48);
    expect([...emphasis].map((i) => lines[i]!.trim().split(/\s+/)[0])).toEqual(['OSU', 'TOTAL']);
  });

  it('sends spacing, weight, tall name and total, and the margin indent', async () => {
    const { writeReceipt, setReceiptLayout, _receiptLayout } = await import('../src/main/printer/printer');
    setReceiptLayout({ paperWidthMm: 80, sideMarginMm: 6, density: 'spacious', bold: false });
    expect(_receiptLayout()).toMatchObject({ columns: 45, indent: 1, lineSpacingDots: 42, bold: false });
    const calls: string[] = [];
    const rec = (name: string) => (arg?: unknown) => { calls.push(arg === undefined ? name : `${name}:${JSON.stringify(arg)}`); };
    writeReceipt({
      setTypeFontA: rec('fontA'), bold: rec('bold'), setLineSpacing: rec('spacing'),
      setTextDoubleHeight: rec('tall'), setTextNormal: rec('normal'), println: rec('line'), cut: rec('cut'),
    }, {
      shopName: 'Osu', receiptId: 'r', workerName: 'W', saleAt: new Date().toISOString(), channel: 'WALK_IN',
      lines: [], subtotalPesewas: 0, discountPesewas: 0, totalPesewas: 0, showVatBreakdown: false, payment: { method: 'CASH' },
    } as never);
    expect(calls.slice(0, 5)).toEqual(['fontA', 'spacing:42', 'bold:false', 'tall', `line:${JSON.stringify(' ' + ' '.repeat(21) + 'OSU')}`]);
    expect(calls).toContain('normal');
    expect(calls.at(-1)).toBe('cut:{"verticalTabAmount":1}');
    setReceiptLayout({});
  });
});
