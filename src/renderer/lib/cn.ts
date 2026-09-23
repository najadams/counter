import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge learns Harbour's own spacing names (p-gutter, gap-section),
// so a caller's className overrides a component's default the same way it
// would for a stock Tailwind class. Colour names (bg-bg-deep, text-ink, …)
// need no help: anything after `bg-`/`text-`/`border-` that is not a size
// is treated as a colour.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { spacing: ['gutter', 'section'] },
  },
});

/** Join class names; a later Tailwind class wins over an earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
