// Sheet — a dialog that slides in from an edge: the checkout on a touch till,
// filters or detail on a phone. Same keyboard rules as Dialog (topmost-only
// Escape and F-keys, busy lock, focus return) because it IS a Dialog.

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import { forwardRef, useMemo, type ComponentPropsWithoutRef } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { Dialog, mergeRefs, overlayClasses, useCounterDialogKeys } from './dialog';

export { Dialog as Sheet };
export type { DialogProps as SheetProps } from './dialog';

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 overflow-y-auto border-border bg-bg-modal p-6 text-text-primary shadow-overlay outline-none transition-[opacity,translate] duration-(--duration-base) ease-(--ease-standard) data-starting-style:opacity-0 data-ending-style:opacity-0',
  {
    variants: {
      side: {
        right: 'inset-y-0 right-0 h-full w-[min(28rem,100%)] rounded-l-2xl border-l data-starting-style:translate-x-10 data-ending-style:translate-x-10',
        left: 'inset-y-0 left-0 h-full w-[min(28rem,100%)] rounded-r-2xl border-r data-starting-style:-translate-x-10 data-ending-style:-translate-x-10',
        bottom: 'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-2xl border-t data-starting-style:translate-y-10 data-ending-style:translate-y-10',
        top: 'inset-x-0 top-0 max-h-[90dvh] rounded-b-2xl border-b data-starting-style:-translate-y-10 data-ending-style:-translate-y-10',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export interface SheetContentProps extends DialogPrimitive.Popup.Props {
  side?: 'right' | 'left' | 'bottom' | 'top';
  showCloseButton?: boolean;
}

export const SheetContent = forwardRef<HTMLDivElement, SheetContentProps>(function SheetContent(
  { className, children, side = 'right', showCloseButton = true, ...props },
  ref,
) {
  const popupRef = useCounterDialogKeys();
  const mergedRef = useMemo(() => mergeRefs(ref, popupRef), [ref, popupRef]);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop data-slot="sheet-overlay" className={overlayClasses} />
      <DialogPrimitive.Popup
        ref={mergedRef}
        data-slot="sheet-content"
        data-side={side}
        data-counter-dialog=""
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" size="icon-sm" aria-label="Close" className="absolute top-3 right-3" />}
          >
            <XIcon aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
});

export function SheetHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sheet-footer" className={cn('mt-auto flex flex-col gap-2', className)} {...props} />;
}

export function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn('text-lg leading-snug font-semibold', className)} {...props} />;
}

export function SheetDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn('text-sm text-text-secondary', className)} {...props} />;
}
