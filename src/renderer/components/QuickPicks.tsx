// Quick picks — the shop's best sellers as one-tap tiles above the sale
// screen's search results (docs/design-system.md, "Quick picks").
//
// The eight drinks sold most at this shop over the last 30 days, by units,
// each in its default sale unit. Alt+1 … Alt+8 add them from the keyboard
// (digits alone would type into search); the sale screen's key list (Help,
// F1) names them once, so the tiles stay clean. The list is fetched once per shift
// and channel and then held, so a tile never moves under a cashier's finger
// mid-shift and the Alt keys stay learnable.

import { formatMoney } from '../../shared/lib/money';
import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
import { cn } from '../lib/cn';

export const QUICK_PICK_COUNT = 8;

export interface QuickPick {
  id: string;
  name: string;
  defaultUnitName: string;
  unitPricePesewas: number;
}

/** Alt+1 … Alt+8 → index 0 … 7. By physical key, so it holds on layouts
 *  where Alt+digit types a symbol (macOS). */
export function quickPickIndex(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const match = /^Digit([1-8])$/.exec(event.code);
  return match ? Number(match[1]) - 1 : null;
}

function unitLabel(unitName: string): string {
  return unitName === 'UNIT' ? 'each' : unitName.toLowerCase();
}

export function QuickPicks({ picks, onPick, announceKeys }: {
  picks: QuickPick[];
  onPick: (index: number) => void;
  /** Announce Alt+N to screen readers (not on touch devices, which have no
   *  Alt key). The keys aren't drawn on the tiles. */
  announceKeys: boolean;
}) {
  // A new shop with no sales yet shows no strip at all.
  if (picks.length === 0) return null;
  return (
    <div role="group" aria-label="Quick picks" className={cn('border-b border-border', FRIENDLY_UI_ENABLED ? 'px-5 py-2.5' : 'px-6 py-3')}>
      <div className="eyebrow mb-2">Quick picks</div>
      {/* Sized by the search pane it sits in (the sale screen makes that pane
          a container): a scrolling row of chips when it's phone-narrow,
          three tiles across from 32rem, four from 42rem. Tiles have a minimum
          height, not a fixed one, and every row matches the tallest, so a
          two-line name is never clipped. Sizes go before leading-* in cn():
          tailwind-merge drops a leading class that a later text-* overrides. */}
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 @lg:grid @lg:auto-rows-fr @lg:grid-cols-3 @lg:overflow-visible @lg:pb-0 @2xl:grid-cols-4">
        {picks.slice(0, QUICK_PICK_COUNT).map((pick, i) => {
          const key = `Alt+${i + 1}`;
          return (
            <li key={pick.id} className="shrink-0 @lg:min-w-0">
              <button
                type="button"
                onClick={() => onPick(i)}
                aria-label={`Add ${pick.name}, ${unitLabel(pick.defaultUnitName)}, ${formatMoney(pick.unitPricePesewas)}`}
                aria-keyshortcuts={announceKeys ? key : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-4 text-left text-text-primary shadow-card transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-accent hover:bg-accent/5 active:translate-y-px',
                  'min-h-11 @lg:h-full @lg:min-h-[84px] @lg:w-full @lg:flex-col @lg:items-stretch @lg:justify-between @lg:gap-0.5 @lg:rounded-xl @lg:px-3 @lg:py-2',
                  FRIENDLY_UI_ENABLED && 'min-h-14 @lg:min-h-24 @lg:px-4 @lg:py-2.5',
                )}
              >
                <span className={cn(FRIENDLY_UI_ENABLED ? 'text-base' : 'text-sm', 'font-semibold leading-tight whitespace-nowrap @lg:line-clamp-2 @lg:whitespace-normal')}>
                  {pick.name}
                </span>
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className={cn('hidden truncate text-text-tertiary @lg:inline', FRIENDLY_UI_ENABLED ? 'text-sm' : 'text-xs')}>
                    {unitLabel(pick.defaultUnitName)}
                  </span>
                  <span className={cn(FRIENDLY_UI_ENABLED ? 'text-lg' : 'text-sm', 'shrink-0 font-mono tnum font-semibold leading-tight whitespace-nowrap text-accent')}>
                    {formatMoney(pick.unitPricePesewas)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
