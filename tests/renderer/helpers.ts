import { vi } from 'vitest'
import type { Result } from '@shared/errors'

export function mockHarness(
  handler: (channel: string, request: unknown) => Result<unknown> | Promise<Result<unknown>>
): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, request: unknown) => handler(channel, request))
  Object.defineProperty(window, 'harness', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), getPathForFile: vi.fn(() => '') }
  })
  return invoke
}
