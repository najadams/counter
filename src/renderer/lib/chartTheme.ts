// Chart colours from the active theme.
//
// Recharts draws SVG and wants real colour strings in its props, so the
// themed --c-* tokens are read from the document and handed over as rgb()
// values. The hook re-reads them whenever the theme changes, so a chart
// switches with the rest of the app instead of keeping light-theme greys on
// a dark card.

import { useMemo } from 'react';
import { useTheme } from '../store/theme';

export interface ChartTheme {
  /** Eight series colours (--c-chart-1…8), in the order charts use them. */
  series: string[];
  grid: string;
  axis: string;
  /** Tick labels and legend text. */
  label: string;
  /** A zero line or other reference line. */
  reference: string;
  tooltip: { background: string; border: string; borderRadius: number; color: string; fontSize: number; boxShadow: string };
  /** Numbers on axes are money or counts: set them in the mono face. */
  fontMono: string;
}

// Harbour light, for environments without computed styles (tests).
const FALLBACK = {
  series: ['11 110 131', '31 138 76', '194 98 10', '194 58 43', '47 111 209', '91 112 121', '122 79 201', '184 51 106'],
  border: '220 229 232',
  borderStrong: '184 200 205',
  textSecondary: '71 92 100',
  textTertiary: '86 112 122',
  textPrimary: '15 42 51',
  modal: '255 255 255',
  fontMono: 'ui-monospace, monospace',
};

function rgb(channels: string): string {
  return `rgb(${channels.trim().split(/\s+/).join(', ')})`;
}

export function readChartTheme(root: HTMLElement = document.documentElement): ChartTheme {
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    series: FALLBACK.series.map((fallback, i) => rgb(token(`--c-chart-${i + 1}`, fallback))),
    grid: rgb(token('--c-border', FALLBACK.border)),
    axis: rgb(token('--c-border-strong', FALLBACK.borderStrong)),
    label: rgb(token('--c-text-tertiary', FALLBACK.textTertiary)),
    reference: rgb(token('--c-text-secondary', FALLBACK.textSecondary)),
    tooltip: {
      background: rgb(token('--c-bg-modal', FALLBACK.modal)),
      border: `1px solid ${rgb(token('--c-border', FALLBACK.border))}`,
      borderRadius: 8,
      color: rgb(token('--c-text-primary', FALLBACK.textPrimary)),
      fontSize: 12,
      boxShadow: '0 6px 20px rgb(0 0 0 / 0.12)',
    },
    fontMono: style.getPropertyValue('--font-mono').trim() || FALLBACK.fontMono,
  };
}

export function useChartTheme(): ChartTheme {
  const resolved = useTheme((s) => s.resolved);
  // `resolved` is only the trigger: the store sets data-theme before it
  // updates, so the read below sees the new theme's values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readChartTheme(), [resolved]);
}
