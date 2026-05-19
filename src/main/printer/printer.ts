// Printer adapter. Lazy-loads node-thermal-printer only when a real interface
// is configured via COUNTER_PRINTER_INTERFACE; otherwise falls back to
// console output (dev mode) and reports success.
//
// Returns { ok, reason } — never throws across the IPC boundary.

import type { SaleReceipt } from './receipt.js';
import { formatReceipt } from './receipt.js';

export type PrintResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'OFFLINE' | 'OUT_OF_PAPER' | 'ERROR'; message: string };

export interface PrinterAdapter {
  print(receipt: SaleReceipt): Promise<PrintResult>;
}

class ConsolePrinter implements PrinterAdapter {
  async print(receipt: SaleReceipt): Promise<PrintResult> {
    const text = formatReceipt(receipt).join('\n');
    // eslint-disable-next-line no-console
    console.log('\n----- RECEIPT (console fallback) -----\n' + text + '\n----- END RECEIPT -----\n');
    return { ok: true };
  }
}

class ThermalPrinter implements PrinterAdapter {
  constructor(private interfaceSpec: string) {}

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

let cached: PrinterAdapter | null = null;

export function getPrinter(): PrinterAdapter {
  if (cached) return cached;
  const spec = process.env['COUNTER_PRINTER_INTERFACE'];
  cached = spec ? new ThermalPrinter(spec) : new ConsolePrinter();
  return cached;
}

/** Test hook: inject a fake printer for unit tests. */
export function _setPrinter(p: PrinterAdapter): void {
  cached = p;
}

/** Test hook: reset to env-based selection. */
export function _resetPrinter(): void {
  cached = null;
}

export function isPrinterConfigured(): boolean {
  return Boolean(process.env['COUNTER_PRINTER_INTERFACE']);
}
