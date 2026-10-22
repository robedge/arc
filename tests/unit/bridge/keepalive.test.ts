import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROGRESS_INTERVAL_MS, startKeepalive } from '../../../src/main/bridge/keepalive'
import { BRIDGE_TOOLS } from '../../../src/main/bridge/tools/registry'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('progress keepalives on a long-blocking call', () => {
  it('sends a notification every 15 s while the client gave a progress token', async () => {
    const send = vi.fn(() => Promise.resolve())
    const stop = startKeepalive({ progressToken: 1, intervalMs: PROGRESS_INTERVAL_MS, send })

    await vi.advanceTimersByTimeAsync(14_999)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(1, 1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith(1, 3)

    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('sends nothing when the client gave no progress token', async () => {
    const send = vi.fn(() => Promise.resolve())
    startKeepalive({ progressToken: undefined, intervalMs: PROGRESS_INTERVAL_MS, send })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
  })

  it('survives a notification that cannot be sent', async () => {
    const send = vi.fn(() => Promise.reject(new Error('client gone')))
    startKeepalive({ progressToken: 'tok', intervalMs: 1000, send })
    await vi.advanceTimersByTimeAsync(3000)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('is 15 s, and the tools that wait on a person or a queue are the ones marked long-running', () => {
    expect(PROGRESS_INTERVAL_MS).toBe(15_000)
    expect(
      BRIDGE_TOOLS.filter((t) => t.longRunning === true)
        .map((t) => t.name)
        .sort()
    ).toEqual([
      'ask_brain',
      'ask_user',
      'escalate_to_user',
      'merge_worker',
      'propose_plan',
      'request_permission'
    ])
  })
})
