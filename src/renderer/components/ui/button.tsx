import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';
import { Kbd } from './kbd';

// A native <button>, deliberately: a plain button inside a <form> still
// submits it, exactly as every button in the app did before this component.
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded border font-semibold whitespace-nowrap select-none transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none focus-visible:ring-3 focus-visible:ring-accent/40 active:not-disabled:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        /** The one main action on a screen or in a dialog. */
        primary: 'border-accent bg-accent text-ink hover:not-disabled:border-accent-light hover:not-disabled:bg-accent-light',
        /** Everything else that deserves a visible button. */
        secondary: 'border-border-strong bg-bg-elevated text-text-primary hover:not-disabled:bg-bg-surface',
        /** Low-emphasis actions inside dense rows and toolbars. */
        ghost: 'border-transparent bg-transparent text-text-secondary hover:not-disabled:bg-bg-surface hover:not-disabled:text-text-primary',
        /** Declines, dismissals and other actions that need a second look. */
        danger: 'border-danger bg-transparent text-danger hover:not-disabled:bg-danger/10',
        /** Resolves and approvals that are not the screen's main action. */
        success: 'border-success bg-transparent text-success hover:not-disabled:bg-success/10',
        /** Something is waiting for this person (pending approvals, open cases). */
        warning: 'border-warning bg-transparent text-warning hover:not-disabled:bg-warning/10',
        /** A filled danger button: the confirming step of something irreversible. */
        destructive: 'border-danger bg-danger text-ink hover:not-disabled:bg-danger/90',
        link: 'border-transparent bg-transparent text-accent underline underline-offset-3 hover:not-disabled:text-accent-dim',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-5 text-base',
        xl: 'h-14 px-6 text-lg',
        icon: 'size-10',
        'icon-sm': 'size-8',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ComponentPropsWithoutRef<'button'>,
    VariantProps<typeof buttonVariants> {
  /**
   * The key that also triggers this action, shown as a chip after the label
   * ("F2", "Esc", "Alt+1") and announced through aria-keyshortcuts. The
   * screen still owns the key handler; this only tells people about it.
   */
  shortcut?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, shortcut, children, ...props },
  ref,
) {
  const filled = variant === 'primary' || variant === 'destructive';
  return (
    <button
      ref={ref}
      data-slot="button"
      aria-keyshortcuts={shortcut ? ariaKey(shortcut) : undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      {shortcut && <Kbd onAccent={filled} aria-hidden="true">{shortcut}</Kbd>}
    </button>
  );
});

/** "Esc" → "Escape": aria-keyshortcuts wants the KeyboardEvent.key name. */
function ariaKey(shortcut: string): string {
  return shortcut.replace(/\bEsc\b/, 'Escape');
}
