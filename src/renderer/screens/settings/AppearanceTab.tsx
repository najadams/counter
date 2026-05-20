// AppearanceTab — light/dark theme switcher.
//
// Persistence and the synchronous boot script that prevents FOUC live in
// src/renderer/store/theme.ts and index.html. This tab is purely the UI
// for picking between Dark, Light, and System (follow OS).

import type { ReactNode } from 'react';
import { useTheme } from '../../store/theme';

export function AppearanceTab() {
  const choice = useTheme((s) => s.choice);
  const resolved = useTheme((s) => s.resolved);
  const setChoice = useTheme((s) => s.setChoice);

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <section>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Theme</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <ThemeCard
            label="Dark"
            description="Original. Sharp gold on near-black."
            active={choice === 'dark'}
            onClick={() => setChoice('dark')}
            swatch={<Swatch bg="#0A0C10" fg="#EDE8DF" accent="#C9A84C" border="#3A4150" />}
          />
          <ThemeCard
            label="Light"
            description="Warm parchment. Darker gold for legibility."
            active={choice === 'light'}
            onClick={() => setChoice('light')}
            swatch={<Swatch bg="#F6F3EB" fg="#1A1C20" accent="#B28A38" border="#A8A394" />}
          />
          <ThemeCard
            label="Violet"
            description="Modern. Cool grey with vivid violet accent."
            active={choice === 'violet'}
            onClick={() => setChoice('violet')}
            swatch={<Swatch bg="#EDEDF3" fg="#121218" accent="#7C3AED" border="#C4C4D2" />}
          />
          <ThemeCard
            label="System"
            description={`Follow OS · currently ${resolved}.`}
            active={choice === 'system'}
            onClick={() => setChoice('system')}
            swatch={<DiagonalSwatch />}
          />
        </div>
      </section>

      <section className="text-xs text-text-tertiary border-t border-border-subtle pt-4">
        <p className="mb-2">
          The choice is remembered on this device only. Printed receipts and the
          worker-handbook print view always use white paper with black ink, regardless
          of the screen theme.
        </p>
        <p>
          If a colour reads oddly on your monitor, flip the theme and tell the team —
          counter palette adjustments belong in <span className="font-mono">tailwind.config.js</span> and{' '}
          <span className="font-mono">src/renderer/styles/index.css</span>, not per-component.
        </p>
      </section>
    </div>
  );
}

function ThemeCard({
  label, description, active, onClick, swatch,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
  swatch: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex flex-col text-left border p-4 transition-colors',
        active
          ? 'border-accent bg-bg-elevated'
          : 'border-border bg-bg-surface hover:bg-bg-elevated',
      ].join(' ')}
    >
      <div className="mb-3">{swatch}</div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        {active && <span className="text-[10px] uppercase tracking-wider text-accent">Active</span>}
      </div>
      <span className="text-xs text-text-tertiary mt-1">{description}</span>
    </button>
  );
}

function Swatch({ bg, fg, accent, border }: { bg: string; fg: string; accent: string; border: string }) {
  return (
    <div
      className="w-full h-16 border flex items-end gap-1 p-2"
      style={{ background: bg, borderColor: border }}>
      <span className="block w-6 h-3" style={{ background: accent }} />
      <span className="block w-10 h-2" style={{ background: fg, opacity: 0.7 }} />
      <span className="block w-4 h-2" style={{ background: fg, opacity: 0.4 }} />
    </div>
  );
}

function DiagonalSwatch() {
  return (
    <div className="w-full h-16 border border-border-strong relative overflow-hidden">
      <div className="absolute inset-0" style={{ background: '#0A0C10' }} />
      <div
        className="absolute inset-0"
        style={{
          background: '#F6F3EB',
          clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
        }} />
      <span
        className="absolute left-2 top-2 block w-6 h-3"
        style={{ background: '#C9A84C' }} />
      <span
        className="absolute right-2 bottom-2 block w-6 h-3"
        style={{ background: '#B28A38' }} />
    </div>
  );
}

