// Printer adapter + station registry.
//
// Counter prints from the main process via node-thermal-printer. There are now
// multiple print STATIONS: 'counter' (the desk) and 'door' (the exit-control
// printer that clears phone sales without a walk back to the counter). Each
// station has its own interface spec and its own cached adapter;
// getPrinter(station) returns the right one.
//
// Station origin is stamped at the transport boundary — HTTP (phones) -> 'door',
// desktop IPC -> 'counter' — via currentStation() in session.ts. Callers pass
// that station in; we never infer it from sale data.
//
// Returns { ok, reason } — never throws across the IPC boundary.

import type { SaleReceipt } from './receipt.js';
import { formatReceiptRows, maxReceiptColumns, receiptColumns } from './receipt.js';
import { parseSpoolerSpec, printRawViaSpooler, type SpoolerOptions } from './spooler.js';

export type Station = 'counter' | 'door';

export type PrintResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'OFFLINE' | 'OUT_OF_PAPER' | 'ERROR'; message: string };

export interface PrinterAdapter {
  print(receipt: SaleReceipt): Promise<PrintResult>;
}

// Per-station env var holding the node-thermal-printer interface spec, e.g.
// "printer:Counter" (an OS-installed printer, via the spooler), "printer:auto"
// (the OS default printer), "tcp://192.168.1.50:9100", or a device path.
const STATION_ENV: Record<Station, string> = {
  counter: 'COUNTER_PRINTER_INTERFACE',
  door: 'COUNTER_PRINTER_INTERFACE_DOOR',
};

const configuredInterfaces: Partial<Record<Station, string | null>> = {};

// ── Layout from Settings → Receipt ─────────────────────────────────────────
// Printed receipts follow the same paper width, side margin, density and bold
// switch as the on-screen preview. setPrinterInterfaceSpecs receives the whole
// receipt config (boot and every save), so the layout rides along with it.

export type ReceiptDensity = 'compact' | 'normal' | 'spacious';

export interface ReceiptLayoutInput {
  paperWidthMm?: 58 | 80;
  sideMarginMm?: number;
  density?: ReceiptDensity;
  bold?: boolean;
}

interface ReceiptLayout {
  columns: number;
  /** Spaces before each line, so a wide side margin centres the text. */
  indent: number;
  /** ESC 3 n line spacing, in dots (printer default is about 30). */
  lineSpacingDots: number;
  bold: boolean;
}

const LINE_SPACING_DOTS: Record<ReceiptDensity, number> = { compact: 26, normal: 32, spacious: 42 };

// Until Settings has been read: the 80 mm, 2 mm, normal, bold defaults.
let layout: ReceiptLayout = layoutFrom({});

function layoutFrom(input: ReceiptLayoutInput): ReceiptLayout {
  const paper = input.paperWidthMm === 58 ? 58 : 80;
  const columns = receiptColumns(paper, input.sideMarginMm ?? 2);
  const density = input.density ?? 'normal';
  return {
    columns,
    indent: Math.floor((maxReceiptColumns(paper) - columns) / 2),
    lineSpacingDots: LINE_SPACING_DOTS[density] ?? LINE_SPACING_DOTS.normal,
    bold: input.bold !== false,
  };
}

export function setReceiptLayout(input: ReceiptLayoutInput): void {
  layout = layoutFrom(input);
}

/** Test hook: the layout printers use now. */
export function _receiptLayout(): Readonly<ReceiptLayout> {
  return layout;
}

/** The node-thermal-printer calls writeReceipt makes. */
interface ReceiptWriter {
  setTypeFontA(): void;
  bold(enabled: boolean): void;
  setLineSpacing(dots: number): void;
  setTextDoubleHeight(): void;
  setTextNormal(): void;
  println(text: string): void;
  cut(options?: { verticalTabAmount?: number }): void;
}

/** Writes a receipt in the shop's layout: Font A at the paper's width, the
 *  chosen line spacing and weight, and the shop name and TOTAL printed tall
 *  (double height keeps the width, so the columns still line up). */
export function writeReceipt(printer: ReceiptWriter, receipt: SaleReceipt): void {
  const { lines, emphasis } = formatReceiptRows(receipt, { columns: layout.columns });
  const pad = ' '.repeat(layout.indent);
  printer.setTypeFontA();
  printer.setLineSpacing(layout.lineSpacingDots);
  printer.bold(layout.bold);
  lines.forEach((line, i) => {
    if (emphasis.has(i)) {
      printer.setTextDoubleHeight();
      printer.println(pad + line);
      printer.setTextNormal();
    } else {
      printer.println(pad + line);
    }
  });
  printer.bold(false);
  // node-thermal-printer's cut() defaults to verticalTabAmount: 2, and for
  // the EPSON profile CTL_VT is `1b 64 04` — "print and feed 4 lines" —
  // so the default fed EIGHT blank lines before every cut. One is enough:
  // 4 lines carries the footer past the cutter blade (~12mm) and no
  // further. The remaining blank leader on the next receipt is the fixed
  // print-head-to-blade distance, which no software can remove.
  printer.cut({ verticalTabAmount: 1 });
}


function ownSpecFor(station: Station): string | undefined {
  const configured = configuredInterfaces[station];
  if (configured) return configured;
  return process.env[STATION_ENV[station]] || undefined;
}

// A shop with one printer sets only the Counter printer; phone (door) sales
// then print there too. With neither set, the door still fails loud
// (NOT_CONFIGURED) — the fallback is a real printer, never a silent success.
function interfaceSpecFor(station: Station): string | undefined {
  return ownSpecFor(station) ?? (station === 'door' ? ownSpecFor('counter') : undefined);
}

// Connection/probe timeout for network (tcp://) printers. A dead door printer
// must fail loud and FAST so the cashier is told before the customer walks off,
// not hang every sale on a stalled socket. Tunable; default 1.5s.
function printerTimeoutMs(): number {
  const raw = process.env['COUNTER_PRINTER_TIMEOUT_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

// Whether an unconfigured station may fall back to the console (dev only). In
// production an unconfigured/unreachable live station must report a REAL
// failure, never a silent success — that silent success is the exact door-gap
// this design closes. index.ts calls setPrinterDevMode(isDev) at startup; the
// default is production-safe (no console fallback).
let allowConsoleFallback = false;
export function setPrinterDevMode(isDev: boolean): void {
  allowConsoleFallback = isDev;
}

class ConsolePrinter implements PrinterAdapter {
  constructor(private station: Station) {}
  async print(receipt: SaleReceipt): Promise<PrintResult> {
    const text = formatReceiptRows(receipt, { columns: layout.columns }).lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(`\n----- RECEIPT (${this.station}, console fallback) -----\n${text}\n----- END RECEIPT -----\n`);
    return { ok: true };
  }
}

// Used in production when a station has no interface configured. Never prints
// and never claims success — surfaces a real NOT_CONFIGURED failure so the sale
// is flagged + queued and the cashier is told, instead of silently dropping the
// exit-control token.
class UnconfiguredPrinter implements PrinterAdapter {
  constructor(private station: Station) {}
  async print(): Promise<PrintResult> {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      message: `no printer configured for station "${this.station}" (set ${STATION_ENV[this.station]})`,
    };
  }
}

class ThermalPrinter implements PrinterAdapter {
  constructor(private interfaceSpec: string, private timeoutMs: number) {}

  async print(receipt: SaleReceipt): Promise<PrintResult> {
    let mod: typeof import('node-thermal-printer');
    try {
      mod = await import('node-thermal-printer');
    } catch (err) {
      return {
        ok: false,
        reason: 'ERROR',
        message: `node-thermal-printer not installed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // node-thermal-printer exports ThermalPrinter and PrinterTypes at the
    // top level (see its .d.ts). Aliased here because the local class above
    // is also called ThermalPrinter.
    try {
      const { ThermalPrinter: LibThermalPrinter, PrinterTypes } = mod;
      const printer = new LibThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: this.interfaceSpec,
        // Bounded socket timeout so a dead tcp:// door printer fails fast.
        options: { timeout: this.timeoutMs },
      });
      const tcp = parseTcpSpec(this.interfaceSpec);
      if (tcp) {
        // Probe ourselves: the library's own check swallows the socket error,
        // and "printer offline" alone can't tell a switched-off printer from a
        // wrong IP or a blocked network.
        const failure = await probeTcp(tcp.host, tcp.port, this.timeoutMs);
        if (failure) return { ok: false, reason: 'OFFLINE', message: failure };
      } else if (!(await printer.isPrinterConnected())) {
        return { ok: false, reason: 'OFFLINE', message: 'printer offline' };
      }

      writeReceipt(printer, receipt);
      await printer.execute();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: 'ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function parseTcpSpec(spec: string): { host: string; port: number } | null {
  const m = /^tcp:\/\/([^:/\s]+)(?::(\d+))?\/?$/i.exec(spec.trim());
  if (!m) return null;
  return { host: m[1]!, port: m[2] ? Number(m[2]) : 9100 };
}

/** Connects to a network printer and hangs up. null when it answered,
 *  otherwise a message the cashier and owner can act on. */
export async function probeTcp(host: string, port: number, timeoutMs: number): Promise<string | null> {
  const net = await import('node:net');
  const where = `${host}:${port}`;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done(`printer offline: no answer from ${where} within ${timeoutMs} ms (switched off, unplugged, or wrong IP?)`),
      timeoutMs,
    );
    socket.once('connect', () => done(null));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'ERROR';
      const hint =
        code === 'ECONNREFUSED' ? 'something is at that IP but it is not taking print jobs on that port'
        : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'this computer cannot reach that IP; check the printer is on the same network (on a Mac, also allow Counter under Privacy & Security → Local Network)'
        : code === 'ENOTFOUND' ? 'that printer name could not be found'
        : err.message;
      done(`printer offline: ${where} ${code} — ${hint}`);
    });
  });
}

// ESC/POS bytes for a receipt, built by node-thermal-printer but not sent: a
// stand-in interface keeps the library from opening anything.
async function receiptBytes(receipt: SaleReceipt): Promise<Buffer> {
  const { ThermalPrinter: LibThermalPrinter, PrinterTypes } = await import('node-thermal-printer');
  const noSend = {
    getPrinterName: () => 'buffer',
    isPrinterConnected: async () => true,
    execute: async () => 'not sent',
  };
  const printer = new LibThermalPrinter({
    type: PrinterTypes.EPSON,
    // The library accepts an interface object in place of a spec string.
    interface: noSend as unknown as string,
  });
  writeReceipt(printer, receipt);
  return printer.getBuffer();
}

/** A printer installed in the OS (usually USB on the host PC): `printer:<name>`,
 *  or `printer:auto` for the OS default. Sent raw through the spooler. */
export class SpoolerPrinter implements PrinterAdapter {
  constructor(private name: string | null, private opts: SpoolerOptions = {}) {}

  async print(receipt: SaleReceipt): Promise<PrintResult> {
    let data: Buffer;
    try {
      data = await receiptBytes(receipt);
    } catch (err) {
      return { ok: false, reason: 'ERROR', message: err instanceof Error ? err.message : String(err) };
    }
    return printRawViaSpooler(this.name, data, this.opts);
  }
}

// One cached adapter per station.
const cache = new Map<Station, PrinterAdapter>();

function buildAdapter(station: Station): PrinterAdapter {
  const spec = interfaceSpecFor(station);
  if (spec) {
    // node-thermal-printer's own printer: interface needs a native driver
    // Counter doesn't ship ("No driver set!"), so OS printers go via the spooler.
    const os = parseSpoolerSpec(spec);
    if (os) return new SpoolerPrinter(os.name);
    return new ThermalPrinter(spec, printerTimeoutMs());
  }
  // No spec: console in dev, hard failure in prod (never a silent success).
  return allowConsoleFallback ? new ConsolePrinter(station) : new UnconfiguredPrinter(station);
}

export function getPrinter(station: Station = 'counter'): PrinterAdapter {
  let adapter = cache.get(station);
  if (!adapter) {
    adapter = buildAdapter(station);
    cache.set(station, adapter);
  }
  return adapter;
}

/** Test hook: inject a fake printer for a station (defaults to 'counter' so
 *  existing single-arg callers keep working). */
export function _setPrinter(p: PrinterAdapter, station: Station = 'counter'): void {
  cache.set(station, p);
}

/** Test hook: reset a station (or all stations) to env-based selection. */
export function _resetPrinter(station?: Station): void {
  if (station) cache.delete(station);
  else cache.clear();
}

export function isPrinterConfigured(station: Station = 'counter'): boolean {
  return Boolean(interfaceSpecFor(station));
}

export function setPrinterInterfaceSpecs(input: {
  counterPrinterInterface?: string | null;
  doorPrinterInterface?: string | null;
} & ReceiptLayoutInput): void {
  setReceiptLayout(input);
  configuredInterfaces.counter = normalizeSpec(input.counterPrinterInterface);
  configuredInterfaces.door = normalizeSpec(input.doorPrinterInterface);
  cache.clear();
}

function normalizeSpec(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
