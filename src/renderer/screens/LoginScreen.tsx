// LoginScreen: worker picker (left) + PIN pad (right).
// Keyboard-first: arrow keys move worker selection, digits enter PIN,
// Backspace deletes last digit, Enter submits.

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { RecoveryResetModal } from '../components/RecoveryResetModal';

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

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="sign in" />
      <main className="flex-1 grid grid-cols-2 gap-12 px-12 py-10 max-w-5xl mx-auto w-full">
        <section>
          <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-4">Workers</h2>
          {loading && <div className="text-text-tertiary">Loading…</div>}
          {!loading && candidates.length === 0 && (
            <div className="text-text-tertiary">No active workers. Run <span className="kbd">npm run db:reset</span> to seed dev fixtures.</div>
          )}
          <ul className="flex flex-col">
            {candidates.map((c, i) => {
              const active = i === selectedIdx;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedIdx(i); setPin(''); }}
                    className={[
                      'w-full text-left px-5 py-4 border flex items-center justify-between',
                      active
                        ? 'border-accent bg-bg-elevated text-text-primary'
                        : 'border-border bg-bg-surface text-text-primary hover:bg-bg-elevated',
                    ].join(' ')}
                  >
                    <span className="text-base">{c.fullName}</span>
                    <span className="text-text-tertiary text-xs uppercase tracking-wider">{c.role}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 text-text-tertiary text-xs">
            <span className="kbd">↑</span> <span className="kbd">↓</span> select worker
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">PIN</h2>
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
            className="bg-bg-input border border-border-strong px-5 py-4 text-3xl font-mono tnum tracking-[0.5em] text-center focus:outline-none focus:border-accent disabled:opacity-50"
            placeholder="••••"
          />
          <div className="text-text-tertiary text-xs">
            4–6 digits. <span className="kbd">Enter</span> to submit.
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || pin.length < 4 || lockedUntil !== null}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold tracking-wide hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
          {error && (
            <div className="bg-bg-surface border border-danger px-5 py-3 text-danger text-sm">{error}</div>
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
