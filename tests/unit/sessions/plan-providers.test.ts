import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import type { ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { FakeCodexAdapter } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-plan-providers-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const MODELS = [
  { model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true },
  { model: 'gpt-luna', displayName: 'GPT Luna', isDefault: false }
]

async function rigWithCodex(): Promise<{ e: EngineRig; codex: FakeCodexAdapter }> {
  const codex = new FakeCodexAdapter()
  const status = (): ProviderStatusMap => ({
    codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 1 }
  })
  const models = new ModelRegistry({
    codex: { listModels: () => Promise.resolve(MODELS) },
    status
  })
  await models.refresh()
  e = await makeEngineRig(dir(), {
    codexAdapter: codex,
    models,
    providers: { get: status, ensureFresh: () => Promise.resolve(undefined) }
  })
  return { e, codex }
}

const worker = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'api',
  task: 'Do api',
  repos: ['api'],
  rationale: 'because',
  ...over
})

/** Proposes the plan through the brain's tool and waits until the card is there. */
async function propose(
  rig: EngineRig,
  sessionId: string,
  workers: Record<string, unknown>[]
): Promise<{ planId: string; result: ReturnType<EngineRig['call']> }> {
  const result = rig.call(rig.brain(), 'propose_plan', { workers })
  await until(() => rig.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
  return { planId: rig.rig.deps.plansRepo.latest(sessionId)?.id ?? '', result }
}

describe('plan approval with providers', () => {
  it('a worker changed from Claude to Codex is approved on Codex and starts on Codex', async () => {
    const r = await rigWithCodex()
    const sessionId = await r.e.startSession('plan_first')
    const { planId, result } = await propose(r.e, sessionId, [
      worker({ provider: 'claude', model: 'haiku' })
    ])
    expect(r.e.rig.service.snapshot(sessionId).plan?.workers[0]).toMatchObject({
      provider: 'claude',
      model: 'haiku'
    })

    r.e.rig.service.decidePlan(sessionId, planId, 'approve', {
      api: { provider: 'codex', model: 'gpt-luna' }
    })
    const approved = await result

    // The brain hears both.
    expect(approved.value).toEqual({
      planId,
      decision: 'approved',
      models: { api: 'gpt-luna' },
      providers: { api: 'codex' }
    })
    // The plan stores the approved provider next to the approved model, and the card shows them.
    const stored = JSON.parse(r.e.rig.deps.plansRepo.get(planId)?.workersJson ?? '[]') as unknown[]
    expect(stored[0]).toMatchObject({
      provider: 'claude',
      model: 'haiku',
      approvedProvider: 'codex',
      approvedModel: 'gpt-luna'
    })
    expect(r.e.rig.service.snapshot(sessionId).plan?.workers[0]).toMatchObject({
      approvedProvider: 'codex',
      approvedModel: 'gpt-luna',
      runningOn: { provider: 'codex', model: 'gpt-luna' }
    })

    // spawn_worker naming Claude cannot undo the user's choice.
    const started = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'api',
      task: 'Do api',
      repos: ['api'],
      provider: 'claude',
      model: 'haiku'
    })
    expect(started.value).toMatchObject({ provider: 'codex', model: 'gpt-luna' })
    await until(() => r.codex.starts.length === 1)
    expect(r.codex.starts[0]).toMatchObject({ provider: 'codex', model: 'gpt-luna' })
    expect(r.e.rig.deps.workersRepo.get(String(started.value['workerId']))).toMatchObject({
      provider: 'codex',
      model: 'gpt-luna'
    })
  })

  it('approving with no pick keeps the brain’s proposed provider and model', async () => {
    const r = await rigWithCodex()
    const sessionId = await r.e.startSession('plan_first')
    const { planId, result } = await propose(r.e, sessionId, [
      worker({ provider: 'codex', model: 'gpt-deep' }),
      worker({ name: 'web', repos: ['web'], model: 'opus' })
    ])
    r.e.rig.service.decidePlan(sessionId, planId, 'approve')
    expect((await result).value).toMatchObject({
      decision: 'approved',
      models: { api: 'gpt-deep', web: 'opus' },
      providers: { api: 'codex', web: 'claude' }
    })
  })

  it('a worker changed from Codex to Claude is approved on Claude', async () => {
    const r = await rigWithCodex()
    const sessionId = await r.e.startSession('plan_first')
    const { planId, result } = await propose(r.e, sessionId, [
      worker({ provider: 'codex', model: 'gpt-deep' })
    ])
    r.e.rig.service.decidePlan(sessionId, planId, 'approve', {
      api: { provider: 'claude', model: 'sonnet' }
    })
    expect((await result).value).toMatchObject({
      models: { api: 'sonnet' },
      providers: { api: 'claude' }
    })
    const started = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'api',
      task: 'Do api',
      repos: ['api']
    })
    expect(started.value).toMatchObject({ provider: 'claude', model: 'sonnet' })
    expect(r.codex.starts).toHaveLength(0)
  })

  it('refuses a model its provider does not offer and leaves the plan open', async () => {
    const r = await rigWithCodex()
    const sessionId = await r.e.startSession('plan_first')
    const { planId, result } = await propose(r.e, sessionId, [worker()])
    for (const pick of [
      { provider: 'codex' as const, model: 'gpt-nope' },
      // A model of one provider under the other provider's name.
      { provider: 'claude' as const, model: 'gpt-deep' },
      { provider: 'codex' as const, model: 'opus' }
    ]) {
      expect(() => r.e.rig.service.decidePlan(sessionId, planId, 'approve', { api: pick })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' })
      )
    }
    expect(r.e.rig.deps.plansRepo.get(planId)?.status).toBe('proposed')
    r.e.rig.service.decidePlan(sessionId, planId, 'approve', {
      api: { provider: 'codex', model: 'gpt-deep' }
    })
    expect((await result).value).toMatchObject({ providers: { api: 'codex' } })
  })
})
