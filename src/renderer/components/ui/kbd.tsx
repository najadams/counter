import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * A keyboard key: <Kbd>F2</Kbd>. `onAccent` restyles it for use inside a
 * filled (primary or destructive) button, where the default chip would be a
 * light patch on a dark fill.
 */
export function Kbd({ className, onAccent = false, ...props }: ComponentProps<'kbd'> & { onAccent?: boolean }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-6 items-center justify-center rounded-md border px-1.5 font-mono text-[0.72rem] leading-none font-semibold whitespace-nowrap select-none',
        onAccent
          ? 'border-ink/30 bg-ink/15 text-ink'
          : 'border-border-strong bg-bg-elevated text-text-primary',
        className,
      )}
      {...props}
    />
  );
}
