import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AgentSetupRepo } from '../../../src/main/db/repositories/agent-setup-repo'
import { FileReadsRepo } from '../../../src/main/db/repositories/file-reads-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { UsageRepo } from '../../../src/main/db/repositories/usage-repo'
import { UsageSuggestionsRepo } from '../../../src/main/db/repositories/usage-suggestions-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { normalizeReadPath } from '../../../src/main/usage/read-paths'
import { SuggestionService, compactTokens } from '../../../src/main/usage/suggestion-service'
import type { SetupAgent, WorkerFinished } from '../../../src/main/usage/suggestion-service'
import { UsageRecorder } from '../../../src/main/usage/usage-recorder'
import type { UsageAgent } from '../../../src/main/usage/usage-recorder'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let usageRepo: UsageRepo
let suggestionsRepo: UsageSuggestionsRepo
let service: SuggestionService
let changedSessions: string[]
let ids: number
let clock: number
let setupAgents: SetupAgent[]

const agent = (
  key: string,
  label: string
): { sessionId: string; agentKey: string; label: string } => ({
  sessionId: 's1',
  agentKey: key,
  label
})

/** Records one turn row and, when given, its setup columns. */
function addTurn(
  agentKey: string,
  total: number,
  extra: { setup?: number; arc?: number; maxCallInput?: number; turnKey?: string } = {}
): void {
  usageRepo.record({
    sessionId: 's1',
    agentKey,
    agentRole: agentKey === 'brain' ? 'brain' : 'worker',
    provider: 'claude',
    model: agentKey === 'brain' ? 'sonnet' : 'opus',
    workerLabel: agentKey === 'brain' ? null : 'W2',
    at: clock,
    inputTokens: total,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    maxCallInput: extra.maxCallInput ?? 0,
    turnKey: extra.turnKey ?? `k${(ids += 1)}`
  })
  if (extra.setup !== undefined) {
    opened.sqlite
      .prepare(
        'UPDATE usage_turns SET setup_tokens=?, arc_setup_tokens=? WHERE id=(SELECT MAX(id) FROM usage_turns)'
      )
      .run(extra.setup, extra.arc ?? 0)
  }
}

const open = (): ReturnType<UsageSuggestionsRepo['forSession']> => suggestionsRepo.forSession('s1')
const ofKind = (kind: string): ReturnType<UsageSuggestionsRepo['forSession']> =>
  open().filter((s) => s.kind === kind)

const finished = (over: Partial<WorkerFinished> = {}): WorkerFinished => ({
  ...agent('w1', 'W2'),
  workerId: 'w1',
  provider: 'claude',
  model: 'opus',
  changedFiles: 0,
  ...over
})

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
  usageRepo = new UsageRepo(opened.db)
  suggestionsRepo = new UsageSuggestionsRepo(opened.db)
  changedSessions = []
  setupAgents = []
  ids = 0
  clock = Date.UTC(2026, 9, 20, 12)
  service = new SuggestionService({
    repo: suggestionsRepo,
    fileReads: new FileReadsRepo(opened.db),
    usage: usageRepo,
    agents: () => setupAgents,
    models: {
      tierOf: (ref) => (['opus', 'claude-opus-5[]'].includes(ref.model) ? 'deep' : 'balanced'),
      defaultFor: (provider) => ({
        provider,
        model: provider === 'cursor' ? 'default[]' : 'sonnet'
      })
    },
    onChanged: (sessionId) => changedSessions.push(sessionId),
    now: () => (clock += 1),
    newId: () => `sg${(ids += 1)}`
  })
})
afterEach(() => {
  opened.sqlite.close()
})

describe('model too strong', () => {
  it('suggests the default model for a deep worker that changed no files', () => {
    addTurn('w1', 900_000)
    service.onWorkerFinished(finished())
    const [s] = ofKind('model-too-strong')
    expect(s?.text).toBe('W2 used Opus for a task that read 0 files and changed none.')
    expect(s?.advice).toBe('Sonnet would likely do.')
    expect(s).toMatchObject({ agentKey: 'w1', workerId: 'w1', sessionName: 'Fix the docs' })
    expect(changedSessions).toEqual(['s1'])
  })

  it('a Cursor worker with no reported tokens: none by size, but one when it changed nothing', () => {
    usageRepo.record({
      sessionId: 's1',
      agentKey: 'w1',
      agentRole: 'worker',
      provider: 'cursor',
      model: 'claude-opus-5[]',
      at: clock,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      turnKey: 'cursor-zero'
    })
    const cursor = { provider: 'cursor', model: 'claude-opus-5[]' } as const
    service.onWorkerFinished(finished({ ...cursor, changedFiles: 3 }))
    expect(ofKind('model-too-strong')).toEqual([])
    service.onWorkerFinished(finished({ ...cursor, changedFiles: 0 }))
    const [s] = ofKind('model-too-strong')
    expect(s?.text).toBe('W2 used claude-opus-5 for a task that read 0 files and changed none.')
    // Names the lighter model as the chooser does, never Cursor's internal id.
    expect(s?.advice).toBe('Auto would likely do.')
  })

  it('names the files it read', () => {
    addTurn('w1', 1000)
    const reads = new FileReadsRepo(opened.db)
    reads.bump('s1', 'w1', 'api/a.ts', 1)
    reads.bump('s1', 'w1', 'api/b.ts', 1)
    reads.bump('s1', 'w1', 'api/b.ts', 2)
    service.onWorkerFinished(finished())
    expect(ofKind('model-too-strong')[0]?.text).toBe(
      'W2 used Opus for a task that read 2 files and changed none.'
    )
  })

  it('with changed files, a total of 49,999 tokens is small and 50,000 is not', () => {
    addTurn('w1', 49_999)
    addTurn('w2', 50_000)
    service.onWorkerFinished(finished({ changedFiles: 3 }))
    service.onWorkerFinished(finished({ ...agent('w2', 'W3'), workerId: 'w2', changedFiles: 3 }))
    expect(ofKind('model-too-strong').map((x) => x.agentKey)).toEqual(['w1'])
    expect(ofKind('model-too-strong')[0]?.text).toBe(
      'W2 used Opus for a small task (49.9k tokens) that read 0 files and changed 3.'
    )
  })

  it('a model that is not on the deep tier gets none', () => {
    addTurn('w1', 10)
    service.onWorkerFinished(finished({ model: 'sonnet' }))
    expect(open()).toEqual([])
  })

  it('a big task that changed files gets none, and unknown changes fall back on the token rule', () => {
    addTurn('w1', 400_000)
    service.onWorkerFinished(finished({ changedFiles: 4 }))
    service.onWorkerFinished(finished({ changedFiles: null }))
    expect(open()).toEqual([])
  })

  it('stays quiet when the provider has no lighter default', () => {
    addTurn('w1', 10)
    const quiet = new SuggestionService({
      repo: suggestionsRepo,
      fileReads: new FileReadsRepo(opened.db),
      usage: usageRepo,
      agents: () => [],
      models: { tierOf: () => 'deep', defaultFor: () => undefined },
      onChanged: () => undefined,
      now: () => 1,
      newId: () => 'x'
    })
    quiet.onWorkerFinished(finished())
    expect(open()).toEqual([])
  })
})

describe('setup overhead', () => {
  const turn = (over: Partial<Parameters<SuggestionService['onTurn']>[0]> = {}): void =>
    service.onTurn({
      ...agent('brain', 'the brain'),
      maxCallInput: 0,
      contextWindow: null,
      ...over
    })
  const setupAgent = (
    key: string,
    perRequest: number | null,
    over: { role?: SetupAgent['role']; label?: string; setup?: number; arc?: number } = {}
  ): SetupAgent => ({
    agentKey: key,
    role: over.role ?? (key === 'brain' ? 'brain' : 'worker'),
    label: over.label ?? (key === 'brain' ? 'Brain' : `${key.toUpperCase()} · task`),
    setup: {
      arcAdditionsPerRequest: null,
      fixedSetupPerRequest: perRequest,
      setupTokens: over.setup ?? (perRequest ?? 0) * 2,
      arcSetupTokens: over.arc ?? 0,
      work: 0
    }
  })

  it('needs 30,000 tokens of fixed setup per request: 29,999 stays quiet, 30,000 shows', () => {
    setupAgents = [setupAgent('brain', 29_999)]
    turn()
    expect(ofKind('setup-overhead')).toEqual([])
    setupAgents = [setupAgent('brain', 30_000)]
    turn()
    expect(ofKind('setup-overhead')).toHaveLength(1)
  })

  it('stays quiet while the fixed setup is not measured, and for agents with no setup', () => {
    setupAgents = [setupAgent('brain', null), setupAgent('w1', 0)]
    turn()
    expect(ofKind('setup-overhead')).toEqual([])
  })

  it('skips agents that report no tokens, even with a setup figure', () => {
    setupAgents = [
      { ...setupAgent('brain', 40_000), recording: 'not-reported' },
      setupAgent('w1', 31_000)
    ]
    turn()
    const [s] = ofKind('setup-overhead')
    expect(s?.text).toContain('W1')
    expect(s?.text).not.toContain('brain')
    expect(s?.params).toMatchObject({ agents: [expect.objectContaining({ agentKey: 'w1' })] })
  })

  it('one suggestion per session, listing the qualifying agents worst first', () => {
    setupAgents = [
      setupAgent('brain', 31_000, { setup: 62_000, arc: 3100 }),
      setupAgent('w2', 12_000),
      setupAgent('w4', 47_000, { label: 'W4 · api', setup: 94_400, arc: 3000 }),
      setupAgent('w1', 30_500, { label: 'W2 · docs', setup: 61_000, arc: 1000 })
    ]
    turn()
    turn({ ...agent('w4', 'W4') })
    const list = ofKind('setup-overhead')
    expect(list).toHaveLength(1)
    // Arc's part: (3100 + 3000 + 1000) / (62000 + 94400 + 61000) is 3.3%, rounded to 3%.
    expect(list[0]?.text).toBe(
      "Setup is up to 47k tokens per request for W4, the brain and W2 (Arc's additions about 3% of it)."
    )
    expect(list[0]?.agentKey).toBeUndefined()
    expect(list[0]?.params).toMatchObject({ arcPercent: 3, agents: expect.any(Array) })
  })

  it('says "about" for one agent and when the figures read the same', () => {
    setupAgents = [setupAgent('w1', 47_000, { label: 'W2 · docs' })]
    turn()
    expect(ofKind('setup-overhead')[0]?.text).toContain(
      'Setup is about 47k tokens per request for W2 ('
    )
  })

  it('names a resolver as the conflict resolver', () => {
    setupAgents = [
      setupAgent('resolver:w1', 33_000, { role: 'resolver', label: 'Conflict resolver' })
    ]
    turn()
    expect(ofKind('setup-overhead')[0]?.text).toContain('for the conflict resolver (')
  })

  it("advises on Arc's own additions when they are 25% or more of the setup", () => {
    setupAgents = [setupAgent('brain', 40_000, { setup: 80_000, arc: 20_000 })]
    turn()
    expect(ofKind('setup-overhead')[0]?.advice).toBe(
      'Fewer knowledge files, a shorter group context or a shorter task description would reduce it.'
    )
  })

  it('points at the CLI, plugins, skills and MCP servers below 25%', () => {
    setupAgents = [setupAgent('brain', 40_000, { setup: 80_000, arc: 19_999 })]
    turn()
    expect(ofKind('setup-overhead')[0]?.advice).toBe(
      "Most of it is the CLI's own instructions plus your plugins, skills and MCP servers, which Arc agents load just as the terminal does. Turning off the ones the agents don't need shrinks every request."
    )
  })

  it('refreshes the one open suggestion as the numbers change', () => {
    setupAgents = [setupAgent('brain', 31_000)]
    turn()
    const first = ofKind('setup-overhead')[0]
    setupAgents = [setupAgent('brain', 31_000), setupAgent('w1', 52_000, { label: 'W1 · a' })]
    turn()
    const again = ofKind('setup-overhead')
    expect(again).toHaveLength(1)
    expect(again[0]?.id).toBe(first?.id)
    expect(again[0]?.text).toContain('up to 52k tokens per request for W1 and the brain')
  })

  it('a dismissed one is not recreated', () => {
    setupAgents = [setupAgent('brain', 31_000)]
    turn()
    service.dismiss(ofKind('setup-overhead')[0]?.id ?? '')
    setupAgents = [setupAgent('brain', 60_000)]
    turn()
    expect(ofKind('setup-overhead')).toEqual([])
  })
})

describe('long-running agent', () => {
  const turn = (maxCallInput: number, key = 'brain', contextWindow: number | null = null): void =>
    service.onTurn({
      ...agent(key, key === 'brain' ? 'the brain' : 'W2'),
      maxCallInput,
      contextWindow
    })

  it('199,999 and 200,000 are fine, 200,001 is too large', () => {
    turn(199_999)
    turn(200_000)
    expect(ofKind('long-running')).toEqual([])
    turn(200_001)
    const [s] = ofKind('long-running')
    expect(s?.text).toBe("The brain's conversation is now 200k tokens, so each reply costs more.")
    expect(s?.advice).toBe('Starting a new session for unrelated work would reduce it.')
  })

  it('shows the share of the context window when it is known, for a worker too', () => {
    turn(400_000, 'w1', 1_000_000)
    expect(ofKind('long-running')[0]?.text).toBe(
      "W2's conversation is now 400k tokens (40% of its context window), so each reply costs more."
    )
  })

  it('one open suggestion per agent, refreshed as the conversation grows', () => {
    turn(300_000)
    turn(450_000)
    expect(ofKind('long-running')).toHaveLength(1)
    expect(ofKind('long-running')[0]?.params).toMatchObject({ maxCallInput: 450_000 })
  })
})

describe('repeated work', () => {
  it('appears on the third read in the session, across two workers', () => {
    service.onRead(agent('w1', 'W1'), 'api/schema.sql')
    service.onRead(agent('w3', 'W3'), 'api/schema.sql')
    expect(ofKind('repeated-work')).toEqual([])
    service.onRead(agent('w3', 'W3'), 'api/schema.sql')
    const [s] = ofKind('repeated-work')
    expect(s?.text).toBe('W1 and W3 both read api/schema.sql (3 reads in all).')
    expect(s?.params).toMatchObject({ path: 'api/schema.sql', count: 3, agents: ['W1', 'W3'] })
    expect(s?.agentKey).toBeUndefined()
  })

  it('a different file does not count towards it, and a single agent is named alone', () => {
    service.onRead(agent('w1', 'W1'), 'a.ts')
    service.onRead(agent('w1', 'W1'), 'b.ts')
    service.onRead(agent('w1', 'W1'), 'a.ts')
    expect(ofKind('repeated-work')).toEqual([])
    service.onRead(agent('w1', 'W1'), 'a.ts')
    expect(ofKind('repeated-work')[0]?.text).toBe('W1 read a.ts 3 times.')
  })

  it('names the brain', () => {
    for (let i = 0; i < 3; i++) service.onRead(agent('brain', 'the brain'), 'a.ts')
    expect(ofKind('repeated-work')[0]?.text).toBe('The brain read a.ts 3 times.')
  })

  it('refreshes the count of the open suggestion', () => {
    for (let i = 0; i < 5; i++) service.onRead(agent('w1', 'W1'), 'a.ts')
    expect(ofKind('repeated-work')).toHaveLength(1)
    expect(ofKind('repeated-work')[0]?.text).toBe('W1 read a.ts 5 times.')
  })
})

describe('dismissing', () => {
  it('a dismissed suggestion disappears and is never recreated', () => {
    for (let i = 0; i < 3; i++) service.onRead(agent('w1', 'W1'), 'a.ts')
    const id = ofKind('repeated-work')[0]?.id ?? ''
    changedSessions.length = 0
    service.dismiss(id)
    expect(open()).toEqual([])
    expect(changedSessions).toEqual(['s1'])
    service.onRead(agent('w1', 'W1'), 'a.ts')
    service.onTurn({ ...agent('w1', 'W1'), maxCallInput: 300_000, contextWindow: null })
    expect(ofKind('repeated-work')).toEqual([])
    // Another kind is a different suggestion.
    expect(ofKind('long-running')).toHaveLength(1)
    service.dismiss(ofKind('long-running')[0]?.id ?? '')
    service.onTurn({ ...agent('w1', 'W1'), maxCallInput: 400_000, contextWindow: null })
    expect(open()).toEqual([])
  })

  it('the IPC channel takes an id and nothing else', () => {
    const schema = channelSchemas['usage:dismiss-suggestion']
    expect(schema.safeParse({ id: 'x' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ id: 'x', extra: 1 }).success).toBe(false)
  })
})

describe('normalizeReadPath', () => {
  const roots = [{ path: '/Users/me/dev/api', name: 'api' }]

  it('strips the worker worktree prefix so two workers match', () => {
    const a = normalizeReadPath('/ud/worktrees/s1/w1/api/src/a.ts', { cwd: null, roots })
    const b = normalizeReadPath('/ud/worktrees/s1/w2/api/src/a.ts', { cwd: null, roots })
    expect(a).toBe('api/src/a.ts')
    expect(b).toBe(a)
  })

  it('strips a project root and resolves relative paths against the cwd', () => {
    expect(normalizeReadPath('/Users/me/dev/api/src/a.ts', { cwd: null, roots })).toBe(
      'api/src/a.ts'
    )
    expect(normalizeReadPath('src/./a.ts', { cwd: '/Users/me/dev/api', roots })).toBe(
      'api/src/a.ts'
    )
    expect(normalizeReadPath('../lib/a.ts', { cwd: '/ud/worktrees/s1/w1/api/src', roots })).toBe(
      'api/lib/a.ts'
    )
  })

  it('prefers a known root, and leaves other absolute paths alone', () => {
    const wt = [{ path: '/ud/worktrees/s1/w1/api-2', name: 'api-2' }]
    expect(normalizeReadPath('/ud/worktrees/s1/w1/api-2/x.ts', { cwd: null, roots: wt })).toBe(
      'api-2/x.ts'
    )
    expect(normalizeReadPath('/etc/hosts', { cwd: null, roots })).toBe('/etc/hosts')
  })
})

describe('compactTokens', () => {
  it('writes short figures', () => {
    expect(compactTokens(950)).toBe('950')
    expect(compactTokens(1234)).toBe('1.2k')
    expect(compactTokens(400_000)).toBe('400k')
    expect(compactTokens(1_500_000)).toBe('1.5M')
  })
})

describe('through the recorder', () => {
  let recorder: UsageRecorder
  let pushes: number
  let changed: number

  const worker = (key: string, label: string, tree: string): UsageAgent => ({
    sessionId: 's1',
    agentKey: key,
    role: 'worker',
    workerId: key,
    workerLabel: label,
    provider: () => 'claude',
    model: () => 'opus',
    readContext: () => ({ cwd: tree, roots: [{ path: tree, name: 'api' }] })
  })
  const read = (path: string): AgentEvent => ({
    type: 'tool-use',
    agentId: 'a',
    ts: 1,
    toolUseId: `t${(ids += 1)}`,
    name: 'Read',
    summary: `Read: ${path}`,
    readPath: path
  })

  beforeEach(() => {
    pushes = 0
    changed = 0
    recorder = new UsageRecorder({
      repo: usageRepo,
      setupRepo: new AgentSetupRepo(opened.db),
      sessionsRepo: new SessionsRepo(opened.db),
      groupsRepo: new GroupsRepo(opened.db),
      workersRepo: new WorkersRepo(opened.db),
      suggestions: service,
      emit: () => (pushes += 1),
      emitChanged: () => (changed += 1),
      now: () => clock,
      throttleMs: 1,
      changedThrottleMs: 1
    })
  })
  afterEach(() => recorder.dispose())

  it('counts reads of one file by two workers in their own worktrees as one path', () => {
    const t1 = recorder.track(worker('w1', 'W1', '/ud/worktrees/s1/w1/api'), {
      resumed: false,
      instructions: ''
    })
    const t3 = recorder.track(worker('w3', 'W3', '/ud/worktrees/s1/w3/api'), {
      resumed: false,
      instructions: ''
    })
    t1.onEvent(read('/ud/worktrees/s1/w1/api/db/schema.sql'))
    t3.onEvent(read('db/schema.sql'))
    expect(ofKind('repeated-work')).toEqual([])
    t3.onEvent(read('/ud/worktrees/s1/w3/api/db/schema.sql'))
    const [s] = ofKind('repeated-work')
    expect(s?.text).toBe('W1 and W3 both read api/db/schema.sql (3 reads in all).')
    expect(recorder.snapshot('s1').suggestions.map((x) => x.kind)).toEqual(['repeated-work'])
  })

  it('checks a finished turn and puts the suggestion in the snapshot', async () => {
    const t = recorder.track(worker('w1', 'W2', '/ud/worktrees/s1/w1/api'), {
      resumed: false,
      instructions: ''
    })
    t.onEvent({
      type: 'usage',
      agentId: 'a',
      ts: 1,
      scope: 'turn',
      turnId: '1',
      input: 250_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 10,
      maxCallInput: 250_000,
      callCount: 1,
      contextWindow: 1_000_000,
      partial: false
    } as AgentEvent)
    t.onEvent({
      type: 'turn-result',
      agentId: 'a',
      ts: 2,
      ok: true,
      interrupted: false,
      durationMs: 1,
      status: 'completed'
    })
    expect(recorder.snapshot('s1').suggestions[0]?.text).toContain(
      '250k tokens (25% of its context window)'
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(pushes).toBeGreaterThan(0)
    expect(changed).toBeGreaterThan(0)
    recorder.workerFinished(finished())
    expect(
      recorder
        .snapshot('s1')
        .suggestions.map((x) => x.kind)
        .sort()
    ).toEqual(['long-running', 'model-too-strong'])
  })
})
