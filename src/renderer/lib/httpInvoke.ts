// HTTP transport for the renderer (Phase 1).
//
// The mirror image of preload's IPC binding: it implements the same `Invoke`
// primitive that shared/counterApi.ts builds the whole API from, but over
// fetch('/api/<channel>') instead of ipcRenderer. Used when the renderer runs
// in a plain browser (LAN device) rather than inside Electron.
//
// Auth is bearer-token based: the login response carries a token in a header,
// which we stash and send on every subsequent request. Logout clears it.

import { IPC_CHANNELS, type IpcResponse } from '../../shared/types/ipc';
import type { Invoke } from '../../shared/counterApi';

const TOKEN_HEADER = 'x-counter-token';
let token: string | null = null;

export const httpInvoke: Invoke = async <T>(
  channel: string,
  payload?: unknown,
): Promise<IpcResponse<T>> => {
  let res: Response;
  try {
    res = await fetch(`/api/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload ?? {}),
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Capture/clear the session token around the auth channels.
  if (channel === IPC_CHANNELS.WORKER_LOGIN) {
    const t = res.headers.get(TOKEN_HEADER);
    if (t) token = t;
  } else if (channel === IPC_CHANNELS.WORKER_LOGOUT) {
    token = null;
  }

  try {
    return (await res.json()) as IpcResponse<T>;
  } catch {
    return { success: false, error: `Bad response from server (HTTP ${res.status})` };
  }
};
