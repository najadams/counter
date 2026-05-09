// Feedback helpers — short audible beep + screen flash for sale outcomes.
// Web Audio synthesis (no audio files). Safe to call repeatedly.
//
// Browsers require a user gesture before any audio plays. Sale completion
// happens after a button click, so the AudioContext should already be
// unlocked by that point.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
    } catch { return null; }
  }
  return ctx;
}

function tone(frequency: number, durationMs: number, kind: OscillatorType = 'sine'): void {
  const c = getCtx();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = kind;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, c.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, c.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + durationMs / 1000);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + durationMs / 1000 + 0.02);
  } catch {
    // Audio failures are non-fatal; the visual flash is still shown.
  }
}

export function chimeSuccess(): void {
  // Two-note ascending blip — clearly positive.
  tone(880, 90);
  setTimeout(() => tone(1175, 130), 90);
}

export function chimeWarning(): void {
  // Lower buzz, slightly longer — heard but not alarming.
  tone(330, 220, 'square');
}

export function chimeError(): void {
  // Two short low blips.
  tone(220, 120, 'square');
  setTimeout(() => tone(180, 140, 'square'), 130);
}

/** Briefly toggle a className on the body to drive a CSS flash. Caller
 *  must have CSS rules like `body.flash-success { ... }` somewhere. */
export function flashBody(className: string, durationMs = 600): void {
  if (typeof document === 'undefined') return;
  document.body.classList.add(className);
  window.setTimeout(() => document.body.classList.remove(className), durationMs);
}
