// OS-installed printers (USB on the host PC) print raw through the spooler.
// The commands are faked: these tests prove what Counter asks the OS to do,
// and how each refusal is reported back to the till.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseSpoolerSpec,
  printRawViaSpooler,
  listSpoolerPrinters,
  setupWindowsUsbPrinter,
  windowsUsbSetupScript,
  USB_SETUP_PRINTER_NAME,
  WINDOWS_LIST_PRINTERS_SCRIPT,
  WINDOWS_RAW_PRINT_SCRIPT,
  type CommandRunner,
  type RunResult,
} from '../src/main/printer/spooler';
import {
  SpoolerPrinter,
  getPrinter,
  setPrinterInterfaceSpecs,
  isPrinterConfigured,
  _setPrinter,
  _resetPrinter,
  type PrinterAdapter,
} from '../src/main/printer/printer';
import type { SaleReceipt } from '../src/main/printer/receipt';

interface Call {
  command: string;
  args: string[];
  input?: Buffer;
  env?: NodeJS.ProcessEnv;
  fileAtCall?: Buffer | null;
}

function fakeRunner(answer: (c: Call) => Partial<RunResult>): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, opts) => {
    const file = opts.env?.['COUNTER_PRINT_FILE'];
    const call: Call = {
      command,
      args,
      input: opts.input,
      env: opts.env,
      fileAtCall: file && existsSync(file) ? readFileSync(file) : null,
    };
    calls.push(call);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(call) };
  };
  return { run, calls };
}

const DATA = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a]);

const receipt: SaleReceipt = {
  shopName: 'SPOOL TEST SHOP',
  shopSubtitle: null,
  receiptId: 'r-1',
  workerName: 'Ama',
  saleAt: '2026-11-25T10:00:00.000Z',
  channel: 'WALK_IN',
  customerName: null,
  lines: [{ quantity: 2, name: 'Club Beer 625ml', unitPricePesewas: 1500, lineTotalPesewas: 3000 }],
  subtotalPesewas: 3000,
  discountPesewas: 0,
  totalPesewas: 3000,
  showVatBreakdown: false,
  payment: { method: 'CASH' },
  payments: [{ method: 'CASH', amountPesewas: 3000 }],
  footerText: 'Thank you.',
} as SaleReceipt;

afterEach(() => {
  setPrinterInterfaceSpecs({});
  _resetPrinter();
});

describe('parseSpoolerSpec', () => {
  it('reads a named printer, the default printer, and ignores other specs', () => {
    expect(parseSpoolerSpec('printer:Counter Receipt')).toEqual({ name: 'Counter Receipt' });
    expect(parseSpoolerSpec('  printer: XP-80C  ')).toEqual({ name: 'XP-80C' });
    expect(parseSpoolerSpec('printer:\\\\SHOP-PC\\POS')).toEqual({ name: '\\\\SHOP-PC\\POS' });
    expect(parseSpoolerSpec('printer:auto')).toEqual({ name: null });
    expect(parseSpoolerSpec('printer:')).toEqual({ name: null });
    expect(parseSpoolerSpec('tcp://192.168.1.50:9100')).toBeNull();
    expect(parseSpoolerSpec('/dev/usb/lp0')).toBeNull();
  });
});

describe('CUPS (macOS / Linux)', () => {
  it('checks the queue, then sends the bytes raw on stdin', async () => {
    const { run, calls } = fakeRunner((c) =>
      c.command === 'lpstat' ? { stdout: 'printer XP80 is idle.  enabled since Tue' } : { stdout: 'request id is XP80-7' },
    );
    const r = await printRawViaSpooler('XP80', DATA, { platform: 'darwin', run });
    expect(r).toEqual({ ok: true });
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      ['lpstat', ['-p', 'XP80']],
      ['lp', ['-d', 'XP80', '-o', 'raw', '-t', 'Counter receipt']],
    ]);
    expect(calls[1]!.input).toEqual(DATA);
  });

  it('uses the system default printer for printer:auto', async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args[0] === '-d' && c.command === 'lpstat'
        ? { stdout: 'system default destination: Receipt_Printer' }
        : { stdout: 'printer Receipt_Printer is idle.' },
    );
    expect(await printRawViaSpooler(null, DATA, { platform: 'linux', run })).toEqual({ ok: true });
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(['-d', 'Receipt_Printer']);
  });

  it('says so when there is no default printer', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: 'no system default destination' }));
    const r = await printRawViaSpooler(null, DATA, { platform: 'darwin', run });
    expect(r).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(calls.some((c) => c.command === 'lp')).toBe(false);
  });

  it('refuses an unknown queue without sending anything', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 1, stderr: 'lpstat: Invalid destination name' }));
    const r = await printRawViaSpooler('Nope', DATA, { platform: 'darwin', run });
    expect(r).toEqual({ ok: false, reason: 'NOT_CONFIGURED', message: 'printer "Nope" is not installed on this computer' });
    expect(calls.some((c) => c.command === 'lp')).toBe(false);
  });

  it('treats a paused queue as offline, so the job is not held silently', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: 'printer XP80 disabled since Tue -\n\tPaused' }));
    const r = await printRawViaSpooler('XP80', DATA, { platform: 'darwin', run });
    expect(r).toMatchObject({ ok: false, reason: 'OFFLINE' });
    expect(calls.some((c) => c.command === 'lp')).toBe(false);
  });

  it('reports lp failures and time-outs', async () => {
    const failing = fakeRunner((c) =>
      c.command === 'lp' ? { code: 1, stderr: 'lp: Error - printer stopped\n' } : { stdout: 'printer XP80 is idle.' },
    );
    expect(await printRawViaSpooler('XP80', DATA, { platform: 'darwin', run: failing.run })).toEqual({
      ok: false, reason: 'ERROR', message: 'lp: Error - printer stopped',
    });
    const slow = fakeRunner(() => ({ code: null, timedOut: true }));
    expect(await printRawViaSpooler('XP80', DATA, { platform: 'darwin', run: slow.run, timeoutMs: 50 })).toMatchObject({
      ok: false, reason: 'OFFLINE',
    });
  });
});

describe('Windows spooler', () => {
  function decodedScript(c: Call): string {
    const i = c.args.indexOf('-EncodedCommand');
    return Buffer.from(c.args[i + 1]!, 'base64').toString('utf16le');
  }

  it('runs the RAW WritePrinter script with the name and bytes passed outside the script', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0 }));
    const name = "Shop's \"XP\" $(rm -rf) printer";
    expect(await printRawViaSpooler(name, DATA, { platform: 'win32', run })).toEqual({ ok: true });
    const c = calls[0]!;
    expect(c.command).toBe('powershell.exe');
    expect(c.args).toContain('-NoProfile');
    expect(decodedScript(c)).toBe(WINDOWS_RAW_PRINT_SCRIPT);
    expect(decodedScript(c)).not.toContain(name);
    expect(WINDOWS_RAW_PRINT_SCRIPT).toContain('pDataType = "RAW"');
    expect(c.env!['COUNTER_PRINTER_NAME']).toBe(name);
    expect(c.fileAtCall).toEqual(DATA);
    expect(existsSync(c.env!['COUNTER_PRINT_FILE']!)).toBe(false); // temp file cleaned up
  });

  it('passes an empty name for the Windows default printer', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0 }));
    await printRawViaSpooler(null, DATA, { platform: 'win32', run });
    expect(calls[0]!.env!['COUNTER_PRINTER_NAME']).toBe('');
  });

  it.each([
    [3, 'NOT_CONFIGURED', "printer 'XP80' is not installed in Windows"],
    [6, 'NOT_CONFIGURED', 'no default printer is set in Windows'],
    [4, 'OFFLINE', "printer 'XP80' is offline"],
    [1, 'ERROR', 'The printer name is invalid'],
  ])('exit %i → %s', async (code, reason, message) => {
    const { run } = fakeRunner(() => ({ code, stderr: `${message}\r\n` }));
    expect(await printRawViaSpooler('XP80', DATA, { platform: 'win32', run })).toEqual({ ok: false, reason, message });
  });

  it('reports a hung PowerShell as offline and still removes the temp file', async () => {
    const { run, calls } = fakeRunner(() => ({ code: null, timedOut: true }));
    const r = await printRawViaSpooler('XP80', DATA, { platform: 'win32', run, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, reason: 'OFFLINE' });
    expect(existsSync(calls[0]!.env!['COUNTER_PRINT_FILE']!)).toBe(false);
  });
});

describe('SpoolerPrinter', () => {
  it('sends the formatted ESC/POS receipt, ending in one cut', async () => {
    const { run, calls } = fakeRunner((c) => (c.command === 'lpstat' ? { stdout: 'printer XP80 is idle.' } : {}));
    const r = await new SpoolerPrinter('XP80', { platform: 'darwin', run }).print(receipt);
    expect(r).toEqual({ ok: true });
    const sent = calls.find((c) => c.command === 'lp')!.input!;
    expect(sent.toString('latin1')).toContain('SPOOL TEST SHOP');
    expect(sent.toString('latin1')).toContain('Club Beer 625ml');
    // EPSON partial/full cut: GS V
    expect(sent.includes(Buffer.from([0x1d, 0x56]))).toBe(true);
  });

  it('is what getPrinter builds for printer: specs, instead of the driver-less library path', () => {
    setPrinterInterfaceSpecs({ counterPrinterInterface: 'printer:XP80', doorPrinterInterface: 'printer:auto' });
    expect(getPrinter('counter')).toBeInstanceOf(SpoolerPrinter);
    expect(getPrinter('door')).toBeInstanceOf(SpoolerPrinter);
    setPrinterInterfaceSpecs({ counterPrinterInterface: 'tcp://10.0.0.5:9100' });
    expect(getPrinter('counter')).not.toBeInstanceOf(SpoolerPrinter);
  });
});

describe('listing installed printers', () => {
  it('reads Windows printers, USB first, and copes with a single object', async () => {
    const many = fakeRunner(() => ({
      stdout: JSON.stringify([
        { name: 'Microsoft Print to PDF', isDefault: true, offline: false, port: 'PORTPROMPT:' },
        { name: 'POS-80', isDefault: false, offline: false, port: 'USB001' },
      ]),
    }));
    const r = await listSpoolerPrinters({ platform: 'win32', run: many.run });
    expect(r.printers.map((p) => [p.name, p.usb, p.isDefault])).toEqual([
      ['POS-80', true, false],
      ['Microsoft Print to PDF', false, true],
    ]);
    const decoded = Buffer.from(many.calls[0]!.args.at(-1)!, 'base64').toString('utf16le');
    expect(decoded).toBe(WINDOWS_LIST_PRINTERS_SCRIPT);

    const one = fakeRunner(() => ({ stdout: '{"name":"XP-80C","isDefault":false,"offline":true,"port":"USB002"}' }));
    expect((await listSpoolerPrinters({ platform: 'win32', run: one.run })).printers).toEqual([
      { name: 'XP-80C', isDefault: false, offline: true, port: 'USB002', usb: true },
    ]);
  });

  it('reports a Windows failure instead of an empty list that looks like "no printers"', async () => {
    const { run } = fakeRunner(() => ({ code: 1, stderr: 'Access denied\r\n' }));
    expect(await listSpoolerPrinters({ platform: 'win32', run })).toEqual({ printers: [], error: 'Access denied' });
  });

  it('reads CUPS printers with their default, paused state and USB device', async () => {
    const { run } = fakeRunner((c) => {
      if (c.args[0] === '-p') return { stdout: 'printer Office is idle.  enabled since Fri\nprinter XP80 disabled since Tue -\n\tPaused\n' };
      if (c.args[0] === '-d') return { stdout: 'system default destination: Office\n' };
      return { stdout: 'device for Office: ipp://10.0.0.9/ipp\ndevice for XP80: usb://Xprinter/XP-80?serial=1\n' };
    });
    expect((await listSpoolerPrinters({ platform: 'darwin', run })).printers).toEqual([
      { name: 'XP80', isDefault: false, offline: true, port: 'usb://Xprinter/XP-80?serial=1', usb: true },
      { name: 'Office', isDefault: true, offline: false, port: 'ipp://10.0.0.9/ipp', usb: false },
    ]);
  });

  it('treats "No destinations added" as no printers, not an error', async () => {
    const { run } = fakeRunner((c) => (c.args[0] === '-p' ? { code: 1, stderr: 'lpstat: No destinations added.' } : { code: 1 }));
    expect(await listSpoolerPrinters({ platform: 'linux', run })).toEqual({ printers: [] });
  });
});

describe('one-click USB printer setup (Windows)', () => {
  function innerScript(c: Call): string {
    const outer = Buffer.from(c.args.at(-1)!, 'base64').toString('utf16le');
    expect(outer).toContain('-Verb RunAs');
    const inner = /'-EncodedCommand','([^']+)'/.exec(outer)![1]!;
    return Buffer.from(inner, 'base64').toString('utf16le');
  }

  it('asks Windows to run the Generic / Text Only setup elevated and reads its result', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0 }));
    const r = await setupWindowsUsbPrinter({
      platform: 'win32',
      run,
      readResult: async () => '\uFEFF{"ok":true,"printerName":"Counter Receipt","port":"USB001","created":true}',
    });
    expect(r).toEqual({ ok: true, printerName: 'Counter Receipt', port: 'USB001', created: true });
    const script = innerScript(calls[0]!);
    expect(script).toContain("Add-Printer -Name $name -DriverName 'Generic / Text Only' -PortName $port.Name");
    expect(script).toContain("$_.Name -match '^USB\\d+'");
    expect(script).toContain(`$name = '${USB_SETUP_PRINTER_NAME}'`);
  });

  it('says what to do when the Windows prompt is declined', async () => {
    const { run } = fakeRunner(() => ({ code: 2, stderr: 'This operation was canceled by the user.\r\n' }));
    expect(await setupWindowsUsbPrinter({ platform: 'win32', run })).toMatchObject({ ok: false, reason: 'CANCELLED' });
  });

  it('passes on "no USB port" from the elevated script', async () => {
    const { run } = fakeRunner(() => ({ code: 0 }));
    const r = await setupWindowsUsbPrinter({
      platform: 'win32',
      run,
      readResult: async () => '{"ok":false,"reason":"NO_USB_PORT","message":"No free USB printer port."}',
    });
    expect(r).toEqual({ ok: false, reason: 'NO_USB_PORT', message: 'No free USB printer port.' });
  });

  it('is Windows-only', async () => {
    const { run, calls } = fakeRunner(() => ({}));
    expect(await setupWindowsUsbPrinter({ platform: 'darwin', run })).toMatchObject({ ok: false, reason: 'NOT_WINDOWS' });
    expect(calls).toHaveLength(0);
  });

  it('quotes the result path safely inside the elevated script', () => {
    expect(windowsUsbSetupScript("C:\\Users\\O'Neil\\AppData\\Local\\Temp\\r.json")).toContain(
      "$out = 'C:\\Users\\O''Neil\\AppData\\Local\\Temp\\r.json'",
    );
  });
});

describe('door printer falls back to the counter printer', () => {
  it('prints phone sales on the counter printer when the door has none', async () => {
    const counterSpy: PrinterAdapter & { calls: number } = {
      calls: 0,
      async print() { this.calls += 1; return { ok: true }; },
    };
    setPrinterInterfaceSpecs({ counterPrinterInterface: 'printer:POS-80', doorPrinterInterface: null });
    expect(isPrinterConfigured('door')).toBe(true);
    expect(getPrinter('door')).toBeInstanceOf(SpoolerPrinter);
    _setPrinter(counterSpy, 'door');
    await getPrinter('door').print(receipt);
    expect(counterSpy.calls).toBe(1);
  });

  it('still fails loud when neither station has a printer', async () => {
    setPrinterInterfaceSpecs({});
    _resetPrinter();
    expect(isPrinterConfigured('door')).toBe(false);
    expect(await getPrinter('door').print(receipt)).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
  });

  it('keeps a door printer of its own', () => {
    setPrinterInterfaceSpecs({ counterPrinterInterface: 'printer:POS-80', doorPrinterInterface: 'tcp://10.0.0.7:9100' });
    expect(getPrinter('door')).not.toBeInstanceOf(SpoolerPrinter);
  });
});
