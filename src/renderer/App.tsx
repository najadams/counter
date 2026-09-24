// App.tsx — top-level router driven by session state.
//   not activated           -> ActivationScreen
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
import ActivationScreen from './screens/ActivationScreen';

export default function App() {
  const workerId = useSession((s) => s.workerId);
  const shiftId = useSession((s) => s.shiftId);
  const hydrate = useSession((s) => s.hydrateFromMain);
  const [hydrated, setHydrated] = useState(false);
  const [needsOwner, setNeedsOwner] = useState<boolean | null>(null);
  const [activated, setActivated] = useState<boolean | null>(null);
  const [reactivating, setReactivating] = useState(false);
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
        // The transport is resolved in lib/ipc.ts: window.counter under
        // Electron, an HTTP client in a plain browser (LAN access). Validate
        // the resolved `counter`, not the Electron-only bridge — otherwise
        // browser devices can never boot.
        if (typeof counter?.setupNeedsOwner !== 'function') {
          throw new Error(
            window.counter
              ? 'window.counter.setupNeedsOwner is not a function — preload bundle is stale. ' +
                'Stop the dev server (Ctrl-C) and run: rm -rf dist-electron && npm run dev'
              : 'No Counter transport available — the app could not reach the host server.',
          );
        }
        // Activation gate. Fails OPEN: if the probe errors (an older host over
        // the LAN transport, say) we let the app through rather than strand a
        // shop behind a screen it cannot clear. Policy is warn, never block.
        try {
          const act = await counter.activationStatus();
          if (!cancelled) setActivated(act.success ? act.data.activated : true);
        } catch {
          if (!cancelled) setActivated(true);
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
        <div className="max-w-2xl bg-danger/10 border border-danger/40 rounded p-6">
          <h1 className="text-xl font-semibold text-danger mb-3">Boot failed</h1>
          <pre className="text-sm text-danger-light whitespace-pre-wrap wrap-break-word font-mono">
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

  if (!hydrated || needsOwner === null || activated === null) {
    return (
      <div className="min-h-screen bg-bg-deep text-text-tertiary flex items-center justify-center">
        Loading…
      </div>
    );
  }

  // Activation precedes owner setup: a brand-new install has no shift open
  // and no data to strand, so this is the one safe place to hard-gate.
  if (!activated) return <ActivationScreen onActivated={() => setActivated(true)} />;

  // Re-activation, reached from the mismatch banner. Escapable on purpose: a
  // read-only install must still be able to close its shift and read reports.
  if (reactivating) {
    return (
      <ActivationScreen
        mode="reactivate"
        onActivated={() => { setReactivating(false); window.location.reload(); }}
        onCancel={() => setReactivating(false)}
      />
    );
  }
  if (needsOwner && !workerId) return <SetupScreen />;
  if (!workerId) return <LoginScreen />;
  if (!shiftId) return <OpenShiftScreen />;
  return <HomeScreen onReactivate={() => setReactivating(true)} />;
}
