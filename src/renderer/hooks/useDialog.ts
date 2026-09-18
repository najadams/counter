import { useLayoutEffect, useRef, useState } from 'react';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** Only the last mounted dialog in DOM order receives navigation keys.
 * Capture phase prevents the till's window shortcuts from acting underneath. */
export function useDialog({ onClose, busy = false, onShortcut }: {
  onClose: () => void;
  busy?: boolean;
  onShortcut?: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy, onShortcut });
  latest.current = { onClose, busy, onShortcut };
  // Capture before React applies autoFocus to the dialog's inputs.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const root: HTMLDivElement = ref.current;
    const top = () => Array.from(document.querySelectorAll('[data-counter-dialog]')).at(-1) === root;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => !el.closest('[hidden], [inert]') && !el.matches(':disabled'))
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const focusFirst = () => (controls()[0] ?? root).focus();
    if (top() && !root.contains(document.activeElement)) focusFirst();
    function onKey(e: KeyboardEvent) {
      if (!top()) return;
      if (e.key === 'Escape' || /^F(?:[1-9]|1[0-2])$/.test(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (latest.current.busy) return;
        if (e.key === 'Escape') latest.current.onClose();
        else latest.current.onShortcut?.(e.key);
      } else if (e.key === 'Tab') {
        const items = controls();
        const first = items[0] ?? root;
        const last = items.at(-1) ?? root;
        if (!items.length || !root.contains(document.activeElement) ||
            (e.shiftKey && document.activeElement === first) ||
            (!e.shiftKey && document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    }
    function onFocus(e: FocusEvent) {
      if (top() && !root.contains(e.target as Node)) focusFirst();
    }
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      queueMicrotask(() => { if (opener?.isConnected) opener.focus(); });
    };
  }, [opener]);
  return { ref, 'data-counter-dialog': '', tabIndex: -1, role: 'dialog', 'aria-modal': true as const };
}
