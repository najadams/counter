// Capability-based touch detection for the phone till.
//
// We key the touch checkout off `pointer: coarse` (a finger), NOT screen width.
// The desktop counter PC reports `fine` even in a narrow window, so it keeps the
// keyboard-first flow; a phone/tablet reports `coarse` and gets the touch sheet.
//
// Dev/override: `?touch=1` forces touch on, `?touch=0` forces desktop off; the
// choice persists in localStorage so you can exercise the sheet on a desktop
// without a phone. Absent override = live capability detection.

import { useEffect, useState } from 'react';

const OVERRIDE_KEY = 'counter.touchOverride';

/** Returns true (force touch), false (force desktop), or null (no override). */
function readOverride(): boolean | null {
  try {
    const q = new URL(window.location.href).searchParams.get('touch');
    if (q === '1') { localStorage.setItem(OVERRIDE_KEY, '1'); return true; }
    if (q === '0') { localStorage.setItem(OVERRIDE_KEY, '0'); return false; }
    const stored = localStorage.getItem(OVERRIDE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // URL/localStorage unavailable — fall through to capability detection.
  }
  return null;
}

function detect(): boolean {
  const o = readOverride();
  if (o !== null) return o;
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

export function useIsTouch(): boolean {
  const [isTouch, setIsTouch] = useState<boolean>(detect);

  useEffect(() => {
    if (readOverride() !== null) { setIsTouch(detect()); return; }
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = (): void => setIsTouch(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isTouch;
}
