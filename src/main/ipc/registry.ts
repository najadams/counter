// Handler registry — the tee that lets one set of register*Handlers() calls
// feed two transports.
//
// The register functions only ever call `.handle(channel, listener)`. By
// passing them a HandlerRegistry instead of Electron's ipcMain, every
// registration is (a) forwarded to the real ipcMain so the desktop IPC path
// is unchanged, and (b) recorded in a channel->listener Map that the Phase 1
// HTTP server dispatches against. Same handlers, same db, two ways in.

import type { IpcMain } from 'electron';

/** The slice of IpcMain the register functions actually depend on. */
export type IpcRegistrar = Pick<IpcMain, 'handle'>;

type Listener = Parameters<IpcMain['handle']>[1];

export class HandlerRegistry implements IpcRegistrar {
  /** channel -> wrapped handler, for non-IPC transports to dispatch against. */
  readonly handlers = new Map<string, Listener>();

  /** @param real the live ipcMain to forward to; omit in tests/headless. */
  constructor(private readonly real?: IpcRegistrar) {}

  handle(channel: string, listener: Listener): void {
    if (this.handlers.has(channel)) {
      // Two handlers on one channel is a wiring bug — the second silently
      // wins on ipcMain today. Fail loud instead.
      throw new Error(`Duplicate IPC handler registration for channel: ${channel}`);
    }
    this.handlers.set(channel, listener);
    this.real?.handle(channel, listener);
  }
}
