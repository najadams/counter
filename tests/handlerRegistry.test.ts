// HandlerRegistry: the tee that feeds desktop IPC and the Phase 1 HTTP
// transport from one set of register*Handlers() calls.

import { describe, expect, it, vi } from 'vitest';
import { HandlerRegistry } from '../src/main/ipc/registry';

type AnyListener = Parameters<HandlerRegistry['handle']>[1];
const noop: AnyListener = async () => ({ success: true, data: null });

describe('HandlerRegistry', () => {
  it('records every handler in its channel map', () => {
    const registry = new HandlerRegistry();
    registry.handle('a:one', noop);
    registry.handle('a:two', noop);

    expect(registry.handlers.size).toBe(2);
    expect(registry.handlers.has('a:one')).toBe(true);
    expect(registry.handlers.get('a:two')).toBe(noop);
  });

  it('forwards each registration to the real ipcMain', () => {
    const real = { handle: vi.fn() };
    const registry = new HandlerRegistry(real);

    registry.handle('a:one', noop);

    expect(real.handle).toHaveBeenCalledTimes(1);
    expect(real.handle).toHaveBeenCalledWith('a:one', noop);
    // ...and still recorded for the non-IPC transport.
    expect(registry.handlers.get('a:one')).toBe(noop);
  });

  it('works headless (no ipcMain) for tests and the HTTP-only path', () => {
    const registry = new HandlerRegistry();
    expect(() => registry.handle('a:one', noop)).not.toThrow();
    expect(registry.handlers.size).toBe(1);
  });

  it('fails loud on a duplicate channel instead of silently shadowing', () => {
    const registry = new HandlerRegistry();
    registry.handle('a:one', noop);
    expect(() => registry.handle('a:one', noop)).toThrow(/Duplicate IPC handler/);
  });
});
