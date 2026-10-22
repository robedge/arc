import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { SessionService } from '../../../src/main/sessions/session-service'
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

const dir = useTempDir('arc-codex-workers-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

interface CodexRig {
  e: EngineRig
  codex: FakeCodexAdapter
  /** Change what the provider status says. */
  setState: (state: ProviderState | undefined) => void
  ensureFresh: ReturnType<typeof vi.fn>
}

const MODELS = [
  { model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true },
  { model: 'gpt-luna', displayName: 'GPT Luna', isDefault: false }
]

/** The engine rig with a Codex adapter next to the Claude one, and a Codex status that tests can change. */
/** `unknown` is a status that no check has produced yet. */
async function codexRig(initial: ProviderState | 'unknown' = 'ok'): Promise<CodexRig> {
  const codex = new FakeCodexAdapter()
  let state: ProviderState | undefined = initial === 'unknown' ? undefined : initial
  const map = (): ProviderStatusMap =>
    state === undefined
      ? {}
      : { codex: { provider: 'codex', state, message: '', checkedAt: 1 } as ProviderStatus }
  const ensureFresh = vi.fn(() => Promise.resolve(map().codex))
  const models = new ModelRegistry({
    codex: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  e = await makeEngineRig(dir(), {
    codexAdapter: codex,
    models,
    providers: { get: map, ensureFresh }
  })
  return {
    e,
    codex,
    setState: (next) => {
      state = next
    },
    ensureFresh
  }
}

const spawnArgs = (
  name: string,
  extraArgs: Record<string, unknown> = {}
): Record<string, unknown> => ({
  name,
  task: `Do ${name}`,
  repos: ['api'],
  ...extraArgs
})

describe('a session pinned to Codex starts Codex workers', () => {
  it('starts registry.adapter("codex") with a Codex start, stores the provider and echoes it', async () => {
    const r = await codexRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    const adapterSpy = vi.spyOn(r.e.rig.deps.registry, 'adapter')

    const result = await r.e.call(
      r.e.brain(),
      'spawn_worker',
      spawnArgs('review', { provider: 'claude', model: 'haiku' })
    )

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      status: 'started',
      provider: 'codex',
      model: 'gpt-deep',
      note: expect.stringContaining('Workers is set to Codex') as unknown
    })
    await until(() => r.codex.starts.length === 1)
    expect(adapterSpy.mock.calls).toEqual([['codex']])
    expect(r.codex.starts[0]).toMatchObject({
      provider: 'codex',
      role: 'worker',
      model: 'gpt-deep',
      access: 'worker-write',
      codex: {}
    })
    expect(r.codex.starts[0]).not.toHaveProperty('claude')
    expect(r.codex.starts[0]?.bridge?.url).toBe(r.e.bridge.url)
    expect(r.codex.starts[0]?.bridgeTools).toContain('report_done')
    expect(r.codex.starts[0]?.bridgeTools).not.toContain('request_permission')
    // Only the brain ran on Claude.
    expect(r.e.rig.adapter.starts.map((s) => s.role)).toEqual(['brain'])
    const row = r.e.rig.deps.workersRepo.get(String(result.value['workerId']))
    expect(row).toMatchObject({ provider: 'codex', model: 'gpt-deep' })
  })

  it('stores the provider and thread id from the session event, and runningOn follows', async () => {
    const r = await codexRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    const workerId = String(result.value['workerId'])
    await until(() => r.codex.handles.length === 1)
    const handle = r.codex.handles[0] as FakeHandle
    expect(handle.provider).toBe('codex')

    handle.emit({
      type: 'session',
      providerSessionId: 'thread-1',
      model: 'gpt-deep',
      mcpServers: [{ name: 'arc', status: 'ready' }]
    })
    await until(() => r.e.rig.deps.workersRepo.get(workerId)?.status === 'working')

    expect(r.e.rig.deps.workersRepo.get(workerId)).toMatchObject({
      provider: 'codex',
      providerSessionId: 'thread-1'
    })
    expect(r.e.rig.service.snapshot(sessionId).workers[0]?.runningOn).toEqual({
      provider: 'codex',
      model: 'gpt-deep'
    })
    expect(eventTexts(r.e, sessionId)).toContain('started W1 review · Codex · gpt-deep')
  })

  it('checks Codex again before the spawn and loads the model list when it is still missing', async () => {
    const r = await codexRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    expect(r.e.rig.deps.models?.list('codex')).toEqual([])
    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(r.ensureFresh).toHaveBeenCalledWith('codex')
    expect(r.e.rig.deps.models?.list('codex').map((m) => m.ref.model)).toEqual([
      'gpt-deep',
      'gpt-luna'
    ])
  })

  it('does not check Codex for a Claude worker', async () => {
    const r = await codexRig()
    await r.e.startSession('autonomous')
    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('plain'))
    expect(r.ensureFresh).not.toHaveBeenCalled()
    await until(() => r.e.rig.adapter.starts.length === 2)
    expect(r.codex.starts).toHaveLength(0)
  })

  it('lets the brain choose Codex when Workers is Auto', async () => {
    const r = await codexRig()
    await r.e.startSession('autonomous')
    const result = await r.e.call(
      r.e.brain(),
      'spawn_worker',
      spawnArgs('second-opinion', { provider: 'codex', model: 'gpt-luna' })
    )
    expect(result.value).toMatchObject({ provider: 'codex', model: 'gpt-luna', note: null })
    await until(() => r.codex.starts.length === 1)
    expect(r.codex.starts[0]?.model).toBe('gpt-luna')
  })

  it('a header override to Claude beats a Codex Settings default for the next worker', async () => {
    const r = await codexRig()
    r.e.rig.appSettingsRepo.set('providers.workers', { mode: 'provider', provider: 'codex' }, 1)
    const sessionId = await r.e.startSession('autonomous')
    expect(r.e.rig.service.snapshot(sessionId).header.workers).toEqual({
      mode: 'provider',
      provider: 'codex'
    })

    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'claude' } })
    const result = await r.e.call(
      r.e.brain(),
      'spawn_worker',
      spawnArgs('plain', { provider: 'codex' })
    )

    expect(result.value).toMatchObject({ provider: 'claude', model: 'sonnet' })
    await until(() => r.e.rig.adapter.starts.length === 2)
    expect(r.codex.starts).toHaveLength(0)
    expect(r.e.rig.deps.workersRepo.get(String(result.value['workerId']))?.provider).toBe('claude')
  })
})

describe('plan-first', () => {
  it('stores the provider the brain proposed and starts the approved worker on it', async () => {
    const r = await codexRig()
    const sessionId = await r.e.startSession('plan_first')
    const worker = {
      name: 'review',
      task: 'Review W1',
      repos: ['api'],
      provider: 'codex',
      model: 'gpt-luna'
    }
    const pending = r.e.call(r.e.brain(), 'propose_plan', { workers: [worker] })
    await until(() => r.e.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
    const plan = r.e.rig.deps.plansRepo.latest(sessionId)
    expect(r.e.rig.service.snapshot(sessionId).plan?.workers[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-luna',
      runningOn: { provider: 'codex', model: 'gpt-luna' }
    })
    r.e.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve')
    await pending

    // spawn_worker names neither provider nor model: the approved plan entry decides.
    const result = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'review',
      task: 'Review W1',
      repos: ['api']
    })

    expect(result.value).toMatchObject({ provider: 'codex', model: 'gpt-luna', note: null })
    await until(() => r.codex.starts.length === 1)
    expect(r.codex.starts[0]?.model).toBe('gpt-luna')
  })

  it('a plan entry without a provider (an older plan) still runs on Claude', async () => {
    const r = await codexRig()
    const sessionId = await r.e.startSession('plan_first')
    const worker = { name: 'api', task: 'Do api', repos: ['api'], model: 'haiku' }
    const pending = r.e.call(r.e.brain(), 'propose_plan', { workers: [worker] })
    await until(() => r.e.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
    r.e.rig.service.decidePlan(
      sessionId,
      r.e.rig.deps.plansRepo.latest(sessionId)?.id ?? '',
      'approve'
    )
    await pending
    const result = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'api',
      task: 'Do api',
      repos: ['api']
    })
    expect(result.value).toMatchObject({ provider: 'claude', model: 'haiku' })
    expect(r.codex.starts).toHaveLength(0)
  })
})

describe('when Codex is not available', () => {
  const texts = {
    signed_out:
      "Codex isn't signed in, so W1 runs on Claude. Run codex login in Terminal to use Codex.",
    missing: "Codex isn't installed, so W1 runs on Claude. Install Codex to use it.",
    unknown: "Arc couldn't check Codex, so W1 runs on Claude."
  } as const
  it.each(['signed_out', 'missing', 'unknown'] as const)(
    'Workers pinned to Codex (%s) runs the worker on Claude with the exact event text',
    async (state) => {
      const r = await codexRig(state)
      const sessionId = await r.e.startSession('autonomous')
      r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })

      const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))

      expect(result.value).toMatchObject({
        provider: 'claude',
        model: 'sonnet',
        note: expect.stringMatching(/Codex .*so this worker runs on Claude · Sonnet/) as unknown
      })
      await until(() => r.e.rig.adapter.starts.length === 2)
      expect(r.codex.starts).toHaveLength(0)
      const row = r.e.rig.deps.workersRepo.get(String(result.value['workerId']))
      expect(row).toMatchObject({ provider: 'claude', model: 'sonnet' })
      expect(eventTexts(r.e, sessionId)).toContain(texts[state])
    }
  )

  it('a Codex that signs in after launch is used: the status is checked again at the spawn', async () => {
    const r = await codexRig('signed_out')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    r.ensureFresh.mockImplementation(() => {
      r.setState('ok')
      return Promise.resolve(undefined)
    })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(result.value).toMatchObject({ provider: 'codex', model: 'gpt-deep' })
  })
})

describe('resume uses the stored provider', () => {
  it('continues a Codex worker through the Codex adapter with thread/resume', async () => {
    const r = await codexRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
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

    // Quit and reopen: a new service over the same database, with fresh adapters.
    await r.e.rig.service.shutdown()
    const claude = new FakeAdapter()
    const codex = new FakeCodexAdapter()
    const service = new SessionService({
      ...r.e.rig.deps,
      registry: claudeRegistry(claude, codex)
    })
    extra.push(service)
    expect(r.e.rig.deps.workersRepo.get(workerId)).toMatchObject({ status: 'stopped' })

    await service.continueWorker(workerId)

    expect(claude.starts).toHaveLength(0)
    expect(codex.resumes).toHaveLength(1)
    expect(codex.resumes[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-deep',
      resume: { threadId: 'thread-7' }
    })
    expect(sessionId).toBeTruthy()
  })
})
