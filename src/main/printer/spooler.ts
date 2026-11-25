// Raw printing through the operating system's print spooler.
//
// A receipt printer plugged into the host PC by USB is reached by its OS
// printer name ("printer:Counter Receipt") or as the OS default printer
// ("printer:auto"). node-thermal-printer only handles that with an optional
// native driver module, which Counter does not ship (another native module is
// another per-OS, per-arch build to get wrong — see CLAUDE.md §2). Instead we
// build the ESC/POS bytes as usual and hand them, unchanged, to the spooler:
//
//   Windows      PowerShell + winspool.drv WritePrinter with datatype RAW
//   macOS/Linux  CUPS: `lp -o raw`
//
// Phones never print themselves: their sales print on the host (§9), so this
// one path serves every device on the LAN.
//
// Never throws: every failure becomes a PrintResult so the sale is flagged and
// queued for reprint like any other printer failure.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrintResult } from './printer.js';

/** `printer:auto` → the OS default printer (name null); `printer:<name>` → that queue. */
export function parseSpoolerSpec(spec: string): { name: string | null } | null {
  const m = /^printer:(.*)$/i.exec(spec.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  if (!name || name.toLowerCase() === 'auto') return { name: null };
  return { name };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { input?: Buffer; env?: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<RunResult>;

/** spawn without a shell: printer names reach the child as plain arguments/env, never parsed. */
export const runCommand: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({ code: null, stdout, stderr, timedOut });
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => finish({ code: null, stdout, stderr: stderr || err.message, timedOut }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin?.on('error', () => { /* child exited early; reported via close */ });
    child.stdin?.end(opts.input);
  });

// Exit codes the Windows script uses to say why it did not print.
const WIN_NOT_FOUND = 3;
const WIN_OFFLINE = 4;
const WIN_NO_DEFAULT = 6;

// Reads the printer name and data file from the environment, so nothing the
// owner typed is ever spliced into the script text.
export const WINDOWS_RAW_PRINT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $name = $env:COUNTER_PRINTER_NAME
  $printers = @(Get-CimInstance -ClassName Win32_Printer)
  if ([string]::IsNullOrEmpty($name)) {
    $p = $printers | Where-Object { $_.Default } | Select-Object -First 1
    if (-not $p) { [Console]::Error.WriteLine('no default printer is set in Windows'); exit ${WIN_NO_DEFAULT} }
  } else {
    $p = $printers | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $p) { [Console]::Error.WriteLine("printer '$name' is not installed in Windows"); exit ${WIN_NOT_FOUND} }
  }
  if ($p.WorkOffline) { [Console]::Error.WriteLine("printer '$($p.Name)' is offline"); exit ${WIN_OFFLINE} }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CounterRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int written);
  public static void Send(string name, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(name, out h, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      DOCINFO di = new DOCINFO { pDocName = "Counter receipt", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int written;
        bool ok = WritePrinter(h, bytes, bytes.Length, out written);
        EndPagePrinter(h);
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (written != bytes.Length) throw new Exception("printer accepted " + written + " of " + bytes.Length + " bytes");
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
  [CounterRawPrint]::Send($p.Name, [IO.File]::ReadAllBytes($env:COUNTER_PRINT_FILE))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

export interface SpoolerOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  timeoutMs?: number;
}

/** Spooler submission includes PowerShell start-up on Windows, so it gets more
 *  room than the 1.5s socket probe — but still bounded, because the till waits
 *  on the print before it shows the sale as done. */
export function spoolerTimeoutMs(): number {
  const raw = process.env['COUNTER_PRINTER_SPOOL_TIMEOUT_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

export async function printRawViaSpooler(
  name: string | null,
  data: Buffer,
  opts: SpoolerOptions = {},
): Promise<PrintResult> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const timeoutMs = opts.timeoutMs ?? spoolerTimeoutMs();
  const label = name ? `"${name}"` : 'the default printer';
  try {
    return platform === 'win32'
      ? await printWindows(name, data, run, timeoutMs, label)
      : await printCups(name, data, run, timeoutMs, label);
  } catch (err) {
    return { ok: false, reason: 'ERROR', message: err instanceof Error ? err.message : String(err) };
  }
}

async function printWindows(
  name: string | null,
  data: Buffer,
  run: CommandRunner,
  timeoutMs: number,
  label: string,
): Promise<PrintResult> {
  const file = path.join(os.tmpdir(), `counter-receipt-${randomUUID()}.bin`);
  await fs.writeFile(file, data);
  try {
    // -EncodedCommand takes UTF-16LE base64, so the script needs no quoting.
    const encoded = Buffer.from(WINDOWS_RAW_PRINT_SCRIPT, 'utf16le').toString('base64');
    const r = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, COUNTER_PRINTER_NAME: name ?? '', COUNTER_PRINT_FILE: file },
        timeoutMs,
      },
    );
    if (r.timedOut) return { ok: false, reason: 'OFFLINE', message: `${label} did not answer within ${timeoutMs} ms` };
    if (r.code === 0) return { ok: true };
    const why = firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code ?? 'unknown'}`;
    if (r.code === WIN_NOT_FOUND || r.code === WIN_NO_DEFAULT) return { ok: false, reason: 'NOT_CONFIGURED', message: why };
    if (r.code === WIN_OFFLINE) return { ok: false, reason: 'OFFLINE', message: why };
    return { ok: false, reason: 'ERROR', message: why };
  } finally {
    await fs.unlink(file).catch(() => { /* best effort */ });
  }
}

async function printCups(
  name: string | null,
  data: Buffer,
  run: CommandRunner,
  timeoutMs: number,
  label: string,
): Promise<PrintResult> {
  // Is the queue there, and accepting work? `lpstat -p` exits non-zero for an
  // unknown queue; a paused queue reports "disabled" and would hold the job.
  let queue = name;
  if (!queue) {
    const d = await run('lpstat', ['-d'], { timeoutMs });
    const m = /destination:\s*(\S+)/.exec(d.stdout);
    if (!m) return { ok: false, reason: 'NOT_CONFIGURED', message: 'no default printer is set on this computer' };
    queue = m[1]!;
  }
  const st = await run('lpstat', ['-p', queue], { timeoutMs });
  if (st.timedOut) return { ok: false, reason: 'OFFLINE', message: `${label} did not answer within ${timeoutMs} ms` };
  if (st.code !== 0) return { ok: false, reason: 'NOT_CONFIGURED', message: `printer "${queue}" is not installed on this computer` };
  if (/\bdisabled\b/i.test(st.stdout)) return { ok: false, reason: 'OFFLINE', message: `printer "${queue}" is paused` };

  const r = await run('lp', ['-d', queue, '-o', 'raw', '-t', 'Counter receipt'], { input: data, timeoutMs });
  if (r.timedOut) return { ok: false, reason: 'OFFLINE', message: `${label} did not answer within ${timeoutMs} ms` };
  if (r.code === 0) return { ok: true };
  return { ok: false, reason: 'ERROR', message: firstLine(r.stderr) || `lp exit ${r.code ?? 'unknown'}` };
}

// ---------------------------------------------------------------------------
// Which printers does this computer have? Feeds the Settings picker, so the
// owner chooses a printer instead of typing its exact OS name — and never has
// to make it the OS default.

export interface InstalledPrinter {
  name: string;
  isDefault: boolean;
  offline: boolean;
  /** USB001, usb://…, IP_192.168.1.50, … — '' when the OS doesn't say. */
  port: string;
  /** Plugged in by USB: what a receipt printer on the host usually is. */
  usb: boolean;
}

export const WINDOWS_LIST_PRINTERS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$list = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; isDefault = [bool]$_.Default; offline = [bool]$_.WorkOffline; port = [string]$_.PortName }
})
ConvertTo-Json -InputObject $list -Compress
`;

function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)];
}

function sortPrinters(list: InstalledPrinter[]): InstalledPrinter[] {
  // USB first (the receipt printer), then the default, then by name.
  return [...list].sort((a, b) =>
    Number(b.usb) - Number(a.usb) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
  );
}

export async function listSpoolerPrinters(
  opts: SpoolerOptions = {},
): Promise<{ printers: InstalledPrinter[]; error?: string }> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const timeoutMs = opts.timeoutMs ?? spoolerTimeoutMs();
  try {
    if (platform === 'win32') {
      const r = await run('powershell.exe', psArgs(WINDOWS_LIST_PRINTERS_SCRIPT), { timeoutMs });
      if (r.timedOut) return { printers: [], error: 'Windows took too long to list printers.' };
      if (r.code !== 0) return { printers: [], error: firstLine(r.stderr) || 'Could not list Windows printers.' };
      const raw = JSON.parse(r.stdout.trim() || '[]') as unknown;
      const rows = (Array.isArray(raw) ? raw : [raw]) as Array<Partial<Record<keyof InstalledPrinter, unknown>>>;
      return {
        printers: sortPrinters(
          rows
            .filter((p) => typeof p.name === 'string' && p.name)
            .map((p) => {
              const port = typeof p.port === 'string' ? p.port : '';
              return {
                name: p.name as string,
                isDefault: p.isDefault === true,
                offline: p.offline === true,
                port,
                usb: /^USB\d+/i.test(port),
              };
            }),
        ),
      };
    }

    // CUPS. `lpstat -p` exits non-zero with "No destinations added" when
    // there are none — that is an empty list, not an error.
    const [p, d, v] = await Promise.all([
      run('lpstat', ['-p'], { timeoutMs }),
      run('lpstat', ['-d'], { timeoutMs }),
      run('lpstat', ['-v'], { timeoutMs }),
    ]);
    if (p.timedOut) return { printers: [], error: 'The print system took too long to list printers.' };
    if (p.code !== 0 && !/no destinations/i.test(p.stderr + p.stdout)) {
      return { printers: [], error: firstLine(p.stderr) || 'Could not list printers.' };
    }
    const def = /destination:\s*(\S+)/.exec(d.stdout)?.[1] ?? null;
    const ports = new Map<string, string>();
    for (const line of v.stdout.split(/\r?\n/)) {
      const m = /^device for (\S+):\s*(\S+)/.exec(line.trim());
      if (m) ports.set(m[1]!, m[2]!);
    }
    const printers: InstalledPrinter[] = [];
    for (const line of p.stdout.split(/\r?\n/)) {
      const m = /^printer (\S+)\s+(.*)$/.exec(line.trim());
      if (!m) continue;
      const port = ports.get(m[1]!) ?? '';
      printers.push({
        name: m[1]!,
        isDefault: m[1] === def,
        offline: /\bdisabled\b/i.test(m[2]!),
        port,
        usb: /^usb:/i.test(port),
      });
    }
    return { printers: sortPrinters(printers) };
  } catch (err) {
    return { printers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// One-click setup for a USB receipt printer that has no driver (Windows).
//
// Windows creates a USB00x port for a USB printer as soon as it is plugged in,
// driver or not; with no driver there is simply no print queue on it, so it
// can't be picked. Counter sends raw ESC/POS bytes, so it needs no vendor
// driver: a queue using Windows' built-in "Generic / Text Only" driver on that
// port is enough. Adding a printer needs administrator rights, so this asks
// Windows once (UAC) and runs elevated. The elevated process can't hand back
// stdout, so it writes its result to a file we name.

export const USB_SETUP_PRINTER_NAME = 'Counter Receipt';
const GENERIC_DRIVER = 'Generic / Text Only';

export type UsbSetupResult =
  | { ok: true; printerName: string; port: string; created: boolean }
  | { ok: false; reason: 'NOT_WINDOWS' | 'NO_USB_PORT' | 'CANCELLED' | 'ERROR'; message: string };

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The script run elevated. Only Counter-chosen values are embedded (the
 *  result file path and fixed names) — nothing the owner typed. */
export function windowsUsbSetupScript(resultFile: string): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$out = ${psQuote(resultFile)}
function Done($obj) { ConvertTo-Json -InputObject $obj -Compress | Set-Content -LiteralPath $out -Encoding UTF8; exit 0 }
try {
  $name = ${psQuote(USB_SETUP_PRINTER_NAME)}
  $existing = Get-Printer -Name $name -ErrorAction SilentlyContinue
  if ($existing) { Done @{ ok = $true; printerName = $name; port = [string]$existing.PortName; created = $false } }
  $used = @(Get-Printer | ForEach-Object { $_.PortName })
  $port = Get-PrinterPort | Where-Object { $_.Name -match '^USB\d+' -and ($used -notcontains $_.Name) } | Sort-Object Name | Select-Object -First 1
  if (-not $port) { Done @{ ok = $false; reason = 'NO_USB_PORT'; message = 'No free USB printer port. Check the printer is switched on and plugged in, then try again.' } }
  if (-not (Get-PrinterDriver -Name ${psQuote(GENERIC_DRIVER)} -ErrorAction SilentlyContinue)) {
    Add-PrinterDriver -Name ${psQuote(GENERIC_DRIVER)}
  }
  Add-Printer -Name $name -DriverName ${psQuote(GENERIC_DRIVER)} -PortName $port.Name
  Done @{ ok = $true; printerName = $name; port = [string]$port.Name; created = $true }
} catch {
  Done @{ ok = $false; reason = 'ERROR'; message = $_.Exception.Message }
}
`;
}

/** Runs in the normal (non-elevated) PowerShell: asks Windows to run the
 *  setup script as administrator and waits for it. */
function windowsElevateScript(setupScript: string): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${psQuote(encodePs(setupScript))})
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
`;
}

export async function setupWindowsUsbPrinter(opts: SpoolerOptions & {
  /** Test hook: read the elevated script's result file. */
  readResult?: (file: string) => Promise<string>;
} = {}): Promise<UsbSetupResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    return { ok: false, reason: 'NOT_WINDOWS', message: 'USB printer setup is for the Windows counter PC. On this computer, add the printer in its printer settings.' };
  }
  const run = opts.run ?? runCommand;
  const readResult = opts.readResult ?? ((f: string) => fs.readFile(f, 'utf8'));
  const resultFile = path.join(os.tmpdir(), `counter-usb-setup-${randomUUID()}.json`);
  try {
    // The owner has to answer the Windows prompt: give them two minutes.
    const r = await run('powershell.exe', psArgs(windowsElevateScript(windowsUsbSetupScript(resultFile))), {
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    if (r.timedOut) return { ok: false, reason: 'CANCELLED', message: 'Windows did not finish the printer setup in time. Try again.' };
    if (r.code !== 0) {
      const why = firstLine(r.stderr);
      return /cancel/i.test(why)
        ? { ok: false, reason: 'CANCELLED', message: 'Setup was cancelled at the Windows prompt. Press Set up again and choose Yes.' }
        : { ok: false, reason: 'ERROR', message: why || 'Windows refused the printer setup.' };
    }
    let text: string;
    try {
      text = await readResult(resultFile);
    } catch {
      return { ok: false, reason: 'ERROR', message: 'Printer setup did not report back. Check Windows Printers & scanners for "Counter Receipt".' };
    }
    const res = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
    if (res['ok'] === true) {
      return {
        ok: true,
        printerName: String(res['printerName'] ?? USB_SETUP_PRINTER_NAME),
        port: String(res['port'] ?? ''),
        created: res['created'] === true,
      };
    }
    return {
      ok: false,
      reason: res['reason'] === 'NO_USB_PORT' ? 'NO_USB_PORT' : 'ERROR',
      message: String(res['message'] ?? 'Printer setup failed.'),
    };
  } catch (err) {
    return { ok: false, reason: 'ERROR', message: err instanceof Error ? err.message : String(err) };
  } finally {
    await fs.unlink(resultFile).catch(() => { /* best effort */ });
  }
}
