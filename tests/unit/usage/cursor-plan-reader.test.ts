import { describe, expect, it, vi } from 'vitest'
import {
  CURSOR_PLAN_FOCUS_GAP_MS,
  CURSOR_TIER_CACHE_MS,
  CursorPlanReader
} from '../../../src/main/usage/cursor-plan-reader'
import type { ProviderStatusMap } from '../../../src/shared/types/provider'

const okStatus: ProviderStatusMap = {
  cursor: { provider: 'cursor', state: 'ok', message: '', checkedAt: 0 }
}

function make(status: () => ProviderStatusMap = () => okStatus) {
  const clock = { now: 1_000_000 }
  const tier = vi.fn(async (): Promise<string | undefined> => 'Free')
  const ingest = vi.fn()
  const warn = vi.fn()
  const reader = new CursorPlanReader({
    tier,
    plans: { ingest },
    status,
    now: () => clock.now,
    log: { warn }
  })
  return { reader, clock, tier, ingest, warn }
}

describe('CursorPlanReader', () => {
  it('reports no windows, with the subscription tier, once Cursor is ok', async () => {
    const { reader, ingest } = make()
    await reader.refresh()
    expect(ingest).toHaveBeenCalledWith('cursor', [], 'probe', 'Free')
  })

  it('does nothing while Cursor is not ok', async () => {
    const { reader, tier, ingest } = make(() => ({
      cursor: { provider: 'cursor', state: 'signed_out', message: '', checkedAt: 0 }
    }))
    await reader.refresh()
    expect(tier).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('caches the tier for six hours: a focus re-reports without spawning the CLI', async () => {
    const { reader, clock, tier, ingest } = make()
    await reader.refresh()
    clock.now += CURSOR_PLAN_FOCUS_GAP_MS + 1
    reader.onFocus()
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2))
    expect(tier).toHaveBeenCalledTimes(1)
    clock.now += CURSOR_TIER_CACHE_MS
    await reader.refresh()
    expect(tier).toHaveBeenCalledTimes(2)
  })

  it('a focus right after a report does nothing', async () => {
    const { reader, clock, ingest } = make()
    await reader.refresh()
    clock.now += CURSOR_PLAN_FOCUS_GAP_MS - 1
    reader.onFocus()
    await Promise.resolve()
    expect(ingest).toHaveBeenCalledTimes(1)
  })

  it('concurrent refreshes share one read', async () => {
    const { reader, tier, ingest } = make()
    await Promise.all([reader.refresh(), reader.refresh()])
    expect(tier).toHaveBeenCalledTimes(1)
    expect(ingest).toHaveBeenCalledTimes(1)
  })

  it('keeps the last tier when a later read cannot find one, and logs a failure', async () => {
    const { reader, clock, tier, ingest, warn } = make()
    await reader.refresh()
    clock.now += CURSOR_TIER_CACHE_MS
    tier.mockResolvedValueOnce(undefined)
    await reader.refresh()
    expect(ingest).toHaveBeenLastCalledWith('cursor', [], 'probe', 'Free')
    clock.now += CURSOR_TIER_CACHE_MS
    tier.mockRejectedValueOnce(new Error('boom'))
    await reader.refresh()
    expect(warn).toHaveBeenCalled()
    expect(ingest).toHaveBeenLastCalledWith('cursor', [], 'probe', 'Free')
  })

  it('reports without a tier when none was ever found', async () => {
    const { reader, tier, ingest } = make()
    tier.mockResolvedValue(undefined)
    await reader.refresh()
    expect(ingest).toHaveBeenCalledWith('cursor', [], 'probe', undefined)
  })

  it('stops after dispose', async () => {
    const { reader, ingest } = make()
    reader.dispose()
    await reader.refresh()
    expect(ingest).not.toHaveBeenCalled()
  })
})
