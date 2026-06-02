// Preload: the only bridge between renderer and main.
//
// The RPC surface itself lives in shared/counterApi.ts — the single source of
// truth shared with the (Phase 1) HTTP/LAN client. Here we just bind that
// factory's `invoke` primitive to Electron IPC and expose the result.

import { contextBridge, ipcRenderer } from 'electron';
import { createCounterApi } from '../shared/counterApi.js';
import type { IpcResponse } from '../shared/types/ipc.js';

const api = createCounterApi(
  <T>(channel: string, payload?: unknown) =>
    ipcRenderer.invoke(channel, payload ?? {}) as Promise<IpcResponse<T>>,
);

contextBridge.exposeInMainWorld('counter', api);

export type { CounterApi } from '../shared/counterApi.js';
