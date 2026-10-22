import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RateLimitWindow } from '../../../src/main/agents/agent-events'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { PlanLimitsRepo } from '../../../src/main/db/repositories/plan-limits-repo'
import { PlanNoticesRepo } from '../../../src/main/db/repositories/plan-notices-repo'
import { PlanNotices } from '../../../src/main/usage/plan-notices'
import { PlanUsageService } from '../../../src/main/usage/plan-usage-service'
import type { ProviderStatusMap } from '../../../src/shared/types/provider'
import type { PlanSnapshot } from '../../../src/shared/types/usage'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const NOW = 1_800_000_000_000
const nowSeconds = Math.floor(NOW / 1000)
const RESET = nowSeconds + 3 * 3600 + 17 // not on a minute boundary
const status: ProviderStatusMap = {
  claude: { provider: 'claude', state: 'ok', message: '', checkedAt: NOW },
  codex: { provider: 'codex', state: 'ok', message: '', checkedAt: NOW }
}

const dir = useTempDir()
let opened: OpenedDatabase
beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
})
afterEach(() => opened.sqlite.close())

const win = (usedPercent: number, resetsAt: number | null = RESET): RateLimitWindow => ({
  windowId: 'five_hour',
  label: '5h',
  usedPercent,
  resetsAt
})

/** A service over the real tables; calling it again over the same db is a restart. */
function boot(clock = { now: NOW }) {
  const published: PlanSnapshot[] = []
  const noticesRepo = new PlanNoticesRepo(opened.db)
  const service = new PlanUsageService({
    repo: new PlanLimitsRepo(opened.db),
    providers: () => status,
    notices: new PlanNotices(noticesRepo, () => clock.now),
    publish: (s) => published.push(s),
    now: () => clock.now
  })
  const last = (): PlanSnapshot => published[published.length - 1] as PlanSnapshot
  return { service, published, last, clock, noticesRepo }
}

describe('plan notices', () => {
  it('79 -> 81 -> 96 raises the 80 notice, then the 95 notice', () => {
    const { service, last } = boot()
    service.ingest('claude', [win(79)], 'event')
    expect(last().notices).toEqual([])
    service.ingest('claude', [win(81)], 'event')
    expect(last().notices.map((n) => n.threshold)).toEqual([80])
    service.ingest('claude', [win(96)], 'event')
    expect(last().notices.map((n) => n.threshold)).toEqual([80, 95])
  })

  it('shapes a notice from the current limit', () => {
    const { service, last } = boot()
    service.ingest('claude', [win(81)], 'event')
    expect(last().notices).toEqual([
      {
        key: `claude|five_hour|${Math.floor(RESET / 60) * 60}|80`,
        provider: 'claude',
        windowId: 'five_hour',
        label: '5h',
        threshold: 80,
        usedPercent: 81,
        resetsAt: RESET
      }
    ])
  })

  it('a jump from 79 straight to 96 claims only the 95 key', () => {
    const { service, last } = boot()
    service.ingest('claude', [win(79)], 'event')
    service.ingest('claude', [win(96)], 'event')
    expect(last().notices.map((n) => n.threshold)).toEqual([95])
    expect(new PlanNoticesRepo(opened.db).pending()).toHaveLength(1)
  })

  it('a dismissed 80 notice is not raised again at 90, and dropping below 80 does not re-arm', () => {
    const { service, last } = boot()
    service.ingest('claude', [win(81)], 'event')
    const key = (last().notices[0] as { key: string }).key
    service.dismissNotice(key)
    expect(last().notices).toEqual([])
    service.ingest('claude', [win(90)], 'event')
    expect(last().notices).toEqual([])
    service.ingest('claude', [win(50)], 'event')
    service.ingest('claude', [win(85)], 'event')
    expect(last().notices).toEqual([])
  })

  it('a new reset period re-arms, and the old undismissed notice does not resurface', () => {
    const { service, last } = boot()
    service.ingest('claude', [win(81)], 'event')
    const oldKey = (last().notices[0] as { key: string }).key
    service.ingest('claude', [win(10, RESET + 5 * 3600)], 'event')
    expect(last().notices).toEqual([])
    service.ingest('claude', [win(82, RESET + 5 * 3600)], 'event')
    const keys = last().notices.map((n) => n.key)
    expect(keys).toHaveLength(1)
    expect(keys).not.toContain(oldKey)
  })

  it('a few seconds of jitter in resetsAt keeps the same key', () => {
    const { service, last } = boot()
    const base = Math.floor(RESET / 60) * 60
    service.ingest('claude', [win(81, base + 5)], 'event')
    service.ingest('claude', [win(83, base + 41)], 'event')
    expect(last().notices).toHaveLength(1)
    expect(new PlanNoticesRepo(opened.db).pending()).toHaveLength(1)
  })

  it('survives a restart: nothing is raised twice, and a dismissal stays', () => {
    const first = boot()
    first.service.ingest('claude', [win(81)], 'event')
    const second = boot()
    second.service.ingest('claude', [win(82)], 'event')
    expect(new PlanNoticesRepo(opened.db).pending()).toHaveLength(1)
    expect(second.last().notices.map((n) => n.threshold)).toEqual([80])
    second.service.dismissNotice((second.last().notices[0] as { key: string }).key)
    const third = boot()
    third.service.ingest('claude', [win(83)], 'event')
    expect(third.last().notices).toEqual([])
  })

  it('launching at 85% raises the 80 notice once', () => {
    const { service, last } = boot()
    service.ingest('claude', [win(85)], 'poll')
    service.ingest('claude', [win(85)], 'poll')
    expect(last().notices.map((n) => n.threshold)).toEqual([80])
    expect(new PlanNoticesRepo(opened.db).pending()).toHaveLength(1)
  })

  it('prunes notices whose reset is more than 8 days past', () => {
    const { service, clock, noticesRepo } = boot()
    service.ingest('claude', [win(81)], 'event')
    clock.now = NOW + 7 * 86_400_000
    service.pruneNotices()
    expect(noticesRepo.pending()).toHaveLength(1)
    clock.now = NOW + 9 * 86_400_000
    service.pruneNotices()
    expect(noticesRepo.pending()).toHaveLength(0)
  })
})
