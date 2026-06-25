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
import { formatReceipt } from './receipt.js';

export type Station = 'counter' | 'door';

export type PrintResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'OFFLINE' | 'OUT_OF_PAPER' | 'ERROR'; message: string };

export interface PrinterAdapter {
  print(receipt: SaleReceipt): Promise<PrintResult>;
}

// Per-station env var holding the node-thermal-printer interface spec, e.g.
// "printer:Counter", "tcp://192.168.1.50:9100", or a USB path.
const STATION_ENV: Record<Station, string> = {
  counter: 'COUNTER_PRINTER_INTERFACE',
  door: 'COUNTER_PRINTER_INTERFACE_DOOR',
};

function interfaceSpecFor(station: Station): string | undefined {
  return process.env[STATION_ENV[station]];
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
    const text = formatReceipt(receipt).join('\n');
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
    const { ThermalPrinter: LibThermalPrinter, PrinterTypes } = mod;
    const printer = new LibThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: this.interfaceSpec,
      // Bounded socket timeout so a dead tcp:// door printer fails fast.
      options: { timeout: this.timeoutMs },
    });

    try {
      const isConnected = await printer.isPrinterConnected();
      if (!isConnected) return { ok: false, reason: 'OFFLINE', message: 'printer offline' };

      for (const line of formatReceipt(receipt)) {
        printer.println(line);
      }
      printer.cut();
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

// One cached adapter per station.
const cache = new Map<Station, PrinterAdapter>();

function buildAdapter(station: Station): PrinterAdapter {
  const spec = interfaceSpecFor(station);
  if (spec) return new ThermalPrinter(spec, printerTimeoutMs());
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
