import { vi } from 'vitest'

export type Captured = Map<string, (request: unknown) => unknown>

/** Mocks for `src/main/ipc/register` and the logger: `handle()` records each handler by channel. */
export function registerMock(captured: Captured, emit: unknown = vi.fn()): Record<string, unknown> {
  return {
    handle: (channel: string, fn: (request: unknown) => unknown) => captured.set(channel, fn),
    emit
  }
}

export const loggingMock = (): Record<string, unknown> => {
  const scope = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { sessionsLog: scope, knowledgeLog: scope, cliLog: scope, ipcLog: scope }
}

export function call(captured: Captured, channel: string, request: unknown = {}): unknown {
  const fn = captured.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn(request)
}
