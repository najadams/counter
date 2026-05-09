// useSession: which worker is logged in, which shift (if any) is open.
//
// The renderer never holds the PIN. login() takes (workerId, pin), calls
// IPC, and only stores the workerId + display fields if successful.

import { create } from 'zustand';
import { counter } from '../lib/ipc';

export interface SessionState {
  // Auth
  workerId: string | null;
  workerName: string | null;
  workerRole: string | null;

  // Open shift cache
  shiftId: string | null;
  shiftOpenedAt: string | null;
  shiftOpeningCashPesewas: number | null;

  // Login flow result
  loginError: string | null;
  loginAttemptsRemaining: number | null;
  loginLockedUntil: string | null;

  // Actions
  hydrateFromMain: () => Promise<void>;
  login: (workerId: string, pin: string) => Promise<boolean>;
  logout: () => Promise<void>;
  setOpenShift: (
    shiftId: string,
    openedAt: string,
    openingCashPesewas: number,
  ) => void;
  clearShift: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  workerId: null,
  workerName: null,
  workerRole: null,
  shiftId: null,
  shiftOpenedAt: null,
  shiftOpeningCashPesewas: null,
  loginError: null,
  loginAttemptsRemaining: null,
  loginLockedUntil: null,

  hydrateFromMain: async () => {
    const me = await counter.getCurrentWorker();
    if (me.success && me.data.workerId !== null) {
      set({
        workerId: me.data.workerId,
        workerName: me.data.fullName,
        workerRole: me.data.role,
      });
      const shift = await counter.getOpenShift();
      if (shift.success && shift.data.open) {
        set({
          shiftId: shift.data.shiftId,
          shiftOpenedAt: shift.data.openedAt,
          shiftOpeningCashPesewas: shift.data.openingCashPesewas,
        });
      }
    }
  },

  login: async (workerId, pin) => {
    set({ loginError: null, loginAttemptsRemaining: null, loginLockedUntil: null });
    const res = await counter.login(workerId, pin);
    if (!res.success) {
      set({ loginError: res.error });
      return false;
    }
    const r = res.data;
    if (r.ok) {
      set({
        workerId: r.workerId,
        workerName: r.fullName,
        workerRole: r.role,
        loginError: null,
        loginAttemptsRemaining: null,
        loginLockedUntil: null,
      });
      // After login, refresh open-shift state.
      const shift = await counter.getOpenShift();
      if (shift.success && shift.data.open) {
        set({
          shiftId: shift.data.shiftId,
          shiftOpenedAt: shift.data.openedAt,
          shiftOpeningCashPesewas: shift.data.openingCashPesewas,
        });
      } else {
        set({ shiftId: null, shiftOpenedAt: null, shiftOpeningCashPesewas: null });
      }
      return true;
    }
    // Login failed — surface the reason.
    switch (r.reason) {
      case 'INVALID_PIN':
        set({
          loginError: `Wrong PIN. ${r.attemptsRemaining} attempt${r.attemptsRemaining === 1 ? '' : 's'} remaining before lockout.`,
          loginAttemptsRemaining: r.attemptsRemaining,
        });
        break;
      case 'LOCKED_OUT':
        set({
          loginError: `Locked out until ${new Date(r.lockedUntil).toLocaleTimeString()}. Ask a supervisor to reset.`,
          loginLockedUntil: r.lockedUntil,
        });
        break;
      case 'UNKNOWN_WORKER':
        set({ loginError: 'Unknown worker. Pick from the list.' });
        break;
      case 'SYSTEM_ROLE_REJECTED':
        set({ loginError: 'SYSTEM accounts cannot log in.' });
        break;
    }
    return false;
  },

  logout: async () => {
    await counter.logout();
    set({
      workerId: null,
      workerName: null,
      workerRole: null,
      shiftId: null,
      shiftOpenedAt: null,
      shiftOpeningCashPesewas: null,
      loginError: null,
      loginAttemptsRemaining: null,
      loginLockedUntil: null,
    });
  },

  setOpenShift: (shiftId, openedAt, openingCashPesewas) =>
    set({
      shiftId,
      shiftOpenedAt: openedAt,
      shiftOpeningCashPesewas: openingCashPesewas,
    }),

  clearShift: () =>
    set({ shiftId: null, shiftOpenedAt: null, shiftOpeningCashPesewas: null }),
}));

// Re-export so screens don't have to import from zustand.
export const sessionState = () => useSession.getState();
