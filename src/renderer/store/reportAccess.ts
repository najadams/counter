// In-memory only report capability. Never persist this token: reload/restart
// must return sensitive reports to the locked state.

import { create } from 'zustand';
import type { ReportAccessScope } from '../../shared/types/ipc';

interface ReportAccessState {
  accessToken: string | null;
  scopes: ReportAccessScope[];
  idleExpiresAt: string | null;
  unlock: (accessToken: string, scopes: ReportAccessScope[], idleExpiresAt: string) => void;
  touch: (idleExpiresAt: string) => void;
  clear: () => void;
}

export const useReportAccess = create<ReportAccessState>((set) => ({
  accessToken: null,
  scopes: [],
  idleExpiresAt: null,
  unlock: (accessToken, scopes, idleExpiresAt) => set({ accessToken, scopes, idleExpiresAt }),
  touch: (idleExpiresAt) => set({ idleExpiresAt }),
  clear: () => set({ accessToken: null, scopes: [], idleExpiresAt: null }),
}));

export function clearReportAccessState(): void {
  useReportAccess.getState().clear();
}
