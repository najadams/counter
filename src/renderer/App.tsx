// App.tsx — top-level router driven by session state.
//   needs owner setup       -> SetupScreen
//   no worker               -> LoginScreen
//   worker, no shift        -> OpenShiftScreen
//   worker + open shift     -> HomeScreen
//
// Boot sequence is wrapped in try/catch + a 10-second timeout so a stuck
// IPC call surfaces as a visible error instead of an indefinite spinner.

import { useEffect, useState } from 'react';
import { useSession } from './store/session';
import { counter } from './lib/ipc';
import LoginScreen from './screens/LoginScreen';
import OpenShiftScreen from './screens/OpenShiftScreen';
import HomeScreen from './screens/HomeScreen';
import SetupScreen from './screens/SetupScreen';

export default function App() {
  const workerId = useSession((s) => s.workerId);
  const shiftId = useSession((s) => s.shiftId);
  const hydrate = useSession((s) => s.hydrateFromMain);
  const [hydrated, setHydrated] = useState(false);
  const [needsOwner, setNeedsOwner] = useState<boolean | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (!cancelled && !hydrated) {
        setBootError(
          'Boot probe took longer than 10 seconds. The IPC bridge may not be ' +
          'wired up. Open DevTools (⌘⌥I) and check the Console tab.',
        );
      }
    }, 10_000);

    void (async () => {
      try {
        // eslint-disable-next-line no-console
        console.log('[boot] starting setupNeedsOwner probe…');
        if (!window.counter) {
          throw new Error('window.counter is not defined — preload bridge missing.');
        }
        if (typeof window.counter.setupNeedsOwner !== 'function') {
          throw new Error(
            'window.counter.setupNeedsOwner is not a function — preload bundle is stale. ' +
            'Stop the dev server (Ctrl-C) and run: rm -rf dist-electron && npm run dev',
          );
        }
        const probe = await counter.setupNeedsOwner();
        // eslint-disable-next-line no-console
        console.log('[boot] setupNeedsOwner result:', probe);
        if (cancelled) return;
        if (probe.success) setNeedsOwner(probe.data.needsOwner);
        else setNeedsOwner(false);

        // eslint-disable-next-line no-console
        console.log('[boot] hydrating session…');
        await hydrate();
        // eslint-disable-next-line no-console
        console.log('[boot] hydrate done.');
        if (cancelled) return;
        setHydrated(true);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('[boot] failed:', err);
        setBootError(message);
      } finally {
        window.clearTimeout(timeout);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [hydrate]);

  if (bootError) {
    return (
      <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center p-6">
        <div className="max-w-2xl bg-red-950/30 border border-red-900/50 rounded p-6">
          <h1 className="text-xl font-semibold text-red-300 mb-3">Boot failed</h1>
          <pre className="text-sm text-red-200 whitespace-pre-wrap break-words font-mono">
            {bootError}
          </pre>
          <p className="text-xs text-text-tertiary mt-4">
            Open DevTools (⌘⌥I) for the full stack trace. If the dev server keeps showing
            this, stop it (Ctrl-C) and run <code>rm -rf dist-electron && npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!hydrated || needsOwner === null) {
    return (
      <div className="min-h-screen bg-bg-deep text-text-tertiary flex items-center justify-center">
        Loading…
      </div>
    );
  }

  if (needsOwner && !workerId) return <SetupScreen />;
  if (!workerId) return <LoginScreen />;
  if (!shiftId) return <OpenShiftScreen />;
  return <HomeScreen />;
}
