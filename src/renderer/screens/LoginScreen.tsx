// LoginScreen: worker picker (left) + PIN pad (right).
// Keyboard-first: arrow keys move worker selection, digits enter PIN,
// Backspace deletes last digit, Enter submits.

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { RecoveryResetModal } from '../components/RecoveryResetModal';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
import { NumberPad } from '../components/friendly/NumberPad';
import { TaskIllustration } from '../components/friendly/TaskIllustration';
import { Button } from '../components/ui/button';

interface Candidate { id: string; fullName: string; role: string }

export default function LoginScreen() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const login = useSession((s) => s.login);
  const error = useSession((s) => s.loginError);
  const lockedUntil = useSession((s) => s.loginLockedUntil);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await counter.listLoginCandidates();
      if (cancelled) return;
      setLoading(false);
      if (res.success) setCandidates(res.data.workers);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    pinInputRef.current?.focus();
  }, [selectedIdx]);

  async function submit() {
    if (submitting) return;
    if (pin.length < 4 || pin.length > 6) return;
    const candidate = candidates[selectedIdx];
    if (!candidate) return;
    setSubmitting(true);
    const ok = await login(candidate.id, pin);
    setSubmitting(false);
    if (!ok) {
      setPin('');
      pinInputRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, candidates.length - 1));
      setPin('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      setPin('');
    }
  }

  if (FRIENDLY_UI_ENABLED) {
    const selected = candidates[selectedIdx];
    return (
      <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
        <AppHeader subtitle="Sign in" />
        <main className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10 px-4 py-6 sm:px-10 sm:py-8 max-w-6xl mx-auto w-full">
          <section aria-labelledby="friendly-choose-name" className="panel p-5 sm:p-6">
            <h2 id="friendly-choose-name" className="text-3xl font-semibold mb-1">Choose your name</h2>
            <p className="text-lg text-text-secondary mb-5">Tap your name, or use the arrow keys.</p>
            {loading && <div className="text-lg text-text-secondary">Loading…</div>}
            {!loading && candidates.length === 0 && (
              <div className="text-lg text-text-secondary">No workers yet. Ask the owner to add you in Settings.</div>
            )}
            <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2 gap-3">
              {candidates.map((c, i) => {
                const active = i === selectedIdx;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      aria-label={c.fullName}
                      onClick={() => { setSelectedIdx(i); setPin(''); pinInputRef.current?.focus(); }}
                      className={[
                        'w-full min-h-20 px-4 py-3 rounded-2xl border-2 flex items-center gap-4 text-left',
                        active ? 'border-accent bg-accent/15' : 'border-border bg-bg-elevated hover:border-border-strong',
                      ].join(' ')}
                    >
                      <TaskIllustration name="person" size={52} />
                      <span className="min-w-0 text-xl font-semibold leading-tight wrap-anywhere">{c.fullName}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="friendly-enter-pin" className="panel p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <TaskIllustration name="pin" size={56} />
              <div className="min-w-0">
                <h2 id="friendly-enter-pin" className="text-3xl font-semibold">Enter your PIN</h2>
                {selected && <p className="text-lg text-text-secondary truncate">for {selected.fullName}</p>}
              </div>
            </div>
            <label htmlFor="friendly-pin" className="sr-only">PIN</label>
            <input
              id="friendly-pin"
              ref={pinInputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              disabled={submitting || lockedUntil !== null}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={onKeyDown}
              className="bg-bg-input border-2 border-border-strong rounded-xl px-5 py-4 text-4xl font-mono tnum tracking-[0.5em] text-center focus:outline-hidden focus:border-accent disabled:opacity-50"
              placeholder="••••"
            />
            <p className="text-lg text-text-secondary">Your PIN has 4 to 6 numbers.</p>
            <NumberPad
              label="PIN number pad"
              value={pin}
              onChange={setPin}
              maxLength={6}
              disabled={submitting || lockedUntil !== null}
              onEnter={() => void submit()}
              enterLabel={submitting ? 'Signing in…' : 'Sign in'}
              enterDisabled={pin.length < 4 || !selected}
            />
            {error && <FeedbackBanner className="text-lg">{error}</FeedbackBanner>}
            <button
              type="button"
              onClick={() => setShowRecovery(true)}
              className="self-start min-h-12 text-lg text-text-secondary underline hover:text-accent">
              Owner forgot their PIN?
            </button>
          </section>
        </main>
        {showRecovery && <RecoveryResetModal onClose={() => setShowRecovery(false)} />}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="sign in" />
      <main className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 px-5 py-6 sm:px-12 sm:py-10 max-w-5xl mx-auto w-full">
        <section className="panel p-5 sm:p-6">
          <div className="eyebrow mb-4">Choose your worker profile</div>
          {loading && <div className="text-text-tertiary">Loading…</div>}
          {!loading && candidates.length === 0 && (
            <div className="text-text-tertiary">No active workers. Run <span className="kbd">npm run db:reset</span> to seed dev fixtures.</div>
          )}
          <ul className="flex flex-col gap-2">
            {candidates.map((c, i) => {
              const active = i === selectedIdx;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedIdx(i); setPin(''); }}
                    className={[
                      'w-full text-left px-5 py-4 border rounded-lg flex items-center justify-between min-h-14',
                      active
                        ? 'border-accent bg-accent/10 text-text-primary'
                        : 'border-border bg-bg-elevated text-text-primary hover:bg-bg-surface',
                    ].join(' ')}
                  >
                    <span className="text-base">{c.fullName}</span>
                    <span className="text-text-tertiary text-xs uppercase tracking-wider">{c.role}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hidden sm:block mt-4 text-text-tertiary text-xs">
            <span className="kbd">↑</span> <span className="kbd">↓</span> select worker
          </div>
        </section>

        <section className="panel p-5 sm:p-6 flex flex-col gap-4">
          <div><div className="eyebrow">Secure sign in</div><h2 className="text-xl font-semibold mt-1">Enter your PIN</h2></div>
          <input
            ref={pinInputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            disabled={submitting || lockedUntil !== null}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onKeyDown={onKeyDown}
            className="bg-bg-input border border-border-strong px-5 py-4 text-3xl font-mono tnum tracking-[0.5em] text-center focus:outline-hidden focus:border-accent disabled:opacity-50"
            placeholder="••••"
          />
          <div className="text-text-tertiary text-xs">
            4–6 digits. <span className="kbd">Enter</span> to submit.
          </div>
          <Button variant="primary"
            type="button"
            onClick={() => void submit()}
            disabled={submitting || pin.length < 4 || lockedUntil !== null}
            className="w-full disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
          {error && (
            <FeedbackBanner>{error}</FeedbackBanner>
          )}
          <button
            type="button"
            onClick={() => setShowRecovery(true)}
            className="text-text-tertiary hover:text-accent text-xs underline self-start mt-2">
            Forgot OWNER PIN?
          </button>
        </section>
      </main>
      {showRecovery && <RecoveryResetModal onClose={() => setShowRecovery(false)} />}
    </div>
  );
}
