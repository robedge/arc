import { describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../../src/main/sessions/session-service'
import type { SessionServiceDeps } from '../../../src/main/sessions/session-service'

describe('SessionService.shutdown', () => {
  it('is idempotent: the second call returns the same run and does not repeat any step', async () => {
    const stopInterrupted = vi.fn(() => [])
    const pauseAllActiveControl = vi.fn(() => [])
    const recoverStreaming = vi.fn(() => 0)
    const cleanup = vi.fn()
    const service = new SessionService({
      workersRepo: { stopInterrupted, pauseAllActiveControl },
      messagesRepo: { recoverStreaming },
      eventsRepo: { append: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    } as unknown as SessionServiceDeps)
    const first = service.shutdown({ cleanup })
    const second = service.shutdown({ cleanup })
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(stopInterrupted).toHaveBeenCalledTimes(1)
    expect(stopInterrupted).toHaveBeenCalledWith(expect.any(Number), 'quit')
    expect(pauseAllActiveControl).toHaveBeenCalledTimes(1)
    expect(recoverStreaming).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
