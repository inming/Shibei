import { vi } from "vitest";

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown;

let invokeHandler: InvokeHandler = () => undefined;

/**
 * Mock for @tauri-apps/api/core.
 * Call `mockInvoke(handler)` before each test to set the handler.
 */
export const tauriCoreMock = {
  invoke: vi.fn((...args: unknown[]) => {
    const cmd = args[0] as string;
    const params = args[1] as Record<string, unknown> | undefined;
    return Promise.resolve(invokeHandler(cmd, params));
  }),
};

/**
 * Set invoke handler for the current test.
 * Handler receives (commandName, args) and returns the result.
 */
export function mockInvoke(handler: InvokeHandler): void {
  invokeHandler = handler;
  tauriCoreMock.invoke.mockClear();
}

/** Reset invoke to return undefined. */
export function resetInvoke(): void {
  invokeHandler = () => undefined;
  tauriCoreMock.invoke.mockClear();
}

type ListenCallback = (event: { payload: unknown }) => void;
const listeners = new Map<string, ListenCallback[]>();

export const tauriEventMock = {
  listen: vi.fn((event: string, callback: ListenCallback) => {
    const cbs = listeners.get(event) ?? [];
    cbs.push(callback);
    listeners.set(event, cbs);
    const unlisten = () => {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
    return Promise.resolve(unlisten);
  }),
};

/** Emit a fake Tauri event for testing. */
export function emitTauriEvent(event: string, payload?: unknown): void {
  const cbs = listeners.get(event);
  if (cbs) {
    for (const cb of cbs) cb({ payload });
  }
}

export function resetListeners(): void {
  listeners.clear();
  tauriEventMock.listen.mockClear();
}
