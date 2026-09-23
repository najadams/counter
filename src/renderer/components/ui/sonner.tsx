// Toasts, for short-lived confirmations only ("Receipt reprinted"). Errors,
// and anything staff must act on, stay inline as a FeedbackBanner: a toast
// that fades away is the wrong place for "the sale did not save".
//
// Mount <Toaster /> once near the app root, then call toast.success(...).

import { CircleCheckIcon, InfoIcon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import type { CSSProperties } from 'react';
import { useTheme } from '../../store/theme';

export { toast } from 'sonner';

export function Toaster(props: ToasterProps) {
  const resolved = useTheme((s) => s.resolved);
  return (
    <Sonner
      theme={resolved === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-accent" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-danger" />,
      }}
      style={{
        '--normal-bg': 'rgb(var(--c-bg-modal))',
        '--normal-text': 'rgb(var(--c-text-primary))',
        '--normal-border': 'rgb(var(--c-border))',
        '--border-radius': 'var(--radius-lg)',
        fontFamily: 'var(--font-sans)',
      } as CSSProperties}
      {...props}
    />
  );
}
