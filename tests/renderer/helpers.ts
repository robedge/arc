import { vi } from 'vitest'
import type { Result } from '@shared/errors'

export function mockArc(
  handler: (channel: string, request: unknown) => Result<unknown> | Promise<Result<unknown>>
): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, request: unknown) => handler(channel, request))
  Object.defineProperty(window, 'arc', {
    configurable: true,
    value: { invoke, send: vi.fn(), on: vi.fn(() => () => {}), getPathForFile: vi.fn(() => '') }
  })
  return invoke
}
