import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_LIMITS_FOCUS_GAP_MS,
  CODEX_LIMITS_POLL_MS,
  CodexRateLimitReader
} from '../../../src/main/usage/codex-rate-limit-reader'
import type { CodexRateLimits } from '../../../src/main/agents/codex/codex-probe'
import type { ProviderStatusMap } from '../../../src/shared/types/provider'

const okStatus: ProviderStatusMap = {
  codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 0 }
}
const windows: CodexRateLimits = {
  windows: [{ windowId: 'codex:300', label: '5h', usedPercent: 12, resetsAt: 5 }],
  planType: 'pro'
}

function make(status: () => ProviderStatusMap = () => okStatus) {
  let release: (v: CodexRateLimits) => void = () => undefined
  const readRateLimits = vi.fn(
    () =>
      new Promise<CodexRateLimits>((resolve) => {
        release = resolve
      })
  )
  const ingest = vi.fn()
  const warn = vi.fn()
  const reader = new CodexRateLimitReader({
    source: { readRateLimits },
    plans: { ingest },
    status,
    now: () => Date.now(),
    log: { warn }
  })
  return { reader, readRateLimits, ingest, warn, finish: (v = windows) => release(v) }
}

describe('CodexRateLimitReader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start reads at once and ingests as a poll with the plan type', async () => {
    const { reader, readRateLimits, ingest, finish } = make()
    reader.start()
    expect(readRateLimits).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(ingest).toHaveBeenCalledWith('codex', windows.windows, 'poll', 'pro')
    reader.dispose()
  })

  it('reads every five minutes', async () => {
    const { reader, readRateLimits, finish } = make()
    reader.start()
    finish()
    await vi.advanceTimersByTimeAsync(CODEX_LIMITS_POLL_MS)
    expect(readRateLimits).toHaveBeenCalledTimes(2)
    finish()
    await vi.advanceTimersByTimeAsync(CODEX_LIMITS_POLL_MS)
    expect(readRateLimits).toHaveBeenCalledTimes(3)
    reader.dispose()
  })

  it('overlapping calls share one in-flight request', async () => {
    const { reader, readRateLimits, ingest, finish } = make()
    const a = reader.refresh()
    const b = reader.refresh()
    reader.onFocus()
    expect(readRateLimits).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([a, b])
    expect(ingest).toHaveBeenCalledTimes(1)
    void reader.refresh()
    expect(readRateLimits).toHaveBeenCalledTimes(2)
  })

  it('focus reads, but not again within the focus gap of a finished read', async () => {
    const { reader, readRateLimits, finish } = make()
    reader.onFocus()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(readRateLimits).toHaveBeenCalledTimes(1)
    reader.onFocus()
    expect(readRateLimits).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CODEX_LIMITS_FOCUS_GAP_MS)
    reader.onFocus()
    expect(readRateLimits).toHaveBeenCalledTimes(2)
  })

  it('is skipped unless Codex status is ok', async () => {
    for (const status of [{}, { codex: { ...okStatus.codex!, state: 'signed_out' as const } }]) {
      const { reader, readRateLimits, ingest } = make(() => status)
      await reader.refresh()
      reader.onFocus()
      reader.start()
      await vi.advanceTimersByTimeAsync(CODEX_LIMITS_POLL_MS * 2)
      expect(readRateLimits).not.toHaveBeenCalled()
      expect(ingest).not.toHaveBeenCalled()
      reader.dispose()
    }
  })

  it('a failed read keeps the last value, logs, and a later read still works', async () => {
    const { reader, readRateLimits, ingest, warn } = make()
    readRateLimits.mockRejectedValueOnce(new Error('boom'))
    await reader.refresh()
    expect(ingest).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    void reader.refresh()
    expect(readRateLimits).toHaveBeenCalledTimes(2)
  })

  it('dispose clears the interval and stops all reads', async () => {
    const { reader, readRateLimits, finish } = make()
    reader.start()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    reader.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(CODEX_LIMITS_POLL_MS * 3)
    await reader.refresh()
    reader.onFocus()
    expect(readRateLimits).toHaveBeenCalledTimes(1)
  })
})
