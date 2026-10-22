import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RATE_LIMIT_RETRY_MS, RateLimitGate } from '../../../src/main/sessions/rate-limit-gate'

const NOW = 1_700_000_000_000

function make(): {
  gate: RateLimitGate
  clock: { now: number }
  events: string[]
  resumed: ReturnType<typeof vi.fn>
} {
  const clock = { now: NOW }
  const events: string[] = []
  const resumed = vi.fn()
  const gate = new RateLimitGate({
    now: () => clock.now,
    logEvent: (_kind, text) => events.push(text),
    onResumed: resumed,
    log: { warn: vi.fn() }
  })
  return { gate, clock, events, resumed }
}

describe('RateLimitGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the provider of the agent that hit the limit', () => {
    const { gate, events } = make()
    const resetsAt = (NOW + 90_000) / 1000
    gate.hit('codex-brain', { resetsAt, provider: 'codex', retry: vi.fn() })
    gate.hit('w2', { provider: 'codex', retry: vi.fn() })
    gate.hit('w3', { provider: 'claude', retry: vi.fn() })
    gate.hit('w4', { retry: vi.fn() })
    expect(events.map((e) => e.replace(/\(resets .*\)/, '(resets)'))).toEqual([
      'Waiting for the Codex usage limit (resets)',
      'Waiting for the Codex usage limit (trying again in 5 minutes)',
      'Waiting for the Claude usage limit (trying again in 5 minutes)',
      'Waiting for the Claude usage limit (trying again in 5 minutes)'
    ])
  })

  it('waits until resetsAt, logs the reset time, pauses meanwhile and retries once', async () => {
    const { gate, events, resumed } = make()
    const retry = vi.fn()
    const resetsAt = (NOW + 90_000) / 1000
    expect(gate.hit('worker-w1', { resetsAt, retry })).toBe(true)
    const hh = new Date(resetsAt * 1000)
    const clock = `${String(hh.getHours()).padStart(2, '0')}:${String(hh.getMinutes()).padStart(2, '0')}`
    expect(events).toEqual([`Waiting for the Claude usage limit (resets ${clock})`])
    expect(gate.isProviderWaiting('claude')).toBe(true)

    await vi.advanceTimersByTimeAsync(89_000)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(gate.isProviderWaiting('claude')).toBe(false)
    expect(resumed).toHaveBeenCalledTimes(1)

    // Nothing is scheduled again by itself: no retry loop.
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS * 3)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('retries after five minutes when the reset time is unknown or already past', async () => {
    const { gate, events } = make()
    const unknown = vi.fn()
    const past = vi.fn()
    gate.hit('a', { retry: unknown })
    gate.hit('b', { resetsAt: (NOW - 10_000) / 1000, retry: past })
    expect(events).toEqual([
      'Waiting for the Claude usage limit (trying again in 5 minutes)',
      'Waiting for the Claude usage limit (trying again in 5 minutes)'
    ])
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1)
    expect(unknown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(past).toHaveBeenCalledTimes(1)
  })

  it('keeps one pending retry per agent and only moves it for a later known reset time', async () => {
    const { gate, events } = make()
    const retry = vi.fn()
    expect(gate.hit('a', { retry })).toBe(true)
    expect(gate.hit('a', { retry })).toBe(false)
    expect(events).toHaveLength(1)
    // The reset time arrives with the second report: the one retry moves, it is not doubled.
    gate.hit('a', { resetsAt: (NOW + 60_000) / 1000, retry })
    expect(events).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS * 2)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('stays paused until the last agent was retried, and cancel drops a retry', async () => {
    const { gate, resumed } = make()
    const a = vi.fn()
    const b = vi.fn()
    gate.hit('a', { resetsAt: (NOW + 10_000) / 1000, retry: a })
    gate.hit('b', { retry: b })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(gate.isProviderWaiting('claude')).toBe(true)
    expect(resumed).not.toHaveBeenCalled()
    gate.cancel('b')
    expect(gate.isProviderWaiting('claude')).toBe(false)
    expect(resumed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS)
    expect(b).not.toHaveBeenCalled()
  })

  it('waits per provider: a Cursor wait leaves Claude free, and each provider resumes by itself', async () => {
    const { gate, resumed } = make()
    gate.hit('brain', { provider: 'cursor', retry: vi.fn() })
    gate.hit('w2', { provider: 'claude', resetsAt: (NOW + 10_000) / 1000, retry: vi.fn() })
    expect(gate.isProviderWaiting('cursor')).toBe(true)
    expect(gate.isProviderWaiting('claude')).toBe(true)
    expect(gate.isProviderWaiting('codex')).toBe(false)
    await vi.advanceTimersByTimeAsync(12_000)
    // Claude's wait ended and told the queue; Cursor still waits.
    expect(gate.isProviderWaiting('claude')).toBe(false)
    expect(gate.isProviderWaiting('cursor')).toBe(true)
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('cancel drops the wait without a retry and tells the queue so held workers can start', async () => {
    const { gate, resumed } = make()
    const retry = vi.fn()
    gate.hit('brain', { provider: 'cursor', retry })
    gate.cancel('brain')
    expect(gate.isProviderWaiting('cursor')).toBe(false)
    expect(resumed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS * 2)
    expect(retry).not.toHaveBeenCalled()
    expect(resumed).toHaveBeenCalledTimes(1)
    // Cancelling an agent that does not wait is a no-op.
    gate.cancel('brain')
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('cancel keeps the provider waiting while another agent of it still waits', () => {
    const { gate, resumed } = make()
    gate.hit('a', { provider: 'cursor', retry: vi.fn() })
    gate.hit('b', { provider: 'cursor', retry: vi.fn() })
    gate.cancel('a')
    expect(gate.isProviderWaiting('cursor')).toBe(true)
    expect(resumed).not.toHaveBeenCalled()
  })

  it('a retry that throws is logged and does not break the gate', async () => {
    const { gate } = make()
    const retry = vi.fn(() => Promise.reject(new Error('boom')))
    gate.hit('a', { retry })
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS + 1)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(gate.isProviderWaiting('claude')).toBe(false)
  })

  describe('a Cursor limit with no reset time', () => {
    /** Moves the gate's clock and the fake timers together. */
    async function wait(h: ReturnType<typeof make>, ms: number): Promise<void> {
      h.clock.now += ms
      await vi.advanceTimersByTimeAsync(ms)
    }

    it('pauses, logs the Cursor line and retries once after 5 minutes', async () => {
      const h = make()
      const retry = vi.fn()
      h.gate.hit('worker-w1', { provider: 'cursor', retry })
      expect(h.events).toEqual(['Waiting for the Cursor usage limit (trying again in 5 minutes)'])
      expect(h.gate.isProviderWaiting('cursor')).toBe(true)
      expect(h.gate.limitedProviders().size).toBe(0)
      await wait(h, RATE_LIMIT_RETRY_MS - 1)
      expect(retry).not.toHaveBeenCalled()
      await wait(h, 2)
      expect(retry).toHaveBeenCalledTimes(1)
      expect(h.gate.isProviderWaiting('cursor')).toBe(false)
      // Nothing limited yet: the retry may have worked.
      expect(h.gate.limitedProviders().size).toBe(0)
    })

    it('limited again right after the retry: Cursor is held back for new work, then released', async () => {
      const h = make()
      h.gate.hit('worker-w1', { provider: 'cursor', retry: vi.fn() })
      await wait(h, RATE_LIMIT_RETRY_MS + 1)
      h.gate.hit('worker-w1', { provider: 'cursor', retry: vi.fn() })
      expect([...h.gate.limitedProviders()]).toEqual(['cursor'])
      await wait(h, RATE_LIMIT_RETRY_MS + 1)
      expect(h.gate.limitedProviders().size).toBe(0)
    })

    it('a limit long after a retry that worked does not hold the provider back', async () => {
      const h = make()
      h.gate.hit('worker-w1', { provider: 'cursor', retry: vi.fn() })
      await wait(h, RATE_LIMIT_RETRY_MS + 1)
      await wait(h, RATE_LIMIT_RETRY_MS * 2)
      h.gate.hit('worker-w1', { provider: 'cursor', retry: vi.fn() })
      expect(h.gate.limitedProviders().size).toBe(0)
    })

    it('Claude is never held back', async () => {
      const h = make()
      h.gate.hit('brain', { retry: vi.fn() })
      await wait(h, RATE_LIMIT_RETRY_MS + 1)
      h.gate.hit('brain', { retry: vi.fn() })
      expect(h.gate.limitedProviders().size).toBe(0)
    })
  })
})
