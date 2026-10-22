import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AgentSetupRepo } from '../../../src/main/db/repositories/agent-setup-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { UsageRepo } from '../../../src/main/db/repositories/usage-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { bridgeToolDescriptions, estimateSetup } from '../../../src/main/usage/setup-estimator'
import { UsageRecorder } from '../../../src/main/usage/usage-recorder'
import type { UsageAgent, UsageRun } from '../../../src/main/usage/usage-recorder'
import { buildWorkerViews } from '../../../src/main/sessions/worker-manager'
import type { SessionUsage } from '../../../src/shared/types/usage'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let recorder: UsageRecorder
let pushes: SessionUsage[]
let changed: number
let clock: number

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>

function usage(over: Partial<UsageEvent> = {}): AgentEvent {
  return {
    type: 'usage',
    agentId: 'a',
    ts: 1,
    scope: 'turn',
    input: 10,
    cacheWrite: 20,
    cacheRead: 30,
    output: 40,
    maxCallInput: 60,
    callCount: 1,
    partial: false,
    ...over
  } as AgentEvent
}

const turnResult: AgentEvent = {
  type: 'turn-result',
  agentId: 'a',
  ts: 2,
  ok: true,
  interrupted: false,
  durationMs: 5,
  status: 'completed'
}
const exit: AgentEvent = {
  type: 'exit',
  agentId: 'a',
  ts: 3,
  code: 0,
  signal: null,
  expected: true,
  stderrTail: ''
}

const brain: UsageAgent = {
  sessionId: 's1',
  agentKey: 'brain',
  role: 'brain',
  provider: () => 'claude',
  model: () => 'sonnet'
}
const worker: UsageAgent = {
  sessionId: 's1',
  agentKey: 'w1',
  role: 'worker',
  workerId: 'w1',
  workerLabel: 'W2',
  command: '/awos:spec',
  provider: () => 'codex',
  model: () => 'gpt-5.5'
}

const runOf = (over: Partial<UsageRun> = {}): UsageRun => ({
  resumed: false,
  instructions: 'x'.repeat(400),
  ...over
})

function setTracking(at: number): void {
  opened.sqlite
    .prepare("UPDATE app_settings SET value_json=? WHERE key='usage.trackingStartedAt'")
    .run(String(at))
}

const rows = (): Record<string, unknown>[] =>
  opened.sqlite.prepare('SELECT * FROM usage_turns ORDER BY id').all() as Record<string, unknown>[]

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  opened.sqlite
    .prepare(
      "INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g1','Docs group','docs group',1,1)"
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
       VALUES ('s1','g1','Fix the docs','autonomous',2,'auto','sonnet','active',1,1)`
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO workers (id,session_id,number,slug,task,project_ids_json,model,status,created_at,updated_at)
       VALUES ('w1','s1',2,'docs-update','t','[]','gpt-5.5','working',1,1)`
    )
    .run()
  // Every fixture agent counts as created after tracking started unless a test says otherwise.
  setTracking(0)
  pushes = []
  changed = 0
  clock = Date.UTC(2026, 9, 20, 12)
  recorder = new UsageRecorder({
    repo: new UsageRepo(opened.db),
    setupRepo: new AgentSetupRepo(opened.db),
    sessionsRepo: new SessionsRepo(opened.db),
    groupsRepo: new GroupsRepo(opened.db),
    workersRepo: new WorkersRepo(opened.db),
    emit: (u) => pushes.push(u),
    emitChanged: () => (changed += 1),
    now: () => clock
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  recorder.dispose()
  vi.useRealTimers()
  opened.sqlite.close()
})

describe('UsageRecorder rows', () => {
  it('writes one row for a Claude turn of several requests, on turn-result', () => {
    const t = recorder.track(brain, runOf())
    // The parser already folds the turn's requests into one event (callCount 3).
    // The event changes the in-flight figure but writes no row.
    expect(
      t.onEvent(usage({ turnId: '1', input: 100, cacheRead: 900, maxCallInput: 700, callCount: 3 }))
    ).toBe(true)
    expect(rows()).toHaveLength(0)
    expect(t.onEvent(turnResult)).toBe(true)
    const [row] = rows()
    expect(rows()).toHaveLength(1)
    expect(row).toMatchObject({
      input_tokens: 100,
      cache_read_tokens: 900,
      max_call_input: 700,
      call_count: 3,
      source: 'turn'
    })
  })

  it('sums two Codex updates of one turn into one row', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(
      usage({
        turnId: 'T1',
        input: 10,
        cacheWrite: 0,
        cacheRead: 50,
        output: 5,
        maxCallInput: 60,
        contextWindow: 100
      })
    )
    t.onEvent(
      usage({
        turnId: 'T1',
        input: 20,
        cacheWrite: 0,
        cacheRead: 80,
        output: 7,
        maxCallInput: 100,
        contextWindow: 200
      })
    )
    t.onEvent(turnResult)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      input_tokens: 30,
      cache_read_tokens: 130,
      output_tokens: 12,
      max_call_input: 100,
      call_count: 2,
      context_window: 200,
      model: 'gpt-5.5',
      provider: 'codex'
    })
  })

  it('keeps the process run in the turn key, so sequence numbers of a resumed run do not collide', () => {
    const run = (): void => {
      const t = recorder.track(brain, runOf())
      t.onEvent(usage({ turnId: '1' }))
      t.onEvent(turnResult)
    }
    run()
    run()
    // Two process runs of the same agent with the same Claude sequence number are two turns.
    expect(rows()).toHaveLength(2)
    const keys = rows().map((r) => r.turn_key)
    expect(new Set(keys).size).toBe(2)
  })

  it('flushes on exit when no turn-result arrived, as a partial row', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1' }))
    expect(t.onEvent(exit)).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ source: 'partial', input_tokens: 10 })
  })

  it('writes nothing on exit when there is no unwritten usage', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1' }))
    t.onEvent(turnResult)
    expect(t.onEvent(exit)).toBe(false)
    expect(rows()).toHaveLength(1)
  })

  it('records a partial event as source partial, and a later result for the turn adds no second row', () => {
    // The unique turn_key would also reject a second row; count the attempts to test the flag itself.
    const attempts = vi.spyOn(UsageRepo.prototype, 'record')
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1', partial: true }))
    t.onEvent(turnResult)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.source).toBe('partial')
    // The real figures for the same turn show up afterwards: the turn already has its row.
    expect(t.onEvent(usage({ turnId: '1', input: 999 }))).toBe(false)
    t.onEvent(turnResult)
    t.onEvent(exit)
    expect(attempts).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.input_tokens).toBe(10)
  })

  it('writes helper events straight through as their own rows without touching the turn', () => {
    const t = recorder.track(brain, runOf())
    expect(
      t.onEvent(usage({ scope: 'helper', input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }))
    ).toBe(true)
    t.onEvent(usage({ turnId: '1' }))
    t.onEvent(turnResult)
    expect(rows().map((r) => [r.source, r.input_tokens, r.max_call_input])).toEqual([
      ['helper', 1, 0],
      ['turn', 10, 60]
    ])
  })

  it('fills the snapshots', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(usage({ turnId: 'T1' }))
    t.onEvent(turnResult)
    expect(rows()[0]).toMatchObject({
      session_id: 's1',
      session_name: 'Fix the docs',
      group_id: 'g1',
      group_name: 'Docs group',
      worker_label: 'W2',
      worker_id: 'w1',
      command: '/awos:spec',
      agent_role: 'worker',
      agent_key: 'w1',
      provider: 'codex',
      model: 'gpt-5.5',
      day: '2026-10-20'
    })
    const b = recorder.track(brain, runOf())
    b.onEvent(usage({ turnId: '1', model: 'claude-sonnet-5-5' }))
    b.onEvent(turnResult)
    expect(rows()[1]).toMatchObject({
      agent_role: 'brain',
      agent_key: 'brain',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      worker_label: null
    })
  })

  it('stores a resolver under resolver:<id>', () => {
    const t = recorder.track({ ...worker, agentKey: 'resolver:w1', role: 'resolver' }, runOf())
    t.onEvent(usage({ turnId: 'T1' }))
    t.onEvent(turnResult)
    expect(rows()[0]).toMatchObject({ agent_key: 'resolver:w1', agent_role: 'resolver' })
  })
})

describe('UsageRecorder snapshot and push', () => {
  it('returns the session snapshot with zeros for agents that have no rows', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(usage({ turnId: 'T1' }))
    t.onEvent(turnResult)
    const snap = recorder.snapshot('s1')
    expect(snap.sessionId).toBe('s1')
    expect(snap.total).toEqual({ input: 10, cacheWrite: 20, cacheRead: 30, output: 40, total: 100 })
    expect(
      snap.agents.map((a) => [a.agentKey, a.role, a.label, a.provider, a.tokens?.total])
    ).toEqual([
      ['brain', 'brain', 'Brain', 'claude', 0],
      ['w1', 'worker', 'W2 · docs-update', 'claude', 100]
    ])
    expect(snap.updatedAt).toBe(clock)
  })

  it('coalesces rows recorded within a second into one push, on the trailing edge', () => {
    vi.useFakeTimers()
    const t = recorder.track(brain, runOf())
    for (const id of ['1', '2', '3']) {
      t.onEvent(usage({ turnId: id }))
      t.onEvent(turnResult)
    }
    expect(pushes).toHaveLength(0)
    vi.advanceTimersByTime(999)
    expect(pushes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.total.total).toBe(300)
    // A later row starts a new window.
    t.onEvent(usage({ turnId: '4' }))
    t.onEvent(turnResult)
    vi.advanceTimersByTime(1000)
    expect(pushes).toHaveLength(2)
    expect(pushes[1]?.total.total).toBe(400)
  })

  it('gives worker views their total through buildWorkerViews', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(usage({ turnId: 'T1' }))
    t.onEvent(turnResult)
    const tokensOf = recorder.tokensOf('s1')
    const views = buildWorkerViews(
      's1',
      new WorkersRepo(opened.db),
      { listBySession: () => [] } as never,
      { listBySession: () => [] } as never,
      { listByWorker: () => [] } as never,
      undefined,
      undefined,
      tokensOf
    )
    expect(views[0]?.tokens?.total).toBe(100)
  })
})

describe('UsageRecorder full snapshot', () => {
  const addWorker = (id: string, number: number, slug: string, createdAt: number): void => {
    opened.sqlite
      .prepare(
        `INSERT INTO workers (id,session_id,number,slug,task,project_ids_json,model,status,created_at,updated_at)
         VALUES (?,'s1',?,?,'t','[]','sonnet','working',?,?)`
      )
      .run(id, number, slug, createdAt, createdAt)
  }
  const feed = (agent: UsageAgent, over: Partial<UsageEvent> = {}): void => {
    const t = recorder.track(agent, runOf())
    t.onEvent(usage(over))
    t.onEvent(turnResult)
  }
  const claudeWorker: UsageAgent = {
    ...worker,
    agentKey: 'w2',
    workerId: 'w2',
    workerLabel: 'W3',
    provider: () => 'claude',
    model: () => 'sonnet'
  }

  it('reports brain, a Claude worker and a Codex worker, per provider, adding up to the total', () => {
    addWorker('w2', 3, 'api', 1)
    feed(brain, { turnId: '1', maxCallInput: 500 })
    feed(claudeWorker, { turnId: '1', input: 1, cacheWrite: 2, cacheRead: 3, output: 4 })
    feed(worker, { turnId: '1', input: 5, cacheWrite: 0, cacheRead: 0, output: 5 })
    const snap = recorder.snapshot('s1')
    expect(snap.agents.map((a) => [a.agentKey, a.label, a.recording, a.tokens?.total])).toEqual([
      ['brain', 'Brain', 'recorded', 100],
      ['w1', 'W2 · docs-update', 'recorded', 10],
      ['w2', 'W3 · api', 'recorded', 10]
    ])
    expect(snap.agents[0]).toMatchObject({
      maxCallInput: 500,
      byModel: [{ provider: 'claude', model: 'sonnet', tokens: { total: 100 } }]
    })
    expect(snap.byProvider.claude?.total).toBe(110)
    expect(snap.byProvider.codex).toEqual({
      input: 5,
      cacheWrite: 0,
      cacheRead: 0,
      output: 5,
      total: 10
    })
    expect(snap.total.total).toBe(120)
    expect(snap.agents.reduce((n, a) => n + (a.tokens?.total ?? 0), 0)).toBe(snap.total.total)
    expect(snap.partial).toBe(false)
  })

  it('splits an agent that spans models into byModel', () => {
    feed(brain, { turnId: '1' })
    feed({ ...brain, provider: () => 'codex', model: () => 'gpt-5.5' }, { turnId: '2' })
    const brainUsage = recorder.snapshot('s1').agents[0]
    expect(brainUsage?.tokens?.total).toBe(200)
    expect(brainUsage?.byModel.map((m) => [m.provider, m.model, m.tokens.total])).toEqual([
      ['claude', 'sonnet', 100],
      ['codex', 'gpt-5.5', 100]
    ])
  })

  it('marks an agent created before tracking with no rows as not recorded, with null tokens', () => {
    setTracking(100)
    const snap = recorder.snapshot('s1')
    expect(snap.agents.map((a) => [a.agentKey, a.recording, a.tokens, a.byModel])).toEqual([
      ['brain', 'not-recorded', null, []],
      ['w1', 'not-recorded', null, []]
    ])
    expect(snap.partial).toBe(false)
    const view = buildWorkerViews(
      's1',
      new WorkersRepo(opened.db),
      { listBySession: () => [] } as never,
      { listBySession: () => [] } as never,
      { listByWorker: () => [] } as never,
      undefined,
      undefined,
      recorder.tokensOf('s1')
    )
    expect(view[0]?.tokens).toBeNull()
  })

  it('marks an agent created before tracking with rows as partial and flags the session', () => {
    setTracking(100)
    addWorker('w2', 3, 'api', 200)
    feed(worker, { turnId: '1' })
    const snap = recorder.snapshot('s1')
    expect(snap.agents.map((a) => [a.agentKey, a.recording, a.tokens?.total ?? null])).toEqual([
      ['brain', 'not-recorded', null],
      ['w1', 'partial', 100],
      ['w2', 'recorded', 0]
    ])
    expect(snap.partial).toBe(true)
  })

  it('still counts the usage of a removed worker', () => {
    addWorker('w2', 3, 'api', 1)
    feed(brain, { turnId: '1' })
    feed(claudeWorker, { turnId: '1' })
    opened.sqlite.prepare("DELETE FROM workers WHERE id='w2'").run()
    const snap = recorder.snapshot('s1')
    expect(snap.total.total).toBe(200)
    expect(snap.agents.reduce((n, a) => n + (a.tokens?.total ?? 0), 0)).toBe(200)
    expect(snap.agents.find((a) => a.agentKey === 'w2')).toMatchObject({
      role: 'worker',
      label: 'W3',
      provider: 'claude',
      model: 'sonnet',
      recording: 'recorded'
    })
  })
})

describe('UsageRecorder setup', () => {
  const setupRow = (agentKey: string, provider: string): Record<string, unknown> | undefined =>
    opened.sqlite
      .prepare('SELECT * FROM agent_setup WHERE session_id=? AND agent_key=? AND provider=?')
      .get('s1', agentKey, provider) as Record<string, unknown> | undefined
  const expectedAdditions = (instructions: string, role: 'brain' | 'worker'): number =>
    estimateSetup({ instructions, toolDescriptions: bridgeToolDescriptions(role) }).tokens
  const firstCall = { input: 100, cacheWrite: 300, cacheRead: 600 }

  it('stores Arc additions at start, before any event, and refreshes them at resume', () => {
    recorder.track(brain, runOf({ instructions: 'a'.repeat(400) }))
    expect(setupRow('brain', 'claude')).toMatchObject({
      arc_additions_tokens: expectedAdditions('a'.repeat(400), 'brain'),
      fixed_setup_tokens: null,
      model: 'sonnet'
    })
    recorder.track(brain, runOf({ resumed: true, instructions: 'a'.repeat(4000) }))
    expect(setupRow('brain', 'claude')).toMatchObject({
      arc_additions_tokens: expectedAdditions('a'.repeat(4000), 'brain'),
      fixed_setup_tokens: null
    })
    expect(expectedAdditions('a'.repeat(4000), 'brain')).toBeGreaterThan(
      expectedAdditions('a'.repeat(400), 'brain')
    )
  })

  it('uses the worker tool set for workers and resolvers', () => {
    recorder.track(worker, runOf({ instructions: '' }))
    expect(setupRow('w1', 'codex')?.arc_additions_tokens).toBe(expectedAdditions('', 'worker'))
    const resolver: UsageAgent = { ...worker, agentKey: 'resolver:w1', role: 'resolver' }
    recorder.track(resolver, runOf({ instructions: '' }))
    expect(setupRow('resolver:w1', 'codex')?.arc_additions_tokens).toBe(
      expectedAdditions('', 'worker')
    )
  })

  it('sets the fixed setup from the firstCall of a new thread, before that turn row is written', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1', firstCall, input: 100, cacheWrite: 300, cacheRead: 600 }))
    t.onEvent(turnResult)
    expect(setupRow('brain', 'claude')?.fixed_setup_tokens).toBe(1000)
    // The first turn's own row already carries the setup columns.
    expect(rows()[0]).toMatchObject({ setup_tokens: 1000 })
    expect(Number(rows()[0]?.arc_setup_tokens)).toBeGreaterThan(0)
  })

  it('does not set the fixed setup from the firstCall of a resumed run', () => {
    const t = recorder.track(brain, runOf({ resumed: true }))
    t.onEvent(usage({ turnId: '1', firstCall }))
    t.onEvent(turnResult)
    expect(setupRow('brain', 'claude')?.fixed_setup_tokens).toBeNull()
  })

  it('keeps the fixed setup of the new thread across a resume', () => {
    const first = recorder.track(brain, runOf())
    first.onEvent(usage({ turnId: '1', firstCall }))
    first.onEvent(turnResult)
    const resumed = recorder.track(brain, runOf({ resumed: true }))
    resumed.onEvent(usage({ turnId: '1', firstCall: { input: 5, cacheWrite: 5, cacheRead: 5000 } }))
    resumed.onEvent(turnResult)
    expect(setupRow('brain', 'claude')?.fixed_setup_tokens).toBe(1000)
  })

  it('splits the snapshot into fixed setup and the work, adding up to the input total', () => {
    const t = recorder.track(brain, runOf())
    // Turn 1: two requests of 1000 setup each plus 500 of work; turn 2: one request.
    t.onEvent(
      usage({
        turnId: '1',
        firstCall,
        input: 600,
        cacheWrite: 300,
        cacheRead: 1600,
        callCount: 2,
        output: 50
      })
    )
    t.onEvent(turnResult)
    t.onEvent(
      usage({ turnId: '2', input: 10, cacheWrite: 0, cacheRead: 1000, callCount: 1, output: 5 })
    )
    t.onEvent(turnResult)
    const snap = recorder.snapshot('s1')
    const agent = snap.agents.find((a) => a.agentKey === 'brain')
    const inputTotal = 600 + 300 + 1600 + 10 + 1000
    expect(agent?.setup.fixedSetupPerRequest).toBe(1000)
    expect(agent?.setup.arcAdditionsPerRequest).toBe(
      Math.min(expectedAdditions('x'.repeat(400), 'brain'), 1000)
    )
    expect(agent?.setup.setupTokens).toBe(2000 + 1000)
    expect((agent?.setup.setupTokens ?? 0) + (agent?.setup.work ?? 0)).toBe(inputTotal)
    expect(agent?.setup.arcSetupTokens).toBeLessThanOrEqual(agent?.setup.setupTokens ?? 0)
    expect(snap.setupShare).toBeCloseTo(3000 / snap.total.total)
    expect(snap.arcSetupShare).toBeCloseTo((agent?.setup.arcSetupTokens ?? 0) / snap.total.total)
  })

  it("never shows Arc's additions above the measured fixed setup", () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1', firstCall: { input: 5, cacheWrite: 5, cacheRead: 10 } }))
    t.onEvent(turnResult)
    const agent = recorder.snapshot('s1').agents.find((a) => a.agentKey === 'brain')
    expect(expectedAdditions('x'.repeat(400), 'brain')).toBeGreaterThan(20)
    expect(agent?.setup.fixedSetupPerRequest).toBe(20)
    expect(agent?.setup.arcAdditionsPerRequest).toBe(20)
  })

  it("shows Arc's whole estimate when the fixed setup is larger", () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1', firstCall: { input: 5, cacheWrite: 5, cacheRead: 20_000 } }))
    t.onEvent(turnResult)
    const agent = recorder.snapshot('s1').agents.find((a) => a.agentKey === 'brain')
    expect(agent?.setup.arcAdditionsPerRequest).toBe(expectedAdditions('x'.repeat(400), 'brain'))
  })

  it('has null shares and null per-request values before anything is recorded', () => {
    const snap = recorder.snapshot('s1')
    expect(snap.setupShare).toBeNull()
    expect(snap.arcSetupShare).toBeNull()
    expect(snap.agents[0]?.setup).toEqual({
      arcAdditionsPerRequest: null,
      fixedSetupPerRequest: null,
      setupTokens: 0,
      arcSetupTokens: 0,
      work: 0
    })
  })

  it('sums both providers of a brain and reads the per-request values from the current one', () => {
    let provider: 'claude' | 'codex' = 'claude'
    const switching: UsageAgent = { ...brain, provider: () => provider }
    const a = recorder.track(switching, runOf())
    a.onEvent(usage({ turnId: '1', firstCall, input: 100, cacheWrite: 300, cacheRead: 600 }))
    a.onEvent(turnResult)
    provider = 'codex'
    opened.sqlite.prepare("UPDATE sessions SET brain_provider='codex' WHERE id='s1'").run()
    const b = recorder.track(switching, runOf())
    b.onEvent(
      usage({
        turnId: '1',
        firstCall: { input: 50, cacheWrite: 0, cacheRead: 150 },
        input: 50,
        cacheWrite: 0,
        cacheRead: 150
      })
    )
    b.onEvent(turnResult)
    const agent = recorder.snapshot('s1').agents.find((x) => x.agentKey === 'brain')
    expect(agent?.setup.setupTokens).toBe(1000 + 200)
    expect(agent?.setup.fixedSetupPerRequest).toBe(200)
    expect((agent?.setup.setupTokens ?? 0) + (agent?.setup.work ?? 0)).toBe(1000 + 200)
  })
})

describe('UsageRecorder.recordPlanCheck', () => {
  it('writes one plan_check row with no session and pushes nothing', () => {
    vi.useFakeTimers()
    try {
      expect(
        recorder.recordPlanCheck({
          provider: 'claude',
          model: 'claude-haiku-5-5',
          input: 2,
          cacheWrite: 582,
          cacheRead: 0,
          output: 159,
          maxCallInput: 584,
          callCount: 1,
          contextWindow: 200000
        })
      ).toBe(true)
      vi.advanceTimersByTime(5000)
    } finally {
      vi.useRealTimers()
    }
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      session_id: null,
      agent_key: 'plan-check',
      agent_role: 'plan_check',
      provider: 'claude',
      model: 'claude-haiku-5-5',
      source: 'turn',
      input_tokens: 2,
      cache_write_tokens: 582,
      output_tokens: 159
    })
    expect(pushes).toEqual([])
  })
})

describe('UsageRecorder usage:changed push', () => {
  it('coalesces several recordings into one push per 5 s window', () => {
    vi.useFakeTimers()
    const t = recorder.track(brain, runOf())
    for (let i = 1; i <= 3; i += 1) {
      t.onEvent(usage({ turnId: String(i) }))
      t.onEvent({ ...turnResult, ts: i })
    }
    expect(rows()).toHaveLength(3)
    expect(changed).toBe(0)
    vi.advanceTimersByTime(4999)
    expect(changed).toBe(0)
    vi.advanceTimersByTime(1)
    expect(changed).toBe(1)
    // A later recording starts a new window.
    t.onEvent(usage({ turnId: '4' }))
    t.onEvent({ ...turnResult, ts: 4 })
    vi.advanceTimersByTime(5000)
    expect(changed).toBe(2)
  })

  it('fires for a plan check recording, and not when it was not stored', () => {
    vi.useFakeTimers()
    const check = {
      provider: 'claude' as const,
      model: 'haiku',
      input: 5,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1,
      maxCallInput: 5,
      callCount: 1
    }
    expect(recorder.recordPlanCheck(check)).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(changed).toBe(1)
    // Same instant, same turn key: ignored, no push.
    expect(recorder.recordPlanCheck(check)).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(changed).toBe(1)
  })
})

type ProgressEvent = Extract<AgentEvent, { type: 'usage-progress' }>

function progress(over: Partial<ProgressEvent> = {}): AgentEvent {
  return {
    type: 'usage-progress',
    agentId: 'a',
    ts: 1,
    turnId: '1',
    input: 3,
    cacheWrite: 40,
    cacheRead: 600,
    output: 20,
    callCount: 1,
    ...over
  } as AgentEvent
}

describe('UsageRecorder in-flight usage', () => {
  const codexUpdate = (turnId: string): AgentEvent =>
    usage({ turnId, input: 100, cacheWrite: 0, cacheRead: 40, output: 30, maxCallInput: 140 })

  it('adds the pending usage of a running turn to the agent, the session and the provider', () => {
    const t = recorder.track(worker, runOf())
    expect(t.onEvent(codexUpdate('T1'))).toBe(true)
    expect(t.onEvent(codexUpdate('T1'))).toBe(true)
    expect(rows()).toHaveLength(0)
    const snap = recorder.snapshot('s1')
    const w = snap.agents.find((a) => a.agentKey === 'w1')
    expect(w?.inFlight).toEqual({
      input: 200,
      cacheWrite: 0,
      cacheRead: 80,
      output: 60,
      total: 340
    })
    expect(w?.tokens?.total).toBe(340)
    expect(snap.total.total).toBe(340)
    expect(snap.byProvider.codex?.total).toBe(340)
    // The brain has nothing in flight: no field at all.
    expect(snap.agents.find((a) => a.agentKey === 'brain')?.inFlight).toBeUndefined()
  })

  it('adds the in-flight usage to the saved rows of the agent', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(codexUpdate('T1'))
    t.onEvent(turnResult)
    t.onEvent(codexUpdate('T2'))
    const w = recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')
    expect(w?.tokens?.total).toBe(170 + 170)
    expect(w?.inFlight?.total).toBe(170)
  })

  it('takes Claude progress as a running total that replaces the last one', () => {
    const t = recorder.track(brain, runOf())
    expect(t.onEvent(progress({ cacheRead: 600, callCount: 1 }))).toBe(true)
    expect(t.onEvent(progress({ cacheRead: 1300, output: 40, callCount: 2 }))).toBe(true)
    const b = recorder.snapshot('s1').agents.find((a) => a.agentKey === 'brain')
    expect(b?.inFlight).toEqual({
      input: 3,
      cacheWrite: 40,
      cacheRead: 1300,
      output: 40,
      total: 1383
    })
  })

  it('clears the in-flight figure in the same snapshot that shows the row, with no double count', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(progress({ cacheRead: 1300, output: 40, callCount: 2 }))
    // The result brings the authoritative figures; they take over from the progress.
    t.onEvent(usage({ turnId: '1', input: 6, cacheWrite: 80, cacheRead: 1500, output: 45 }))
    expect(recorder.snapshot('s1').total.total).toBe(1631)
    t.onEvent(turnResult)
    const snap = recorder.snapshot('s1')
    const b = snap.agents.find((a) => a.agentKey === 'brain')
    expect(b?.inFlight).toBeUndefined()
    expect(b?.tokens?.total).toBe(1631)
    expect(snap.total.total).toBe(
      rows().reduce(
        (sum, r) =>
          sum +
          Number(r.input_tokens) +
          Number(r.cache_write_tokens) +
          Number(r.cache_read_tokens) +
          Number(r.output_tokens),
        0
      )
    )
    expect(rows()).toHaveLength(1)
  })

  it('ignores progress for a turn that already has its row', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage({ turnId: '1' }))
    t.onEvent(turnResult)
    expect(t.onEvent(progress({ turnId: '1' }))).toBe(false)
    expect(recorder.snapshot('s1').agents[0]?.inFlight).toBeUndefined()
  })

  it('drops progress at the end of a turn that spent nothing, and on exit writes the same partial row as before', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(progress())
    // No usage event came (an interrupted turn with nothing to report): the figure goes, no row.
    expect(t.onEvent(turnResult)).toBe(true)
    expect(rows()).toHaveLength(0)
    expect(recorder.snapshot('s1').total.total).toBe(0)
    // A crash with Codex usage pending still writes its partial row, and the in-flight figure leaves with it.
    const w = recorder.track(worker, runOf())
    w.onEvent(codexUpdate('T1'))
    expect(recorder.snapshot('s1').total.total).toBe(170)
    w.onEvent(exit)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.source).toBe('partial')
    expect(recorder.snapshot('s1').total.total).toBe(170)
    expect(
      recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')?.inFlight
    ).toBeUndefined()
  })

  it('drops the in-flight figure of a Claude process that exits mid-turn, without a row', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(progress())
    expect(recorder.snapshot('s1').total.total).toBe(663)
    expect(t.onEvent(exit)).toBe(true)
    expect(rows()).toHaveLength(0)
    expect(recorder.snapshot('s1').total.total).toBe(0)
  })

  it('keeps a late Codex update after the row as its own row, not in flight', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(codexUpdate('T1'))
    t.onEvent(turnResult)
    expect(t.onEvent(codexUpdate('T1'))).toBe(true)
    expect(rows()).toHaveLength(2)
    expect(
      recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')?.inFlight
    ).toBeUndefined()
  })

  it('keeps shares, byModel and the setup split on saved rows only', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(usage({ turnId: 'T1', firstCall: { input: 50, cacheWrite: 0, cacheRead: 0 } }))
    t.onEvent(turnResult)
    const before = recorder.snapshot('s1')
    t.onEvent(codexUpdate('T2'))
    const during = recorder.snapshot('s1')
    const pick = (s: SessionUsage): unknown => [
      s.setupShare,
      s.arcSetupShare,
      s.agents.find((a) => a.agentKey === 'w1')?.byModel,
      s.agents.find((a) => a.agentKey === 'w1')?.setup
    ]
    expect(pick(during)).toEqual(pick(before))
  })

  it('leaves them out of the snapshot the suggestions read', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(codexUpdate('T1'))
    const saved = recorder.snapshot('s1', false)
    expect(saved.total.total).toBe(0)
    expect(saved.agents.find((a) => a.agentKey === 'w1')?.inFlight).toBeUndefined()
  })

  it('counts an agent from before tracking, mid-turn, as partial instead of not recorded', () => {
    setTracking(clock + 1000)
    opened.sqlite.prepare("UPDATE workers SET created_at = 1 WHERE id = 'w1'").run()
    expect(recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')?.tokens).toBeNull()
    recorder.track(worker, runOf()).onEvent(codexUpdate('T1'))
    const w = recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')
    expect(w?.recording).toBe('partial')
    expect(w?.tokens?.total).toBe(170)
  })

  it('pushes the snapshot on the existing one-second window, without a usage:changed push', () => {
    vi.useFakeTimers()
    const t = recorder.track(worker, runOf())
    for (let i = 0; i < 5; i += 1) t.onEvent(codexUpdate('T1'))
    expect(pushes).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.total.total).toBe(850)
    expect(pushes[0]?.agents.find((a) => a.agentKey === 'w1')?.inFlight?.total).toBe(850)
    // The Usage page's invalidation waits for a saved row.
    vi.advanceTimersByTime(10_000)
    expect(changed).toBe(0)
    t.onEvent(turnResult)
    vi.advanceTimersByTime(5000)
    expect(changed).toBe(1)
  })

  it('tells buildWorkerViews which workers are mid-turn', () => {
    const t = recorder.track(worker, runOf())
    t.onEvent(codexUpdate('T1'))
    const build = (): ReturnType<typeof buildWorkerViews> =>
      buildWorkerViews(
        's1',
        new WorkersRepo(opened.db),
        { listBySession: () => [] } as never,
        { listBySession: () => [] } as never,
        { listByWorker: () => [] } as never,
        undefined,
        undefined,
        recorder.tokensOf('s1'),
        recorder.inFlightOf('s1')
      )
    expect(build()[0]).toMatchObject({ tokens: { total: 170 }, tokensInFlight: true })
    t.onEvent(turnResult)
    const after = build()[0]
    expect(after?.tokens?.total).toBe(170)
    expect(after?.tokensInFlight).toBeUndefined()
  })
})

describe('UsageRecorder for a provider that reports no tokens (Cursor)', () => {
  const cursorWorker: UsageAgent = {
    ...worker,
    agentKey: 'w1',
    provider: () => 'cursor',
    model: () => 'auto'
  }
  const cursorTurn = (turnId: string, ok = true): AgentEvent => ({
    ...(turnResult as Extract<AgentEvent, { type: 'turn-result' }>),
    turnId,
    ok,
    status: ok ? 'completed' : 'failed'
  })
  const claudeTurn = (): void => {
    const t = recorder.track(brain, runOf())
    t.onEvent(usage())
    t.onEvent(turnResult)
  }

  it('writes a row of zeros for a turn that ends with no usage, and none twice for it', () => {
    const t = recorder.track(cursorWorker, runOf())
    expect(t.onEvent(cursorTurn('t1'))).toBe(true)
    t.onEvent(cursorTurn('t1'))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      provider: 'cursor',
      agent_key: 'w1',
      input_tokens: 0,
      output_tokens: 0,
      call_count: 0
    })
    t.onEvent(cursorTurn('t2'))
    expect(rows()).toHaveLength(2)
  })

  it('does not write zero rows for Claude or Codex turns that spent nothing', () => {
    const t = recorder.track(brain, runOf())
    t.onEvent(turnResult)
    const c = recorder.track(worker, runOf())
    c.onEvent(turnResult)
    expect(rows()).toHaveLength(0)
  })

  it('marks the agent not-reported with null tokens, apart from not-recorded', () => {
    const t = recorder.track(cursorWorker, runOf())
    expect(recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')?.recording).toBe(
      'recorded'
    )
    t.onEvent(cursorTurn('t1'))
    const agent = recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')
    expect(agent).toMatchObject({ recording: 'not-reported', tokens: null })
  })

  it('leaves Cursor out of the session total and byProvider, and names it in notReported', () => {
    claudeTurn()
    recorder.track(cursorWorker, runOf()).onEvent(cursorTurn('t1'))
    const snap = recorder.snapshot('s1')
    expect(snap.total.total).toBe(100)
    expect(snap.byProvider).toEqual({ claude: expect.objectContaining({ total: 100 }) })
    expect(snap.notReported).toEqual(['cursor'])
    expect(snap.partial).toBe(false)
  })

  it('omits notReported when no provider is unreported', () => {
    claudeTurn()
    expect(recorder.snapshot('s1').notReported).toBeUndefined()
  })

  it('records the agent normally when the provider does report tokens', () => {
    const t = recorder.track(cursorWorker, runOf())
    t.onEvent(usage({ turnId: 't1', input: 50, cacheWrite: 0, cacheRead: 0, output: 5 }))
    t.onEvent(cursorTurn('t1'))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ provider: 'cursor', input_tokens: 50, output_tokens: 5 })
    const snap = recorder.snapshot('s1')
    expect(snap.agents.find((a) => a.agentKey === 'w1')).toMatchObject({
      recording: 'recorded',
      tokens: expect.objectContaining({ total: 55 })
    })
    expect(snap.byProvider.cursor?.total).toBe(55)
    expect(snap.notReported).toBeUndefined()
  })

  it('shows live progress for a Cursor turn that reports it', () => {
    const t = recorder.track(cursorWorker, runOf())
    t.onEvent({
      type: 'usage-progress',
      agentId: 'a',
      ts: 1,
      turnId: 't1',
      input: 10,
      cacheWrite: 0,
      cacheRead: 0,
      output: 4,
      callCount: 1
    })
    expect(recorder.snapshot('s1').agents.find((a) => a.agentKey === 'w1')?.tokens?.total).toBe(14)
  })
})
