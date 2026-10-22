import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderUnavailableError } from '../../../src/main/agents/agent-adapter'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { SessionService } from '../../../src/main/sessions/session-service'
import type { WorkerManager } from '../../../src/main/sessions/worker-manager'
import type {
  ProviderState,
  ProviderStatus,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter, FakeCodexAdapter } from './helpers'
import type { FakeHandle } from './helpers'
import { eventTexts } from './merge-rig'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-codex-fallback-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

const MODELS = [
  { model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true },
  { model: 'gpt-luna', displayName: 'GPT Luna', isDefault: false }
]

const statusOf = (state: ProviderState | undefined): ProviderStatusMap =>
  state === undefined
    ? {}
    : { codex: { provider: 'codex', state, message: '', checkedAt: 1 } as ProviderStatus }

interface Rig {
  e: EngineRig
  codex: FakeCodexAdapter
  setState: (state: ProviderState | undefined) => void
  ensureFresh: ReturnType<typeof vi.fn>
  markSignedOut: ReturnType<typeof vi.fn>
}

async function rigWith(initial: ProviderState | undefined = 'ok'): Promise<Rig> {
  const codex = new FakeCodexAdapter()
  let state: ProviderState | undefined = initial
  const map = (): ProviderStatusMap => statusOf(state)
  const ensureFresh = vi.fn(() => Promise.resolve(map().codex))
  const markSignedOut = vi.fn(() => {
    state = 'signed_out'
  })
  const models = new ModelRegistry({
    codex: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  e = await makeEngineRig(dir(), {
    codexAdapter: codex,
    models,
    providers: { get: map, ensureFresh, markSignedOut }
  })
  return {
    e,
    codex,
    setState: (next) => {
      state = next
    },
    ensureFresh,
    markSignedOut
  }
}

const spawnArgs = (name: string): Record<string, unknown> => ({
  name,
  task: `Do ${name}`,
  repos: ['api']
})

async function codexSession(r: Rig): Promise<string> {
  const sessionId = await r.e.startSession('autonomous')
  r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
  return sessionId
}

function workersOf(r: Rig, sessionId: string): WorkerManager {
  const orchestrators = (
    r.e.rig.service as unknown as { orchestrators: Map<string, { workers: WorkerManager }> }
  ).orchestrators
  const orchestrator = orchestrators.get(sessionId)
  if (!orchestrator) throw new Error('no orchestrator')
  return orchestrator.workers
}

const SIGNED_OUT_EVENT =
  "Codex isn't signed in, so W1 runs on Claude. Run codex login in Terminal to use Codex."
const SIGNED_OUT_SENTENCE = "Codex isn't signed in. Run codex login in Terminal to use Codex."

describe('a worker meant for Codex while Codex is not ready', () => {
  it('stores the fallback, exposes it on runningOn and logs the exact line', async () => {
    const r = await rigWith('signed_out')
    const sessionId = await codexSession(r)

    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))

    expect(result.value).toMatchObject({ provider: 'claude', model: 'sonnet' })
    const row = r.e.rig.deps.workersRepo.get(String(result.value['workerId']))
    expect(row).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    expect(r.e.rig.service.snapshot(sessionId).workers[0]?.runningOn).toEqual({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    const texts = eventTexts(r.e, sessionId)
    expect(texts).toContain(SIGNED_OUT_EVENT)
    expect(texts).toContain('started W1 review · Claude (Codex unavailable)')
    // One explanation, not two: the resolver's plain note is not logged next to it.
    expect(texts.filter((t) => /so this worker runs on/.test(t))).toEqual([])
    await until(() => r.e.rig.adapter.starts.length === 2)
    expect(r.codex.starts).toHaveLength(0)
  })

  it('a worker on Codex that is ok has no fallback columns', async () => {
    const r = await rigWith('ok')
    await codexSession(r)
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(r.e.rig.deps.workersRepo.get(String(result.value['workerId']))).toMatchObject({
      provider: 'codex',
      requestedProvider: null,
      fallbackReason: null
    })
  })

  it('checks Codex again when the worker starts, after the check made at the spawn', async () => {
    const r = await rigWith('ok')
    const sessionId = await codexSession(r)
    // The spawn sees Codex ok; by the time the worker starts, Codex has gone.
    let calls = 0
    r.ensureFresh.mockImplementation(() => {
      calls += 1
      if (calls >= 2) r.setState('signed_out')
      return Promise.resolve(undefined)
    })

    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(r.e.rig.deps.workersRepo.get(String(result.value['workerId']))).toMatchObject({
      provider: 'claude',
      requestedProvider: 'codex',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    expect(eventTexts(r.e, sessionId)).toContain(SIGNED_OUT_EVENT)
    expect(r.codex.starts).toHaveLength(0)
  })
})

describe('the handshake refuses a Codex that looked ok', () => {
  it('starts the worker again on Claude with the same task, stores and logs it, marks Codex signed out', async () => {
    const r = await rigWith('ok')
    const sessionId = await codexSession(r)
    r.codex.failWith = new ProviderUnavailableError('codex', 'signed_out', "Codex isn't signed in.")

    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    const workerId = String(result.value['workerId'])

    await until(() => r.e.rig.adapter.starts.length === 2)
    const worker = r.e.rig.adapter.starts[1]
    expect(worker).toMatchObject({ provider: 'claude', role: 'worker', model: 'sonnet' })
    await until(() => r.e.workerHandle().sent.length === 1)
    expect(r.e.workerHandle().sent[0]).toBe('Do review')
    expect(r.e.rig.deps.workersRepo.get(workerId)).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    expect(eventTexts(r.e, sessionId)).toContain(SIGNED_OUT_EVENT)
    expect(r.markSignedOut).toHaveBeenCalledWith('codex')
  })

  it('a missing Codex falls back too, without marking anything signed out', async () => {
    const r = await rigWith('ok')
    const sessionId = await codexSession(r)
    r.codex.failWith = new ProviderUnavailableError('codex', 'missing', 'spawn codex ENOENT')

    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))

    await until(() => r.e.rig.adapter.starts.length === 2)
    expect(eventTexts(r.e, sessionId)).toContain(
      "Codex isn't installed, so W1 runs on Claude. Install Codex to use it."
    )
    expect(r.markSignedOut).not.toHaveBeenCalled()
  })
})

describe('a Codex worker that already ran is never moved to Claude', () => {
  /** A Codex worker with a thread, stopped by a quit, and a service reopened over the same database. */
  async function stoppedCodexWorker(
    r: Rig,
    reopened: { state: ProviderState | undefined; failWith?: Error }
  ): Promise<{
    service: SessionService
    claude: FakeAdapter
    codex: FakeCodexAdapter
    workerId: string
    sessionId: string
    markSignedOut: ReturnType<typeof vi.fn>
  }> {
    const sessionId = await codexSession(r)
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    const workerId = String(result.value['workerId'])
    await until(() => r.codex.handles.length === 1)
    ;(r.codex.handles[0] as FakeHandle).emit({
      type: 'session',
      providerSessionId: 'thread-7',
      model: 'gpt-deep',
      mcpServers: []
    })
    await until(() => r.e.rig.deps.workersRepo.get(workerId)?.status === 'working')
    await r.e.rig.service.shutdown()

    const claude = new FakeAdapter()
    const codex = new FakeCodexAdapter()
    if (reopened.failWith) codex.failWith = reopened.failWith
    const markSignedOut = vi.fn()
    const service = new SessionService({
      ...r.e.rig.deps,
      registry: claudeRegistry(claude, codex),
      providers: {
        get: () => statusOf(reopened.state),
        ensureFresh: () => Promise.resolve(undefined),
        markSignedOut
      }
    })
    extra.push(service)
    expect(r.e.rig.deps.workersRepo.get(workerId)).toMatchObject({ status: 'stopped' })
    return { service, claude, codex, workerId, sessionId, markSignedOut }
  }

  it('Codex signed out: Continue keeps it stopped on Codex with the explanatory line', async () => {
    const r = await rigWith('ok')
    const s = await stoppedCodexWorker(r, { state: 'signed_out' })

    await s.service.continueWorker(s.workerId)

    expect(s.claude.starts).toHaveLength(0)
    expect(s.codex.resumes).toHaveLength(0)
    expect(r.e.rig.deps.workersRepo.get(s.workerId)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'quit',
      provider: 'codex',
      model: 'gpt-deep',
      requestedProvider: null,
      fallbackReason: null,
      providerSessionId: 'thread-7'
    })
    expect(eventTexts(r.e, s.sessionId)).toContain(
      "Codex isn't signed in, so W1 can't continue. Run codex login in Terminal, then continue W1."
    )
  })

  it('the handshake refuses the resume: it stays stopped, Codex is marked signed out', async () => {
    const r = await rigWith('ok')
    const s = await stoppedCodexWorker(r, {
      state: 'ok',
      failWith: new ProviderUnavailableError('codex', 'signed_out', "Codex isn't signed in.")
    })

    await s.service.continueWorker(s.workerId)

    expect(s.claude.starts).toHaveLength(0)
    expect(r.e.rig.deps.workersRepo.get(s.workerId)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'quit',
      provider: 'codex',
      requestedProvider: null
    })
    expect(eventTexts(r.e, s.sessionId)).toContain(
      "Codex isn't signed in, so W1 can't continue. Run codex login in Terminal, then continue W1."
    )
    expect(s.markSignedOut).toHaveBeenCalledWith('codex')
  })

  it('once Codex is back, Continue resumes the same thread', async () => {
    const r = await rigWith('ok')
    const s = await stoppedCodexWorker(r, { state: 'ok' })
    await s.service.continueWorker(s.workerId)
    expect(s.codex.resumes[0]).toMatchObject({ resume: { threadId: 'thread-7' } })
    expect(s.claude.starts).toHaveLength(0)
  })
})

describe('a worker that runs a Codex command', () => {
  async function spawnCommand(r: Rig, sessionId: string): Promise<unknown> {
    const workers = workersOf(r, sessionId)
    const target = await workers.resolveTarget({
      command: { provider: 'codex', name: '/review' }
    })
    return workers
      .spawn({
        input: { name: 'review', task: 'Review W1', repos: ['api'], command: '/review' },
        planId: null,
        provider: target.ref.provider,
        model: target.ref.model,
        modelNote: null,
        fallback: target.fallback,
        blocked: target.blocked
      })
      .then(
        (v) => v,
        (error: unknown) => error
      )
  }

  it('fails without a process and says why when Codex is not ready', async () => {
    const r = await rigWith('signed_out')
    const sessionId = await r.e.startSession('autonomous')

    const outcome = await spawnCommand(r, sessionId)

    const reason =
      "W1 needs Codex for /review. Codex isn't signed in. Run codex login in Terminal to use Codex."
    expect(outcome).toMatchObject({ code: 'codex_unavailable', message: reason })
    const row = r.e.rig.deps.workersRepo.listBySession(sessionId)[0]
    expect(row).toMatchObject({
      status: 'failed',
      failureReason: reason,
      provider: 'codex',
      command: '/review',
      requestedProvider: null
    })
    expect(eventTexts(r.e, sessionId)).toContain(`W1 · /review failed: ${reason}`)
    expect(r.codex.starts).toHaveLength(0)
    // Only the brain ran; no worker process, no working copy.
    expect(r.e.rig.adapter.starts.map((s) => s.role)).toEqual(['brain'])
    expect(r.e.rig.deps.worktreesRepo.listByWorker(row?.id ?? '')).toEqual([])
  })

  it('a Codex that is ok starts the command on Codex', async () => {
    const r = await rigWith('ok')
    const sessionId = await r.e.startSession('autonomous')
    const outcome = await spawnCommand(r, sessionId)
    expect(outcome).toMatchObject({ status: 'started', provider: 'codex' })
    await until(() => r.codex.starts.length === 1)
  })
})

describe('the brain meant for Codex', () => {
  it('carries the fallback on brainRunningOn while Codex is not ready, and stops when it is back', async () => {
    const r = await rigWith('signed_out')
    r.e.rig.appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-deep' }, 1)
    const sessionId = await r.e.startSession('autonomous')

    const header = r.e.rig.service.snapshot(sessionId).header
    expect(header.brainRunningOn).toEqual({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    expect(header.brainModel).toBe('gpt-deep')
    expect(r.e.rig.sessionsRepo.getById(sessionId)).toMatchObject({ brainProvider: 'codex' })

    r.setState('ok')
    expect(r.e.rig.service.snapshot(sessionId).header.brainRunningOn).toEqual({
      provider: 'codex',
      model: 'gpt-deep'
    })
  })

  it('a handshake that refuses Codex gives this reply on Claude · Sonnet, logs it, keeps the choice', async () => {
    const r = await rigWith('ok')
    r.e.rig.appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-deep' }, 1)
    r.codex.failWith = new ProviderUnavailableError('codex', 'signed_out', "Codex isn't signed in.")

    const created = await r.e.rig.service.create(
      r.e.rig.groupId,
      'Plan the billing',
      'autonomous',
      3
    )
    if (!('sessionId' in created)) throw new Error('expected a session id')

    await until(() => r.e.rig.adapter.starts.length === 1)
    expect(r.e.rig.adapter.starts[0]).toMatchObject({
      provider: 'claude',
      role: 'brain',
      model: 'sonnet'
    })
    expect(r.codex.starts).toHaveLength(0)
    expect(r.e.rig.sessionsRepo.getById(created.sessionId)).toMatchObject({
      brainProvider: 'codex',
      brainModel: 'gpt-deep'
    })
    expect(eventTexts(r.e, created.sessionId)).toContain(
      "Codex isn't signed in, so the brain replies from Claude · Sonnet. Run codex login in Terminal to use Codex."
    )
    expect(r.markSignedOut).toHaveBeenCalledWith('codex')
    expect(r.e.rig.service.snapshot(created.sessionId).header.brainRunningOn).toMatchObject({
      provider: 'claude',
      requestedProvider: 'codex'
    })
  })

  it('checks Codex again before the brain starts', async () => {
    const r = await rigWith('ok')
    r.e.rig.appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-deep' }, 1)
    await r.e.rig.service.create(r.e.rig.groupId, 'Plan the billing', 'autonomous', 3)
    await until(() => r.codex.starts.length === 1)
    expect(r.ensureFresh).toHaveBeenCalledWith('codex')
  })
})
