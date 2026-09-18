// ActionTile — a large illustrated button for the Friendly build. Picture,
// plain-English label, one short line of help, optional count badge and
// keyboard shortcut chip. Works the same with a finger, a mouse or Tab+Enter.

import type { ReactNode } from 'react';
import { TaskIllustration, type IllustrationName } from './TaskIllustration';

export type ActionTileKind = 'primary' | 'default' | 'warn';

export function ActionTile({
  label, caption, illustration, hot, badge, kind = 'default', size = 'regular', onClick,
}: {
  label: string;
  caption?: ReactNode;
  illustration: IllustrationName;
  /** Existing keyboard shortcut, shown as a chip (e.g. "F1"). */
  hot?: string;
  /** Notification count. Hidden when 0 or absent. */
  badge?: number;
  kind?: ActionTileKind;
  size?: 'hero' | 'regular' | 'compact';
  onClick: () => void;
}) {
  const tone =
    kind === 'primary' ? 'bg-accent text-ink border-accent hover:bg-accent-light'
    : kind === 'warn' ? 'bg-bg-elevated text-text-primary border-warning hover:bg-bg-surface'
    : 'bg-bg-elevated text-text-primary border-border hover:border-border-strong hover:bg-bg-surface';
  const pad = size === 'hero' ? 'px-6 py-6 min-h-32 gap-5' : size === 'compact' ? 'px-4 py-3 min-h-16 gap-3' : 'px-5 py-4 min-h-24 gap-4';
  const art = size === 'hero' ? 88 : size === 'compact' ? 40 : 60;
  const labelSize = size === 'hero' ? 'text-3xl' : size === 'compact' ? 'text-lg' : 'text-xl';
  const showBadge = badge !== undefined && badge > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={showBadge ? `${label}, ${badge} waiting` : label}
      className={`relative w-full flex items-center text-left border-2 rounded-2xl shadow-sm transition-colors ${pad} ${tone}`}
    >
      <TaskIllustration name={illustration} size={art} />
      <span className="flex-1 min-w-0">
        <span className={`block font-semibold leading-tight ${labelSize}`}>{label}</span>
        {caption && (
          <span className={`block mt-1 text-lg leading-snug ${kind === 'primary' ? '' : 'text-text-secondary'}`}>{caption}</span>
        )}
      </span>
      {showBadge && (
        <span
          aria-hidden
          className="shrink-0 min-w-9 h-9 px-2 rounded-full bg-warning text-ink text-lg font-bold flex items-center justify-center tnum">
          {badge}
        </span>
      )}
      {hot && (
        <span aria-hidden className="shrink-0 hidden sm:inline-flex"><span className={`kbd ${kind === 'primary' ? 'bg-bg-deep text-accent border-accent' : ''}`}>{hot}</span></span>
      )}
    </button>
  );
}
