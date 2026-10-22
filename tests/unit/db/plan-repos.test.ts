import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { PlanLimitsRepo } from '../../../src/main/db/repositories/plan-limits-repo'
import { PlanNoticesRepo } from '../../../src/main/db/repositories/plan-notices-repo'
import type { PlanLimit } from '../../../src/shared/types/usage'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
})
afterEach(() => opened.sqlite.close())

const obs = (over: Partial<PlanLimit> = {}): PlanLimit => ({
  provider: 'claude',
  windowId: 'five_hour',
  label: '5h',
  usedPercent: 40,
  resetsAt: 2000,
  observedAt: 100,
  source: 'event',
  ...over
})

describe('PlanLimitsRepo', () => {
  it('keeps the newest observation per window and ignores an older one', () => {
    const repo = new PlanLimitsRepo(opened.db)
    repo.upsertObservation(obs({ usedPercent: 40, observedAt: 100 }))
    const newer = repo.upsertObservation(obs({ usedPercent: 60, observedAt: 200 }))
    expect(newer.usedPercent).toBe(60)
    const stale = repo.upsertObservation(obs({ usedPercent: 10, observedAt: 150 }))
    expect(stale).toMatchObject({ usedPercent: 60, observedAt: 200 })
    expect(repo.upsertObservation(obs({ usedPercent: 61, observedAt: 200 })).usedPercent).toBe(61)
    expect(repo.list()).toHaveLength(1)
  })

  it('lists all and filters by provider', () => {
    const repo = new PlanLimitsRepo(opened.db)
    repo.upsertObservation(obs())
    repo.upsertObservation(obs({ windowId: 'weekly', label: 'Weekly' }))
    repo.upsertObservation(obs({ provider: 'codex' }))
    expect(repo.list()).toHaveLength(3)
    expect(
      repo
        .forProvider('claude')
        .map((l) => l.windowId)
        .sort()
    ).toEqual(['five_hour', 'weekly'])
    expect(repo.forProvider('none')).toEqual([])
  })
})

describe('PlanNoticesRepo', () => {
  const claim = (key: string, now: number, resetsAt: number | null = 1000): boolean =>
    new PlanNoticesRepo(opened.db).claim({
      key,
      provider: 'claude',
      window: 'five_hour',
      threshold: 80,
      resetsAt,
      now
    })

  it('claims once per key', () => {
    expect(claim('k1', 1)).toBe(true)
    expect(claim('k1', 2)).toBe(false)
    expect(claim('k2', 3)).toBe(true)
  })

  it('dismiss removes a notice from pending; pending is ordered by notified_at', () => {
    const repo = new PlanNoticesRepo(opened.db)
    claim('late', 30)
    claim('early', 10)
    claim('mid', 20)
    expect(repo.pending().map((n) => n.key)).toEqual(['early', 'mid', 'late'])
    repo.dismiss('mid', 99)
    expect(repo.pending().map((n) => n.key)).toEqual(['early', 'late'])
    expect(claim('mid', 100)).toBe(false)
  })

  it('prunes rows whose reset is older than the cutoff', () => {
    const repo = new PlanNoticesRepo(opened.db)
    claim('old', 1, 100)
    claim('edge', 1, 500)
    claim('new', 1, 900)
    claim('none', 1, null)
    expect(repo.prune(500)).toBe(1)
    expect(
      repo
        .pending()
        .map((n) => n.key)
        .sort()
    ).toEqual(['edge', 'new', 'none'])
  })
})
