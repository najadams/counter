import type { ReactNode } from 'react';

type FeedbackTone = 'error' | 'warning' | 'success' | 'info';

const TONE_CLASSES: Record<FeedbackTone, string> = {
  error: 'border-danger/60 bg-danger/10 text-danger',
  warning: 'border-warning/60 bg-warning/10 text-warning',
  success: 'border-success/60 bg-success/10 text-success',
  info: 'border-accent/50 bg-accent/10 text-accent',
};

export function FeedbackBanner({
  tone = 'error',
  children,
  className = '',
}: {
  tone?: FeedbackTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`border px-4 py-3 text-sm leading-relaxed ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </div>
  );
}
