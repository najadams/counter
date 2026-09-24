// The sale screen's keyboard shortcuts, behind the header's Help button (F1).
// They used to sit as a row of hints under the search box; listing them here
// gives that room back to the drinks. The keys themselves are handled by
// SaleScreen — this only tells people about them.

import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Kbd } from './ui/kbd';

export interface SaleKey {
  keys: string[];
  action: string;
}

/** What each key does on the sale screen, in the order a sale runs. */
export function saleKeys(quickPickCount: number): SaleKey[] {
  return [
    { keys: ['↑', '↓'], action: 'Move through the list' },
    { keys: ['Enter'], action: FRIENDLY_UI_ENABLED ? 'Add the highlighted drink' : 'Add the highlighted product' },
    ...(quickPickCount > 0 ? [{ keys: [`Alt+1–${quickPickCount}`], action: 'Add a quick pick' }] : []),
    { keys: ['F4'], action: 'Pay with cash' },
    { keys: ['F5'], action: 'Pay with MoMo' },
    { keys: ['F6'], action: FRIENDLY_UI_ENABLED ? 'Pay later (credit)' : 'Pay on credit' },
    { keys: ['F2'], action: FRIENDLY_UI_ENABLED ? 'Take payment' : 'Complete the sale' },
    { keys: ['F8'], action: 'Print the last receipt' },
    { keys: ['F9'], action: FRIENDLY_UI_ENABLED ? 'Go home' : 'Back to home' },
    { keys: ['Esc'], action: 'Clear the cart' },
    { keys: ['F1'], action: 'Show this list' },
  ];
}

export function SaleKeysDialog({ quickPickCount, onClose }: { quickPickCount: number; onClose: () => void }) {
  return (
    <Dialog onClose={onClose} onShortcut={(key) => { if (key === 'F1') onClose(); }}>
      <DialogContent className={FRIENDLY_UI_ENABLED ? 'w-[min(36rem,calc(100%-2rem))]' : undefined}>
        <DialogHeader>
          <DialogTitle className={FRIENDLY_UI_ENABLED ? 'text-2xl' : undefined}>
            {FRIENDLY_UI_ENABLED ? 'Keys you can press' : 'Keyboard shortcuts'}
          </DialogTitle>
          <DialogDescription className={FRIENDLY_UI_ENABLED ? 'text-base' : undefined}>
            {FRIENDLY_UI_ENABLED ? 'Everything here can also be done by tapping.' : 'These work anywhere on the sale screen.'}
          </DialogDescription>
        </DialogHeader>
        <dl className={FRIENDLY_UI_ENABLED
          ? 'grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-2.5 text-lg'
          : 'grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm'}>
          {saleKeys(quickPickCount).map(({ keys, action }) => (
            <div key={action} className="contents">
              <dt className="flex gap-1">
                {keys.map((k) => <Kbd key={k} className={FRIENDLY_UI_ENABLED ? 'h-7 min-w-8 px-2 text-sm' : 'h-6 min-w-7 px-2 text-xs'}>{k}</Kbd>)}
              </dt>
              <dd className="text-text-secondary">{action}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
