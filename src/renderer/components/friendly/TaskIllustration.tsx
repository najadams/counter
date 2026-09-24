// TaskIllustration — the Friendly build's picture set (bottles, crates, cash,
// people, receipts).
//
// Two kinds of picture, same call site:
//
//  • Line drawings — the SVGs in assets/illustrations. They are inlined (not
//    <img>) so outlines and the soft backdrop follow the active theme; see the
//    `.task-illustration` rules in styles/index.css.
//  • Real artwork — an optional raster picture in assets/illustrations/raster.
//    Drop `<name>.webp` (or .png/.jpg) in there and that name renders the
//    picture instead of the line drawing, with no code change. Anything with no
//    raster file keeps its line drawing, so the set can be replaced one picture
//    at a time. See the README in that directory.
//
// Both are bundled with the app, so they work with no internet. Only the
// Friendly bundle pulls the raster art in — the standard build never ships
// those bytes.
//
// Always pair an illustration with visible words — it is decoration, hidden
// from screen readers.

import { FRIENDLY_UI_ENABLED } from '@shared/lib/buildFlags';

const RAW = import.meta.glob('../../assets/illustrations/*.svg', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, svg]) => [path.replace(/^.*\/(.+)\.svg$/, '$1'), svg]),
);

const RASTER: Record<string, string> = FRIENDLY_UI_ENABLED
  ? (import.meta.glob('../../assets/illustrations/raster/*.{webp,png,jpg,jpeg,avif}', {
      query: '?url', import: 'default', eager: true,
    }) as Record<string, string>)
  : {};

const PICTURES: Record<string, string> = Object.fromEntries(
  Object.entries(RASTER).map(([path, url]) => [
    path.replace(/^.*\/(.+)\.(?:webp|png|jpe?g|avif)$/, '$1'),
    url,
  ]),
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
  const classes = `task-illustration inline-block shrink-0 ${className}`;

  const picture = PICTURES[name];
  if (picture) {
    return (
      <span
        aria-hidden
        data-illustration={name}
        data-art="photo"
        className={classes}
        style={{ width: size, height: size }}
      >
        <img src={picture} alt="" draggable={false} />
      </span>
    );
  }

  const svg = SOURCES[name];
  if (!svg) return null;
  return (
    <span
      aria-hidden
      data-illustration={name}
      data-art="line"
      className={classes}
      style={{ width: size, height: size }}
      // Static, bundled SVG files from this repo — never user content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
