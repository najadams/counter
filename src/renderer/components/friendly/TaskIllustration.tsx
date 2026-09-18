// TaskIllustration — the Friendly build's picture set (bottles, crates, cash,
// people, receipts). The SVGs live in assets/illustrations and are bundled
// with the app, so they work with no internet. They are inlined (not <img>) so
// outlines and the soft backdrop follow the active theme; see the
// `.task-illustration` rules in styles/index.css.
//
// Always pair an illustration with visible words — it is decoration, hidden
// from screen readers.

const RAW = import.meta.glob('../../assets/illustrations/*.svg', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, svg]) => [path.replace(/^.*\/(.+)\.svg$/, '$1'), svg]),
);

export type IllustrationName =
  | 'sell' | 'customers' | 'money-out' | 'receive-stock' | 'recent-sales' | 'summary'
  | 'home' | 'stock-tools' | 'orders' | 'manage' | 'close-shift' | 'open-shift'
  | 'cash' | 'momo' | 'credit' | 'split' | 'person' | 'pin' | 'check'
  | 'breakage' | 'drink' | 'reports' | 'settings' | 'approvals' | 'variance'
  | 'paper-receipts' | 'cash-drawer';

export function TaskIllustration({ name, size = 56, className = '' }: {
  name: IllustrationName; size?: number; className?: string;
}) {
  const svg = SOURCES[name];
  if (!svg) return null;
  return (
    <span
      aria-hidden
      data-illustration={name}
      className={`task-illustration inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      // Static, bundled SVG files from this repo — never user content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
