// Client-side CSV export. No backend round-trip — turn rows of objects into
// a downloadable .csv file via a Blob + temporary anchor. Money values are
// passed in cedis (decimal string) so spreadsheets read them as numbers.

export interface CsvColumn<T> {
  /** Header text shown in row 1 of the CSV. */
  header: string;
  /** Cell value — return a string already in the form you want in the file.
   *  For money, format as a plain "5.50" decimal (no currency symbol, no
   *  thousands separator) so Excel/Sheets type-coerces it correctly. */
  get: (row: T) => string | number | null | undefined;
}

function escapeCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // RFC 4180: quote if value contains comma, quote, newline, or CR.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize rows + columns into a CSV string. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escapeCell(c.get(row))).join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}

/** Convert pesewas integer to a plain decimal string "5.50" for CSV. */
export function pesewasToCsvNumber(p: number | null | undefined): string {
  if (p === null || p === undefined) return '';
  const neg = p < 0;
  const abs = Math.abs(Math.trunc(p));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${neg ? '-' : ''}${whole}.${cents.toString().padStart(2, '0')}`;
}

/** Format basis points (1234 = 12.34%) for CSV. */
export function bpsToCsvPercent(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '';
  return (bps / 100).toFixed(2);
}

/** Build a filename like "sales_2026-05-01_2026-05-18.csv" — caller fills in. */
export function buildCsvFilename(prefix: string, parts: ReadonlyArray<string>): string {
  const clean = parts.filter(Boolean).map((p) =>
    p.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''),
  );
  return `${prefix}${clean.length ? '_' + clean.join('_') : ''}.csv`;
}

/** Trigger a browser download of a CSV string. Pure DOM — no native deps. */
export function downloadCsv(filename: string, csv: string): void {
  // BOM so Excel on Windows opens it as UTF-8 (matters for the GHS symbol or
  // any non-ASCII customer name we ever export).
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation so Chromium has time to flush the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One-shot helper: build CSV + trigger download. */
export function exportRowsAsCsv<T>(
  filename: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): void {
  downloadCsv(filename, toCsv(rows, columns));
}
