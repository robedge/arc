import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AgentSetupRepo } from '../../../src/main/db/repositories/agent-setup-repo'
import {
  UsageRepo,
  usageRangeDays,
  usageRecordingState
} from '../../../src/main/db/repositories/usage-repo'
import type { UsageTurnInput } from '../../../src/main/db/repositories/usage-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let repo: UsageRepo

function seedSession(id: string): void {
  opened.sqlite
    .prepare(
      "INSERT OR IGNORE INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g1','G','g',1,1)"
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
       VALUES (?, 'g1', 'S', 'autonomous', 2, 'auto', 'sonnet', 'active', 1, 1)`
    )
    .run(id)
}

function turn(over: Partial<UsageTurnInput> = {}): UsageTurnInput {
  return {
    sessionId: 's1',
    agentKey: 'brain',
    agentRole: 'brain',
    provider: 'claude',
    model: 'sonnet',
    at: new Date(2026, 9, 20, 12, 0).getTime(),
    inputTokens: 10,
    cacheWriteTokens: 20,
    cacheReadTokens: 30,
    outputTokens: 40,
    ...over
  }
}

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  seedSession('s1')
})
afterEach(() => opened.sqlite.close())

const rows = (): Record<string, unknown>[] =>
  opened.sqlite.prepare('SELECT * FROM usage_turns ORDER BY id').all() as Record<string, unknown>[]

describe('UsageRepo.record', () => {
  it('buckets the day in local time, not UTC', () => {
    // 23:30 local on Oct 20 and 00:30 local on Oct 21 straddle local midnight whatever the zone.
    repo = new UsageRepo(opened.db)
    repo.record(turn({ at: new Date(2026, 9, 20, 23, 30).getTime(), turnKey: 'a' }))
    repo.record(turn({ at: new Date(2026, 9, 21, 0, 30).getTime(), turnKey: 'b' }))
    expect(rows().map((r) => r.day)).toEqual(['2026-10-20', '2026-10-21'])
  })

  it('defaults optional columns and stores snapshots', () => {
    repo = new UsageRepo(opened.db)
    repo.record(turn({ workerLabel: 'api', sessionName: 'S', groupName: 'G', groupId: 'g1' }))
    expect(rows()[0]).toMatchObject({
      worker_label: 'api',
      session_name: 'S',
      group_name: 'G',
      group_id: 'g1',
      setup_tokens: 0,
      arc_setup_tokens: 0,
      max_call_input: 0,
      call_count: 0,
      source: 'turn',
      turn_key: null,
      context_window: null
    })
  })

  it('dedupes on (agent_key, turn_key)', () => {
    repo = new UsageRepo(opened.db)
    expect(repo.record(turn({ turnKey: 't1' }))).toEqual({ inserted: true })
    expect(repo.record(turn({ turnKey: 't1', inputTokens: 999 }))).toEqual({ inserted: false })
    expect(repo.record(turn({ turnKey: 't1', agentKey: 'w1', agentRole: 'worker' }))).toEqual({
      inserted: true
    })
    expect(rows()).toHaveLength(2)
    expect(repo.sessionTotal('s1').input).toBe(20)
  })

  it('allows several rows with a null turn_key', () => {
    repo = new UsageRepo(opened.db)
    expect(repo.record(turn())).toEqual({ inserted: true })
    expect(repo.record(turn())).toEqual({ inserted: true })
    expect(rows()).toHaveLength(2)
  })
})

describe('UsageRepo totals', () => {
  it('sums a session and splits per agent', () => {
    repo = new UsageRepo(opened.db)
    seedSession('s2')
    repo.record(turn())
    repo.record(turn({ agentKey: 'w1', agentRole: 'worker', workerId: 'w1', inputTokens: 1 }))
    repo.record(turn({ agentKey: 'w1', agentRole: 'worker', workerId: 'w1', inputTokens: 2 }))
    repo.record(turn({ sessionId: 's2', inputTokens: 500 }))

    expect(repo.sessionTotal('s1')).toEqual({
      input: 13,
      cacheWrite: 60,
      cacheRead: 90,
      output: 120,
      total: 283
    })
    const byAgent = repo.workerTotals('s1')
    expect([...byAgent.keys()].sort()).toEqual(['brain', 'w1'])
    expect(byAgent.get('brain')).toEqual({
      input: 10,
      cacheWrite: 20,
      cacheRead: 30,
      output: 40,
      total: 100
    })
    expect(byAgent.get('w1')?.total).toBe(183)
  })

  it('returns zeros for a session with no usage', () => {
    repo = new UsageRepo(opened.db)
    expect(repo.sessionTotal('s1')).toEqual({
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      total: 0
    })
    expect(repo.workerTotals('s1').size).toBe(0)
  })
})

describe('usage rows outlive their session', () => {
  it('keeps rows with session_id null and snapshots intact when the session is deleted', () => {
    repo = new UsageRepo(opened.db)
    repo.record(turn({ sessionName: 'S', groupName: 'G', workerLabel: 'api', turnKey: 'k' }))
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    opened.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      session_id: null,
      session_name: 'S',
      group_name: 'G',
      worker_label: 'api',
      input_tokens: 10
    })
    expect(repo.sessionTotal('s1').total).toBe(0)
  })
})

describe('UsageRepo.sessionPanel', () => {
  it('groups one agent by provider and model, summing buckets and taking the max call input', () => {
    repo = new UsageRepo(opened.db)
    repo.record(turn({ agentKey: 'w1', agentRole: 'worker', turnKey: 'a', maxCallInput: 100 }))
    repo.record(turn({ agentKey: 'w1', agentRole: 'worker', turnKey: 'b', maxCallInput: 900 }))
    repo.record(
      turn({
        agentKey: 'w1',
        agentRole: 'worker',
        provider: 'codex',
        model: 'gpt',
        turnKey: 'c',
        maxCallInput: 50
      })
    )
    repo.record(turn({ agentKey: 'brain', turnKey: 'd' }))
    const { rows: panel } = repo.sessionPanel('s1', null)
    expect(panel.map((r) => [r.agentKey, r.provider, r.model, r.rowCount])).toEqual([
      ['brain', 'claude', 'sonnet', 1],
      ['w1', 'claude', 'sonnet', 2],
      ['w1', 'codex', 'gpt', 1]
    ])
    const w1 = panel[1]!
    expect(w1.tokens).toEqual({ input: 20, cacheWrite: 40, cacheRead: 60, output: 80, total: 200 })
    expect(w1.maxCallInput).toBe(900)
  })

  it('returns no rows for an empty session and passes the tracking start through', () => {
    repo = new UsageRepo(opened.db)
    expect(repo.sessionPanel('s1', 5)).toEqual({ trackingStartedAt: 5, rows: [] })
  })

  it('reads usage.trackingStartedAt from app_settings', () => {
    repo = new UsageRepo(opened.db)
    expect(repo.trackingStartedAt()).toBeGreaterThan(0)
    opened.sqlite
      .prepare("UPDATE app_settings SET value_json='1234' WHERE key='usage.trackingStartedAt'")
      .run()
    expect(repo.trackingStartedAt()).toBe(1234)
    opened.sqlite.prepare("DELETE FROM app_settings WHERE key='usage.trackingStartedAt'").run()
    expect(repo.trackingStartedAt()).toBeNull()
  })
})

describe('usageRecordingState', () => {
  it('is not-recorded without rows, partial with rows, when created before tracking', () => {
    expect(usageRecordingState(99, false, 100)).toBe('not-recorded')
    expect(usageRecordingState(99, true, 100)).toBe('partial')
  })

  it('is recorded when created after tracking, with or without rows', () => {
    expect(usageRecordingState(101, false, 100)).toBe('recorded')
    expect(usageRecordingState(101, true, 100)).toBe('recorded')
  })

  it('counts an agent created exactly at the tracking start as recorded', () => {
    expect(usageRecordingState(100, false, 100)).toBe('recorded')
  })

  it('is recorded when no tracking start is known', () => {
    expect(usageRecordingState(1, false, null)).toBe('recorded')
  })
})

describe('UsageRepo setup columns', () => {
  const setupOf = (): { setup_tokens: number; arc_setup_tokens: number }[] =>
    opened.sqlite
      .prepare('SELECT setup_tokens, arc_setup_tokens FROM usage_turns ORDER BY id')
      .all() as { setup_tokens: number; arc_setup_tokens: number }[]
  const seedSetup = (fixed: number | null, arc = 100): void => {
    const setup = new AgentSetupRepo(opened.db)
    setup.upsertAdditions({
      sessionId: 's1',
      agentKey: 'brain',
      provider: 'claude',
      model: 'sonnet',
      arcAdditionsTokens: arc,
      at: 1
    })
    if (fixed !== null) {
      setup.setFixedSetupIfMissing({
        sessionId: 's1',
        agentKey: 'brain',
        provider: 'claude',
        fixedSetupTokens: fixed
      })
    }
  }

  it('fixed known: setup = fixed x calls, arc = additions x calls', () => {
    seedSetup(200, 50)
    repo = new UsageRepo(opened.db)
    repo.record(
      turn({ inputTokens: 100, cacheWriteTokens: 100, cacheReadTokens: 800, callCount: 3 })
    )
    expect(setupOf()).toEqual([{ setup_tokens: 600, arc_setup_tokens: 150 }])
  })

  it('fixed unknown: setup 0, arc = min(turn input, additions x calls)', () => {
    seedSetup(null, 50)
    repo = new UsageRepo(opened.db)
    repo.record(turn({ callCount: 2, turnKey: 'a' })) // input 60, 100 available
    repo.record(turn({ callCount: 1, turnKey: 'b' })) // 50
    expect(setupOf()).toEqual([
      { setup_tokens: 0, arc_setup_tokens: 60 },
      { setup_tokens: 0, arc_setup_tokens: 50 }
    ])
  })

  it('caps setup at the turn input and arc at setup', () => {
    seedSetup(1000, 5000)
    repo = new UsageRepo(opened.db)
    repo.record(turn({ callCount: 2 })) // input 60
    expect(setupOf()).toEqual([{ setup_tokens: 60, arc_setup_tokens: 60 }])
  })

  it('records 0 for helper rows, rows without a session, and agents without a setup row', () => {
    seedSetup(200)
    repo = new UsageRepo(opened.db)
    repo.record(turn({ source: 'helper', callCount: 1, turnKey: 'h' }))
    repo.record(turn({ sessionId: null, callCount: 1, turnKey: 'n' }))
    repo.record(turn({ agentKey: 'w9', callCount: 1, turnKey: 'w' }))
    expect(setupOf()).toEqual([
      { setup_tokens: 0, arc_setup_tokens: 0 },
      { setup_tokens: 0, arc_setup_tokens: 0 },
      { setup_tokens: 0, arc_setup_tokens: 0 }
    ])
  })

  it('sessionPanel sums setup and arc setup per group', () => {
    seedSetup(20, 10)
    repo = new UsageRepo(opened.db)
    repo.record(turn({ callCount: 1, turnKey: 'a' }))
    repo.record(turn({ callCount: 2, turnKey: 'b' }))
    const row = repo.sessionPanel('s1', null).rows[0]!
    expect(row.setupTokens).toBe(60)
    expect(row.arcSetupTokens).toBe(30)
  })
})

describe('usage range reports', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime()
  const at = (daysAgo: number, h = 12, m = 0): number =>
    new Date(2026, 9, 20 - daysAgo, h, m).getTime()
  let n = 0
  const put = (over: Partial<UsageTurnInput>): void => {
    repo.record(turn({ turnKey: `k${n++}`, ...over }))
  }
  const tok = { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  const tokens = (total: number): Partial<UsageTurnInput> => ({ ...tok, inputTokens: total })

  beforeEach(() => {
    repo = new UsageRepo(opened.db)
    n = 0
  })

  it('computes local day windows', () => {
    expect(usageRangeDays('today', now)).toEqual({ fromDay: '2026-10-20', toDay: '2026-10-20' })
    expect(usageRangeDays('7d', now).fromDay).toBe('2026-10-14')
    expect(usageRangeDays('30d', now).fromDay).toBe('2026-09-21')
    expect(usageRangeDays('all', now).fromDay).toBeNull()
  })

  it('applies range boundaries in local time', () => {
    put({ at: at(1, 23, 59), ...tokens(1) })
    put({ at: at(0, 0, 1), ...tokens(10) })
    put({ at: at(6), ...tokens(100) })
    put({ at: at(7), ...tokens(1000) })
    expect(repo.rangeTotals('today', now).total.total).toBe(10)
    expect(repo.rangeTotals('7d', now).total.total).toBe(111)
    expect(repo.rangeTotals('all', now).total.total).toBe(1111)
  })

  it('includes the plan check in totals and reports it separately', () => {
    put({ ...tokens(100) })
    put({ ...tokens(7), agentRole: 'plan_check', provider: 'claude', model: 'haiku' })
    put({ ...tokens(50), provider: 'codex', model: 'gpt' })
    const r = repo.rangeTotals('today', now)
    expect(r.total.total).toBe(157)
    expect(r.planCheck.total).toBe(7)
    expect(r.byProvider.map((p) => [p.provider, p.tokens.total])).toEqual([
      ['claude', 107],
      ['codex', 50]
    ])
    expect(r.byModel.map((m) => [m.model, m.tokens.total])).toEqual([
      ['sonnet', 100],
      ['gpt', 50],
      ['haiku', 7]
    ])
  })

  it('zero-fills days and handles empty and all ranges', () => {
    expect(repo.dailyByProvider('all', now)).toEqual([])
    put({ at: at(3), ...tokens(5) })
    put({ at: at(3), ...tokens(2), provider: 'codex', model: 'gpt' })
    put({ at: at(0), ...tokens(9) })
    const all = repo.dailyByProvider('all', now)
    expect(all.map((d) => d.day)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'])
    expect(all[0]!.byProvider).toEqual({ claude: 5, codex: 2 })
    expect(all[1]!.byProvider).toEqual({})
    expect(repo.dailyByProvider('7d', now)).toHaveLength(7)
    expect(repo.dailyByProvider('today', now)).toEqual([
      { day: '2026-10-20', byProvider: { claude: 9 } }
    ])
  })

  it('ranks sessions with live names, excludes plan check, and marks deleted sessions', () => {
    seedSession('s2')
    opened.sqlite.prepare("UPDATE sessions SET name='Live two' WHERE id='s2'").run()
    put({ sessionId: 's1', sessionName: 'old', ...tokens(10) })
    put({ sessionId: 's2', ...tokens(30) })
    put({ sessionId: null, sessionName: 'Gone', groupName: 'Old group', ...tokens(20) })
    put({ sessionId: null, agentRole: 'plan_check', ...tokens(999) })
    const rows = repo.biggestSpenders('7d', 'session', 10, now)
    expect(rows.map((r) => [r.name, r.groupName, r.total, r.clickable])).toEqual([
      ['Live two', 'G', 30, true],
      ['Gone', 'Old group', 20, false],
      ['S', 'G', 10, true]
    ])
    expect(rows[0]).toMatchObject({ sessionId: 's2', provider: 'claude', model: 'sonnet' })
    expect(repo.biggestSpenders('7d', 'session', 1, now)).toHaveLength(1)
  })

  it('shows Mixed when a row spans more than one provider and model', () => {
    put({ ...tokens(10) })
    put({ ...tokens(5), provider: 'codex', model: 'gpt' })
    const [row] = repo.biggestSpenders('7d', 'session', 5, now)
    expect(row).toMatchObject({ total: 15, provider: 'Mixed', model: 'Mixed' })
  })

  it('ranks workers and resolvers by session and agent', () => {
    put({ agentKey: 'w1', agentRole: 'worker', workerId: 'w1', workerLabel: 'W2', ...tokens(40) })
    put({ agentKey: 'w1', agentRole: 'worker', workerId: 'w1', workerLabel: 'W2', ...tokens(5) })
    put({ agentKey: 'resolver:w1', agentRole: 'resolver', workerLabel: 'R', ...tokens(50) })
    put({ agentKey: 'brain', ...tokens(500) })
    const rows = repo.biggestSpenders('7d', 'worker', 10, now)
    expect(rows.map((r) => [r.name, r.total, r.clickable])).toEqual([
      ['R · S', 50, true],
      ['W2 · S', 45, true]
    ])
    expect(rows[1]).toMatchObject({ workerId: 'w1', sessionId: 's1' })
  })

  it('ranks commands with runs and group counts', () => {
    seedSession('s2')
    opened.sqlite
      .prepare(
        "INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g2','H','h',1,1)"
      )
      .run()
    opened.sqlite.prepare("UPDATE sessions SET group_id='g2' WHERE id='s2'").run()
    put({ command: '/plan', agentKey: 'w1', ...tokens(10) })
    put({ command: '/plan', agentKey: 'w1', ...tokens(10) })
    put({ command: '/plan', agentKey: 'w2', sessionId: 's2', ...tokens(10) })
    put({ command: '/fix', agentKey: 'w3', ...tokens(100) })
    put({ ...tokens(1000) })
    const rows = repo.biggestSpenders('7d', 'command', 10, now)
    expect(rows.map((r) => [r.name, r.total, r.runs, r.groupName, r.clickable])).toEqual([
      ['/fix', 100, 1, 'G', false],
      ['/plan', 30, 2, '2 groups', false]
    ])
  })
})
