// DataTransferTab — selective catalog export + import.
//
// Export: writes a portable JSON file containing master data (products,
// units, suppliers, customers, pricing tiers, price overrides). Sales and
// operational history are NOT exported here — use the full-DB backup
// (BackupsTab) for that.
//
// Import: pick a file, see a dry-run report (what would change per table),
// then confirm to apply inside a single transaction. By default existing
// rows matched by natural key are left alone; "update existing" overwrites
// non-key fields on matched rows too.
//
// OWNER / FOUNDER only. Audited.

import { useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import type {
  CatalogImportPickResponse, CatalogImportTableReport, CatalogTable,
} from '../../../shared/types/ipc';

type BannerKind = 'success' | 'warning' | 'danger' | 'info';
interface InlineMessage { kind: BannerKind; text: string }

const ALL_TABLES: { key: CatalogTable; label: string; description: string }[] = [
  { key: 'suppliers',  label: 'Suppliers',  description: 'Names, contacts, payment terms.' },
  { key: 'products',   label: 'Products',   description: 'SKU, name, prices, reorder settings.' },
  { key: 'productUnits', label: 'Product units', description: 'CRATE, PACK, BOTTLE etc. with conversion factors.' },
  { key: 'pricingTiers', label: 'Volume pricing tiers', description: 'Buy-N-get-this-price rules.' },
  { key: 'customers',  label: 'Customers',  description: 'Names, phones, credit limits. Balances are NOT exported.' },
  { key: 'customerPriceOverrides', label: 'Customer price overrides', description: 'Hand-shaken VIP prices.' },
];

export function DataTransferTab() {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [selected, setSelected] = useState<Set<CatalogTable>>(new Set(ALL_TABLES.map((t) => t.key)));
  const [includeInactive, setIncludeInactive] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<InlineMessage | null>(null);

  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<InlineMessage | null>(null);
  const [pickResult, setPickResult] = useState<CatalogImportPickResponse | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyReport, setApplyReport] = useState<CatalogImportTableReport[] | null>(null);

  function toggle(key: CatalogTable) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runExport() {
    if (selected.size === 0) {
      setExportMessage({ kind: 'warning', text: 'Pick at least one table to export.' });
      return;
    }
    setExporting(true);
    setExportMessage(null);
    const r = await counter.catalogExport({
      tables: Array.from(selected),
      includeInactive,
    });
    setExporting(false);
    if (!r.success) {
      setExportMessage({ kind: 'danger', text: 'Export failed: ' + r.error });
      return;
    }
    if (r.data.cancelled) {
      setExportMessage({ kind: 'info', text: 'Cancelled.' });
      return;
    }
    const total = Object.values(r.data.counts).reduce((a, b) => a + (b ?? 0), 0);
    setExportMessage({
      kind: 'success',
      text: `Wrote ${total.toLocaleString()} rows (${formatBytes(r.data.sizeBytes)}) to ${r.data.filePath}`,
    });
  }

  async function runPick() {
    setImporting(true);
    setImportMessage(null);
    setPickResult(null);
    setApplyReport(null);
    const r = await counter.catalogImportPick();
    setImporting(false);
    if (!r.success) {
      setImportMessage({ kind: 'danger', text: 'Could not analyse file: ' + r.error });
      return;
    }
    if (r.data.cancelled) {
      setImportMessage({ kind: 'info', text: 'Cancelled.' });
      return;
    }
    if (r.data.error) {
      setImportMessage({ kind: 'danger', text: r.data.error });
      return;
    }
    setPickResult(r.data);
    setUpdateExisting(false);
  }

  async function runApply() {
    if (!pickResult || !pickResult.filePath) return;
    setApplying(true);
    setImportMessage(null);
    const r = await counter.catalogImportApply({
      filePath: pickResult.filePath,
      updateExisting,
    });
    setApplying(false);
    if (!r.success) {
      setImportMessage({ kind: 'danger', text: 'Import failed: ' + r.error });
      return;
    }
    if (!r.data.ok) {
      setImportMessage({ kind: 'danger', text: 'Import failed: ' + (r.data.error ?? 'unknown error') });
      return;
    }
    setApplyReport(r.data.report);
    const totals = sumReport(r.data.report);
    setImportMessage({
      kind: 'success',
      text:
        `Done in ${r.data.durationMs} ms. Inserted ${totals.inserted}, ` +
        `updated ${totals.updated}, matched-and-left-alone ${totals.matchedLeft}, ` +
        `skipped ${totals.skipped}.`,
    });
    // After a successful apply, drop the pick state so the user can't
    // accidentally re-apply the same file by clicking Apply again.
    setPickResult(null);
  }

  if (!isOwner) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-text-secondary">
          Only OWNER or FOUNDER can export or import catalog data.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl flex flex-col gap-8">
      {/* ---------- EXPORT ---------- */}
      <section className="space-y-3">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Export catalog</h2>
        <p className="text-xs text-text-tertiary">
          Writes a portable JSON file containing the tables you tick. Sales,
          stock movements, audit log, workers, and shifts are <em>not</em>{' '}
          included — use Backups for a full database snapshot.
        </p>

        <fieldset className="space-y-2 border border-border-subtle p-3">
          <legend className="px-1 text-xs uppercase tracking-wider text-text-tertiary">Tables</legend>
          {ALL_TABLES.map((t) => (
            <label key={t.key} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(t.key)}
                onChange={() => toggle(t.key)}
                className="mt-1"
              />
              <span>
                <span className="text-text-primary">{t.label}</span>
                <span className="block text-xs text-text-tertiary">{t.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          <span>Include inactive rows (deactivated products, units, etc.)</span>
        </label>

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => void runExport()}
            disabled={exporting || selected.size === 0}
            className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export to file'}
          </button>
          <span className="text-xs text-text-tertiary">
            You'll be prompted for a location to save the .json file.
          </span>
        </div>
        {exportMessage && <Inline {...exportMessage} />}
      </section>

      {/* ---------- IMPORT ---------- */}
      <section className="space-y-3 border-t border-border-subtle pt-6">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Import catalog</h2>
        <p className="text-xs text-text-tertiary">
          Pick a JSON file produced by Export. You'll see a dry-run report —
          nothing is written until you click <strong>Apply</strong>. By default,
          rows that match an existing record by natural key (SKU, phone,
          supplier name, unit name) are left untouched and only missing rows
          are inserted.
        </p>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void runPick()}
            disabled={importing}
            className="border border-border px-4 py-2 hover:bg-bg-elevated disabled:opacity-50"
          >
            {importing ? 'Reading…' : 'Pick file to import'}
          </button>
        </div>

        {pickResult && pickResult.header && pickResult.report && (
          <div className="space-y-3 bg-bg-surface border border-border p-4">
            <div className="text-xs text-text-tertiary">
              <div><span className="font-semibold text-text-secondary">File:</span> <span className="font-mono break-all">{pickResult.filePath}</span> ({formatBytes(pickResult.sizeBytes ?? 0)})</div>
              <div><span className="font-semibold text-text-secondary">Exported:</span> {pickResult.header.exportedAt}</div>
              <div><span className="font-semibold text-text-secondary">From:</span> {pickResult.header.source.shopName ?? '(no shop name)'} · device {pickResult.header.source.deviceId}</div>
            </div>

            <ReportTable rows={pickResult.report} />

            <label className="flex items-start gap-2 text-sm cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={updateExisting}
                onChange={(e) => setUpdateExisting(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="text-text-primary">Update existing rows</span>
                <span className="block text-xs text-text-tertiary">
                  Overwrite fields on rows that already exist on this counter
                  (matched by natural key). Off = only insert missing rows.
                </span>
              </span>
            </label>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => void runApply()}
                disabled={applying}
                className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-50"
              >
                {applying ? 'Applying…' : updateExisting ? 'Apply (insert + update)' : 'Apply (insert only)'}
              </button>
              <button
                onClick={() => { setPickResult(null); setImportMessage(null); }}
                disabled={applying}
                className="border border-border px-4 py-2 hover:bg-bg-elevated disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {applyReport && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-text-secondary">Apply result</div>
            <ReportTable rows={applyReport} appliedView />
          </div>
        )}

        {importMessage && <Inline {...importMessage} />}
      </section>

      <section className="text-xs text-text-tertiary border-t border-border-subtle pt-4 space-y-2">
        <p>
          Both export and import are recorded in the audit log. Imports run
          inside a single transaction — if any row fails the whole import is
          rolled back.
        </p>
      </section>
    </div>
  );
}

function ReportTable({
  rows, appliedView = false,
}: { rows: CatalogImportTableReport[]; appliedView?: boolean }) {
  return (
    <div className="border border-border-subtle overflow-x-auto">
      <table className="w-full text-sm tnum">
        <thead className="bg-bg-elevated text-xs uppercase tracking-wider text-text-tertiary">
          <tr>
            <th className="text-left px-3 py-2">Table</th>
            <th className="text-right px-3 py-2">In file</th>
            <th className="text-right px-3 py-2">{appliedView ? 'Inserted' : 'To insert'}</th>
            <th className="text-right px-3 py-2">{appliedView ? 'Updated' : 'To update'}</th>
            <th className="text-right px-3 py-2">Matched</th>
            <th className="text-right px-3 py-2">Skipped</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.table} className="border-t border-border-subtle">
              <td className="px-3 py-2 font-mono">{r.table}</td>
              <td className="text-right px-3 py-2">{r.inFile}</td>
              <td className="text-right px-3 py-2">{r.toInsert}</td>
              <td className="text-right px-3 py-2">{r.toUpdate}</td>
              <td className="text-right px-3 py-2">{r.matched}</td>
              <td className={'text-right px-3 py-2 ' + (r.skipped > 0 ? 'text-warning font-semibold' : '')}>{r.skipped}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((r) => r.warnings.length > 0) && (
        <div className="border-t border-border-subtle p-3 text-xs space-y-2 bg-bg-surface">
          {rows.filter((r) => r.warnings.length > 0).map((r) => (
            <details key={r.table} className="text-text-secondary">
              <summary className="cursor-pointer font-mono">
                {r.table}: {r.skipped} skipped — show reasons
              </summary>
              <ul className="list-disc pl-6 mt-1 space-y-0.5">
                {r.warnings.map((w, i) => <li key={i}>{w}</li>)}
                {r.skipped > r.warnings.length && (
                  <li className="text-text-tertiary">
                    …and {r.skipped - r.warnings.length} more (truncated).
                  </li>
                )}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function Inline({ kind, text }: InlineMessage) {
  const cls =
    kind === 'success' ? 'border-success bg-success/10 text-success'
    : kind === 'warning' ? 'border-warning bg-warning/10 text-warning'
    : kind === 'info' ? 'border-border bg-bg-elevated text-text-secondary'
    : 'border-danger bg-danger/10 text-danger';
  return <div className={'border ' + cls + ' px-3 py-2 text-xs break-all'}>{text}</div>;
}

function sumReport(rows: CatalogImportTableReport[]) {
  const inserted = rows.reduce((a, r) => a + r.toInsert, 0);
  const updated = rows.reduce((a, r) => a + r.toUpdate, 0);
  const matchedLeft = rows.reduce((a, r) => a + Math.max(r.matched - r.toUpdate, 0), 0);
  const skipped = rows.reduce((a, r) => a + r.skipped, 0);
  return { inserted, updated, matchedLeft, skipped };
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export default DataTransferTab;
