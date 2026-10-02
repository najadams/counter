// usePaymentSettings: which ways of moving money this shop uses.
//
// Loaded from main the first time a screen asks, then kept in memory. Until
// it has loaded (or if the read fails) the bank counts as in use — the same
// default main uses — so a payment choice never disappears by accident.

import { useEffect } from 'react';
import { create } from 'zustand';
import { counter } from '../lib/ipc';

interface PaymentSettingsState {
  bankInUse: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves the switch. Resolves to an error message, or null on success. */
  setBankInUse: (bankInUse: boolean) => Promise<string | null>;
}

let inFlight: Promise<void> | null = null;

export const usePaymentSettings = create<PaymentSettingsState>((set, get) => ({
  bankInUse: true,
  loaded: false,
  load: () => {
    if (get().loaded) return Promise.resolve();
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const result = await counter.paymentSettingsGet();
          if (result.success) set({ bankInUse: result.data.bankInUse, loaded: true });
        } catch {
          // Keep the default; the next screen that asks will try again.
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  },
  setBankInUse: async (bankInUse) => {
    const result = await counter.paymentSettingsSet({ bankInUse });
    if (!result.success) return result.error;
    set({ bankInUse: result.data.bankInUse, loaded: true });
    return null;
  },
}));

/** True unless the owner has said the shop doesn't bank. Loads on first use. */
export function useBankInUse(): boolean {
  const bankInUse = usePaymentSettings((s) => s.bankInUse);
  const load = usePaymentSettings((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  return bankInUse;
}
