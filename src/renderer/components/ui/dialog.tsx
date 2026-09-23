// Dialog — Base UI's modal dialog with Counter's keyboard rules on top.
//
// Base UI owns the parts it does well: focus trapping, the accessible name
// (from DialogTitle), outside-click dismissal, and hiding the page behind
// from screen readers. Counter adds the till's rules:
//
//   - Only the TOPMOST open dialog receives Escape and F1–F12. They are
//     caught in the capture phase and stopped there, so a screen's own window
//     key handlers never see them — Escape in a payment dialog must never
//     also clear the sale underneath.
//   - While `busy` (saving), Escape, F-keys and outside clicks do nothing.
//   - When the dialog goes away, focus returns to whatever had it before.
//
// A dialog that opens on top of another must render INSIDE the other's
// DialogContent (React nesting, not DOM order). Base UI stacks dialogs by
// that tree; rendered side by side, each one hides the other from screen
// readers and their focus traps compete.
//
// Usage — the app mounts dialogs when they are needed, so `open` defaults to
// true and closing is the parent's job:
//
//   {showCash && (
//     <Dialog onClose={() => setShowCash(false)} busy={saving} onShortcut={onKey}>
//       <DialogContent>
//         <DialogHeader><DialogTitle>Cash</DialogTitle></DialogHeader>
//         …
//       </DialogContent>
//     </Dialog>
//   )}

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import {
  createContext, forwardRef, useContext, useLayoutEffect, useMemo, useRef, useState,
  type ComponentPropsWithoutRef, type MutableRefObject, type Ref, type RefObject,
} from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';

interface DialogKeyHandlers {
  onClose?: () => void;
  busy: boolean;
  onShortcut?: (key: string) => void;
}

const DialogKeysContext = createContext<MutableRefObject<DialogKeyHandlers> | null>(null);

export interface DialogProps extends Omit<DialogPrimitive.Root.Props, 'open' | 'onOpenChange'> {
  /** Defaults to true: the app mounts a dialog only while it is open. */
  open?: boolean;
  /** Escape, the close button or a click outside asked to close. */
  onClose?: () => void;
  /** While true, the dialog cannot be dismissed (a save is in flight). */
  busy?: boolean;
  /** F1–F12 pressed while this is the topmost dialog. */
  onShortcut?: (key: string) => void;
}

export function Dialog({
  open = true, onClose, busy = false, onShortcut, disablePointerDismissal, ...props
}: DialogProps) {
  const handlers = useRef<DialogKeyHandlers>({ onClose, busy, onShortcut });
  handlers.current = { onClose, busy, onShortcut };
  return (
    <DialogKeysContext.Provider value={handlers}>
      <DialogPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!next && !handlers.current.busy) handlers.current.onClose?.();
        }}
        disablePointerDismissal={disablePointerDismissal || busy}
        {...props}
      />
    </DialogKeysContext.Provider>
  );
}

/**
 * The till's keyboard rules for one dialog popup. Returns the ref to put on
 * the popup element, which must also carry `data-counter-dialog`.
 * Shared with Sheet.
 */
export function useCounterDialogKeys(): RefObject<HTMLDivElement> {
  const handlers = useContext(DialogKeysContext);
  const popup = useRef<HTMLDivElement>(null);
  // Captured during the first render, before focus moves into the popup.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useLayoutEffect(() => {
    // DOM order is stacking order: every dialog portals to the end of <body>.
    // A popup playing its closing transition no longer counts.
    const isTopmost = () => {
      const open = document.querySelectorAll('[data-counter-dialog]:not([data-closed])');
      return open.length > 0 && open[open.length - 1] === popup.current;
    };
    function onKey(event: KeyboardEvent) {
      if (!popup.current || !isTopmost()) return;
      if (event.key !== 'Escape' && !/^F(?:[1-9]|1[0-2])$/.test(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const h = handlers?.current;
      if (!h || h.busy) return;
      if (event.key === 'Escape') h.onClose?.();
      else h.onShortcut?.(event.key);
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // The app unmounts dialogs outright instead of closing them, so Base
      // UI's own focus return never runs. Put focus back on the opener now,
      // while the popup is still in the document: once it is gone, a parent
      // dialog's focus trap would pull focus to its first field instead.
      const active = document.activeElement;
      const holdsFocus = !active || active === document.body || !!popup.current?.contains(active);
      if (opener?.isConnected && holdsFocus) opener.focus();
      queueMicrotask(() => {
        const now = document.activeElement;
        if (opener?.isConnected && (!now || now === document.body)) opener.focus();
      });
    };
  }, [handlers, opener]);

  return popup;
}

export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as MutableRefObject<T | null>).current = node;
    }
  };
}

export const overlayClasses =
  'fixed inset-0 z-50 bg-scrim transition-opacity duration-(--duration-base) ease-(--ease-standard) data-starting-style:opacity-0 data-ending-style:opacity-0';

export interface DialogContentProps extends DialogPrimitive.Popup.Props {
  /** A corner close button (it answers to Escape too). */
  showCloseButton?: boolean;
  /**
   * Props for the portal element. A dialog opened from inside another one is
   * portaled into its parent's portal; pass `container: document.body` when
   * something (a print stylesheet) needs this one directly under <body>.
   */
  portalProps?: DialogPrimitive.Portal.Props;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { className, children, showCloseButton = true, portalProps, ...props },
  ref,
) {
  const popupRef = useCounterDialogKeys();
  const mergedRef = useMemo(() => mergeRefs(ref, popupRef), [ref, popupRef]);
  return (
    <DialogPrimitive.Portal {...portalProps}>
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className={overlayClasses} />
      <DialogPrimitive.Popup
        ref={mergedRef}
        data-slot="dialog-content"
        data-counter-dialog=""
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-bg-modal p-6 text-text-primary shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-base) ease-(--ease-standard) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" size="icon-sm" aria-label="Close" className="absolute top-3 right-3" />}
          >
            <XIcon aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-lg leading-snug font-semibold', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm text-text-secondary', className)} {...props} />;
}

export const DialogClose = DialogPrimitive.Close;
