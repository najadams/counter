// ShopTab — what the shop sells, the empties switch, and product categories.
//
// The shop type only sets wording and defaults (src/shared/lib/businessProfile.ts);
// changing it never touches products, stock or money, and never rewrites the
// category list — the owner manages that below. OWNER/FOUNDER change things;
// everyone else sees a read-only view. Main enforces the same gate.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { cn } from '../../lib/cn';
import { useSession } from '../../store/session';
import { useBusiness } from '../../store/business';
import {
  BUSINESS_PROFILES, BUSINESS_PROFILE_DEFS, type BusinessProfile,
} from '../../../shared/lib/businessProfile';
import type { ProductCategoryItem } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

export function ShopTab() {
  const role = useSession((s) => s.workerRole);
  const isAdmin = role === 'OWNER' || role === 'FOUNDER';
  const profile = useBusiness((s) => s.profile);
  const emptiesInUse = useBusiness((s) => s.emptiesInUse);
  const setSettings = useBusiness((s) => s.setSettings);
  const categories = useBusiness((s) => s.categories);
  const loadCategories = useBusiness((s) => s.loadCategories);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');

  useEffect(() => { void loadCategories(); }, [loadCategories]);

  async function save(change: { profile?: BusinessProfile; emptiesInUse?: boolean }) {
    setError(null);
    const r = await counter.businessSetSettings(change);
    if (!r.success) { setError(r.error); return; }
    setSettings({ profile: r.data.profile, emptiesInUse: r.data.emptiesInUse });
  }

  async function addCategory() {
    setError(null);
    const r = await counter.categoryAdd({ label: newLabel });
    if (!r.success) { setError(r.error); return; }
    setNewLabel('');
    await loadCategories();
  }

  async function updateCategory(code: string, change: { label?: string; active?: boolean }) {
    setError(null);
    const r = await counter.categoryUpdate({ code, ...change });
    if (!r.success) { setError(r.error); return; }
    await loadCategories();
  }

  return (
    <div className="max-w-4xl flex flex-col gap-8">
      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <section>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">What the shop sells</h2>
        <div className="grid grid-cols-2 @4xl:grid-cols-3 gap-3" role="radiogroup" aria-label="What the shop sells">
          {BUSINESS_PROFILES.map((p) => {
            const def = BUSINESS_PROFILE_DEFS[p];
            const selected = profile === p;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!isAdmin}
                onClick={() => { if (!selected) void save({ profile: p }); }}
                className={cn(
                  'text-left rounded border px-3 py-2 transition-colors disabled:cursor-not-allowed',
                  selected ? 'border-accent bg-accent/10' : 'border-border hover:border-border-strong',
                )}
              >
                <span className="block text-sm font-medium text-text-primary">{def.label}</span>
                <span className="block text-xs text-text-tertiary">{def.hint}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-text-tertiary mt-3">
          Changes the words staff see, such as “Sell {BUSINESS_PROFILE_DEFS[profile].vocabulary.items}”.
          Products, stock, prices and your category list stay as they are.
        </p>
      </section>

      <section>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Empties</h2>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={emptiesInUse}
            disabled={!isAdmin}
            onCheckedChange={(checked) => void save({ emptiesInUse: checked === true })}
          />
          <span>
            <span className="block text-text-primary">This shop takes deposits on bottles or crates</span>
            <span className="block text-xs text-text-tertiary">
              Shows the returnable and deposit fields on products. A product that already has a
              deposit keeps showing it.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Product categories</h2>
        <div className="panel overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-3">Name</TableHead>
                <TableHead className="px-3 text-right">Products</TableHead>
                <TableHead className="px-3">Shown when adding products</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <CategoryRow key={c.code} category={c} editable={isAdmin} onChange={updateCategory} />
              ))}
            </TableBody>
          </Table>
        </div>
        {isAdmin && (
          <div className="flex gap-2 mt-3 max-w-md">
            <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
              placeholder="New category, e.g. Roofing sheets" aria-label="New category name"
              onKeyDown={(e) => { if (e.key === 'Enter' && newLabel.trim()) void addCategory(); }} />
            <Button variant="secondary" disabled={!newLabel.trim()} onClick={() => void addCategory()}>Add</Button>
          </div>
        )}
        <p className="text-xs text-text-tertiary mt-3">
          Hiding a category only takes it off the product form; products filed under it keep it.
        </p>
      </section>
    </div>
  );
}

function CategoryRow({ category, editable, onChange }: {
  category: ProductCategoryItem;
  editable: boolean;
  onChange: (code: string, change: { label?: string; active?: boolean }) => Promise<void>;
}) {
  const [label, setLabel] = useState(category.label);
  useEffect(() => setLabel(category.label), [category.label]);
  const renamed = label.trim() !== '' && label.trim() !== category.label;

  return (
    <TableRow>
      <TableCell className="px-3 py-2">
        {editable ? (
          <div className="flex gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label={`Name for ${category.label}`}
              onKeyDown={(e) => { if (e.key === 'Enter' && renamed) void onChange(category.code, { label }); }} />
            {renamed && <Button size="sm" variant="secondary" onClick={() => void onChange(category.code, { label })}>Save</Button>}
          </div>
        ) : category.label}
      </TableCell>
      <TableCell className="px-3 py-2 text-right font-mono tnum">{category.productCount}</TableCell>
      <TableCell className="px-3 py-2">
        <Checkbox
          aria-label={`Show ${category.label} when adding products`}
          checked={category.active}
          disabled={!editable || category.code === 'OTHER'}
          onCheckedChange={(checked) => void onChange(category.code, { active: checked === true })}
        />
      </TableCell>
    </TableRow>
  );
}
