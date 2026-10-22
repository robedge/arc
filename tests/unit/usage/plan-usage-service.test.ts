import { describe, expect, it, vi } from 'vitest'
import type { RateLimitWindow } from '../../../src/main/agents/agent-events'
import {
  forwardRateLimit,
  PlanUsageService,
  type PlanUsageServiceDeps
} from '../../../src/main/usage/plan-usage-service'
import type { ProviderStatusMap } from '../../../src/shared/types/provider'
import type { PlanLimit, PlanSnapshot } from '../../../src/shared/types/usage'

const NOW = 1_800_000_000_000
const inHours = (h: number): number => Math.floor(NOW / 1000) + h * 3600

const ok = (provider: 'claude' | 'codex' | 'cursor'): ProviderStatusMap[typeof provider] => ({
  provider,
  state: 'ok',
  message: '',
  checkedAt: NOW
})

/** An in-memory stand-in with the repo's newest-wins rule (`observedAt >=`). */
function memoryRepo(): PlanUsageServiceDeps['repo'] & { rows: Map<string, PlanLimit> } {
  const rows = new Map<string, PlanLimit>()
  return {
    rows,
    upsertObservation(o) {
      const key = `${o.provider}|${o.windowId}`
      const existing = rows.get(key)
      if (!existing || o.observedAt >= existing.observedAt) {
        rows.set(key, {
          provider: o.provider,
          windowId: o.windowId,
          label: o.label,
          usedPercent: o.usedPercent,
          resetsAt: o.resetsAt,
          observedAt: o.observedAt,
          source: o.source
        })
      }
      return rows.get(key) as PlanLimit
    },
    forProvider: (provider) => [...rows.values()].filter((l) => l.provider === provider)
  }
}

function make(status: ProviderStatusMap = { claude: ok('claude'), codex: ok('codex') }) {
  const clock = { now: NOW }
  const repo = memoryRepo()
  const published: PlanSnapshot[] = []
  const service = new PlanUsageService({
    repo,
    providers: () => status,
    publish: (s) => published.push(s),
    now: () => clock.now
  })
  return { service, clock, repo, published, status }
}

const five = (usedPercent: number, resetsAt: number | null = inHours(3)): RateLimitWindow => ({
  windowId: 'five_hour',
  label: '5h',
  usedPercent,
  resetsAt
})
const week = (usedPercent: number): RateLimitWindow => ({
  windowId: 'seven_day',
  label: 'Weekly',
  usedPercent,
  resetsAt: inHours(100)
})

describe('PlanUsageService', () => {
  it('ingest stores each window as observed now and pushes plan:changed', () => {
    const { service, published } = make()
    service.ingest('claude', [five(42), week(18)], 'event')
    expect(published).toHaveLength(1)
    const claude = published[0]?.plans.find((p) => p.provider === 'claude')
    expect(claude?.state).toBe('ok')
    expect(claude?.limits.map((l) => [l.windowId, l.usedPercent, l.observedAt, l.source])).toEqual([
      ['five_hour', 42, NOW, 'event'],
      ['seven_day', 18, NOW, 'event']
    ])
    expect(published[0]?.notices).toEqual([])
  })

  it('the newest observation wins; an older one does not overwrite it', () => {
    const { service, clock } = make()
    service.ingest('claude', [five(42)], 'event')
    clock.now = NOW - 60_000 // a late, older observation
    service.ingest('claude', [five(10)], 'probe')
    const limits = service.meters()[0]?.limits
    expect(limits).toHaveLength(1)
    expect(limits?.[0]).toMatchObject({ usedPercent: 42, observedAt: NOW, source: 'event' })
    clock.now = NOW + 60_000
    service.ingest('claude', [five(55)], 'event')
    expect(service.meters()[0]?.limits[0]).toMatchObject({
      usedPercent: 55,
      observedAt: NOW + 60_000
    })
  })

  it('waiting: a set-up provider with no observation; providers that are not ok have no meter', () => {
    const { service } = make({
      claude: ok('claude'),
      codex: { provider: 'codex', state: 'missing', message: '', checkedAt: NOW }
    })
    expect(service.meters()).toEqual([{ provider: 'claude', state: 'waiting', limits: [] }])
    const none = make({})
    expect(none.service.meters()).toEqual([])
  })

  it('ok: limits known, shortest window first, plan type kept', () => {
    const { service } = make()
    service.ingest('codex', [week(30), { ...five(12), windowId: 'codex:300' }], 'poll', 'pro')
    const codex = service.meters().find((p) => p.provider === 'codex')
    expect(codex).toMatchObject({ state: 'ok', planType: 'pro' })
    expect(codex?.limits.map((l) => l.windowId)).toEqual(['codex:300', 'seven_day'])
  })

  it('not-reported keeps the plan type for empty windows (Cursor: the subscription tier)', () => {
    const { service, published } = make({ cursor: ok('cursor') })
    service.ingest('cursor', [], 'probe', 'Free')
    expect(published).toHaveLength(1)
    expect(service.meters()).toEqual([
      { provider: 'cursor', state: 'not-reported', limits: [], planType: 'Free' }
    ])
    service.ingest('cursor', [], 'probe')
    expect(service.meters()[0]?.planType).toBe('Free')
    service.ingest('cursor', [], 'probe', 'Pro')
    expect(service.meters()[0]?.planType).toBe('Pro')
  })

  it('no Cursor meter while Cursor is not ok', () => {
    const { service } = make({
      cursor: { provider: 'cursor', state: 'signed_out', message: '', checkedAt: NOW }
    })
    service.ingest('cursor', [], 'probe', 'Free')
    expect(service.meters()).toEqual([])
  })

  it('not-reported: a poll that answers with no windows; the next observation clears it', () => {
    const { service, published } = make()
    service.ingest('codex', [{ ...five(5), windowId: 'codex:300' }], 'poll')
    service.ingest('codex', [], 'poll')
    expect(published).toHaveLength(2)
    expect(service.meters().find((p) => p.provider === 'codex')).toEqual({
      provider: 'codex',
      state: 'not-reported',
      limits: []
    })
    service.ingest('codex', [{ ...five(6), windowId: 'codex:300' }], 'push')
    expect(service.meters().find((p) => p.provider === 'codex')?.state).toBe('ok')
  })

  it('an event or push without windows is not "not reported"', () => {
    const { service, published } = make()
    service.ingest('claude', [], 'event')
    service.ingest('codex', [], 'push')
    expect(published).toEqual([])
    expect(service.meters().map((p) => p.state)).toEqual(['waiting', 'waiting'])
  })

  it('stale: a window whose reset has passed is flagged; all stale makes the meter stale', () => {
    const { service, clock } = make()
    service.ingest('claude', [five(97, inHours(1)), week(18)], 'event')
    expect(service.meters()[0]?.state).toBe('ok')
    clock.now = NOW + 2 * 3600 * 1000 // five_hour reset passed, weekly has not
    const mixed = service.meters()[0]
    expect(mixed?.state).toBe('ok')
    expect(mixed?.limits.map((l) => [l.windowId, l.stale === true])).toEqual([
      ['five_hour', true],
      ['seven_day', false]
    ])
    clock.now = NOW + 200 * 3600 * 1000
    expect(service.meters()[0]?.state).toBe('stale')
  })

  it('a limit with no reset time never goes stale', () => {
    const { service, clock } = make()
    service.ingest('claude', [five(50, null)], 'event')
    clock.now = NOW + 1e10
    expect(service.meters()[0]?.limits[0]?.stale).toBeUndefined()
  })

  it('clamps percentages and survives a repo failure', () => {
    const { service, repo } = make()
    service.ingest('claude', [five(140)], 'event')
    expect(service.meters()[0]?.limits[0]?.usedPercent).toBe(100)
    const warn = vi.fn()
    const failing = new PlanUsageService({
      repo: {
        ...repo,
        upsertObservation: () => {
          throw new Error('db')
        }
      },
      providers: () => ({ claude: ok('claude') }),
      publish: vi.fn(),
      log: { warn }
    })
    expect(() => failing.ingest('claude', [five(1)], 'event')).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  it('forwardRateLimit maps provider to source and skips events without windows', () => {
    const ingest = vi.fn()
    const base = { agentId: 'a', ts: 1, type: 'rate-limit' as const }
    forwardRateLimit({ ingest }, { ...base, provider: 'claude', windows: [five(1)] })
    forwardRateLimit(
      { ingest },
      { ...base, provider: 'codex', windows: [five(2)], planType: 'pro' }
    )
    forwardRateLimit({ ingest }, { ...base, provider: 'claude' })
    forwardRateLimit(undefined, { ...base, provider: 'claude', windows: [five(3)] })
    expect(ingest.mock.calls.map((c) => [c[0], c[2], c[3]])).toEqual([
      ['claude', 'event', undefined],
      ['codex', 'push', 'pro']
    ])
  })

  it('refreshMeters pushes the current snapshot', () => {
    const { service, published } = make()
    service.refreshMeters()
    expect(published[0]?.plans.map((p) => p.state)).toEqual(['waiting', 'waiting'])
  })
})
