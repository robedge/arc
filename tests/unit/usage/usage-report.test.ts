import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { UsageRepo } from '../../../src/main/db/repositories/usage-repo'
import type { UsageTurnInput } from '../../../src/main/db/repositories/usage-repo'
import { buildUsageReport } from '../../../src/main/usage/usage-report'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { ProviderPlan } from '../../../src/shared/types/usage'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const noSuggestions = { listForRange: () => [] }
const dir = useTempDir()
let opened: OpenedDatabase
let repo: UsageRepo
const now = new Date(2026, 9, 20, 15, 0).getTime()

function turn(over: Partial<UsageTurnInput>): UsageTurnInput {
  return {
    sessionId: 's1',
    agentKey: 'brain',
    agentRole: 'brain',
    provider: 'claude',
    model: 'sonnet',
    sessionName: 'Fix docs',
    groupName: 'G',
    at: now,
    inputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    ...over
  }
}

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  opened.sqlite
    .prepare(
      "INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g1','G','g',1,1)"
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
       VALUES ('s1','g1','Fix docs','autonomous',2,'auto','sonnet','active',1,1)`
    )
    .run()
  repo = new UsageRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

describe('usage:get-report, Cursor without tokens', () => {
  it('lists Cursor as a provider flagged not reported and adds nothing to the totals', () => {
    repo.record(turn({ turnKey: 'a' }))
    repo.record(
      turn({
        agentKey: 'w1',
        agentRole: 'worker',
        provider: 'cursor',
        model: 'auto',
        inputTokens: 0,
        turnKey: 'b'
      })
    )
    const report = buildUsageReport(
      { repo, suggestions: noSuggestions, plans: () => [], now: () => now },
      'today'
    )
    expect(report.totals.total.total).toBe(100)
    expect(report.totals.byProvider).toEqual([
      expect.objectContaining({
        provider: 'claude',
        tokens: expect.objectContaining({ total: 100 })
      }),
      expect.objectContaining({ provider: 'cursor', notReported: true })
    ])
    expect(report.totals.byProvider[0]).not.toHaveProperty('notReported')
  })

  it('a Cursor provider with tokens is an ordinary provider', () => {
    repo.record(turn({ provider: 'cursor', model: 'auto', inputTokens: 70, turnKey: 'c' }))
    const report = buildUsageReport(
      { repo, suggestions: noSuggestions, plans: () => [], now: () => now },
      'today'
    )
    expect(report.totals.byProvider).toEqual([
      expect.objectContaining({
        provider: 'cursor',
        tokens: expect.objectContaining({ total: 70 })
      })
    ])
    expect(report.totals.byProvider[0]).not.toHaveProperty('notReported')
  })
})

describe('usage:get-report', () => {
  it('assembles totals, daily, spenders per kind and plans for a seeded database', () => {
    repo.record(turn({ turnKey: 'a' }))
    repo.record(
      turn({
        agentKey: 'w1',
        agentRole: 'worker',
        workerId: 'w1',
        workerLabel: 'W1',
        command: '/awos:spec',
        provider: 'codex',
        model: 'gpt-5.5',
        inputTokens: 300,
        turnKey: 'b'
      })
    )
    repo.record(
      turn({
        sessionId: null,
        agentKey: 'plan-check',
        agentRole: 'plan_check',
        inputTokens: 5,
        turnKey: 'c'
      })
    )
    const plans: ProviderPlan[] = [{ provider: 'claude', state: 'waiting', limits: [] }]
    const report = buildUsageReport(
      { repo, suggestions: noSuggestions, plans: () => plans, now: () => now },
      '7d'
    )

    expect(report.range).toBe('7d')
    expect(report.generatedAt).toBe(now)
    expect(report.totals.total.total).toBe(405)
    expect(report.totals.planCheck.total).toBe(5)
    expect(report.daily).toHaveLength(7)
    expect(report.daily[6]?.byProvider).toEqual({ claude: 105, codex: 300 })
    expect(report.spenders.session.map((r) => [r.name, r.total])).toEqual([['Fix docs', 400]])
    expect(report.spenders.worker.map((r) => r.total)).toEqual([300])
    expect(report.spenders.command.map((r) => [r.name, r.total])).toEqual([['/awos:spec', 300]])
    expect(report.plans).toBe(plans)
  })

  it('returns empty lists for a range without usage', () => {
    const report = buildUsageReport(
      { repo, suggestions: noSuggestions, plans: () => [], now: () => now },
      'today'
    )
    expect(report.totals.total.total).toBe(0)
    expect(report.spenders).toEqual({ session: [], worker: [], command: [] })
  })

  it('validation accepts the four ranges and rejects anything else', () => {
    const schema = channelSchemas['usage:get-report']
    for (const range of ['today', '7d', '30d', 'all']) {
      expect(schema.safeParse({ range }).success).toBe(true)
    }
    expect(schema.safeParse({ range: '90d' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ range: 'all', extra: 1 }).success).toBe(false)
  })
})
