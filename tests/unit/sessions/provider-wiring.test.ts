import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderNotAvailableError } from '../../../src/main/agents/provider-registry'
import { bridgeToolNamer } from '../../../src/main/agents/tool-namer'
import { planView } from '../../../src/main/sessions/plan-coordinator'
import type { PlanRow } from '../../../src/main/db/repositories/plans-repo'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-provider-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const named = (name: string): Record<string, unknown> => ({
  name,
  task: `Do ${name}`,
  repos: ['api'],
  model: 'sonnet'
})

describe('the agent layer starts agents through the provider registry', () => {
  it('starts the brain and a worker with registry.adapter("claude")', async () => {
    e = await makeEngineRig(dir())
    const spy = vi.spyOn(e.rig.deps.registry, 'adapter')

    const sessionId = await e.startSession('autonomous')
    expect(sessionId).toBeTruthy()
    expect(spy.mock.calls).toEqual([['claude']])
    expect(e.rig.adapter.starts[0]).toMatchObject({ role: 'brain', provider: 'claude' })

    spy.mockClear()
    const result = await e.call(e.brain(), 'spawn_worker', named('one'))
    expect(result.isError).toBe(false)
    await vi.waitFor(() => expect(e?.rig.adapter.starts).toHaveLength(2))
    expect(spy.mock.calls).toEqual([['claude']])
    expect(e.rig.adapter.starts[1]).toMatchObject({
      role: 'worker',
      provider: 'claude',
      access: 'worker-write'
    })
  })

  it('hands the bridge endpoint and bare tool names to the adapter, with the Claude block for the CLI', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const brain = e.rig.adapter.starts[0]
    expect(brain?.access).toBe('brain-readonly')
    expect(brain?.bridge?.url).toBe(e.bridge.url)
    expect(brain?.bridge?.token).toMatch(/^[0-9a-f]{64}$/)
    expect(brain?.bridgeTools).toContain('spawn_worker')
    expect(brain?.bridgeTools?.every((t) => !t.startsWith('mcp__'))).toBe(true)
    expect(brain?.claude.mcpConfigPath).toContain('.json')
  })
})

describe('AdapterRegistry', () => {
  it('has no Codex adapter yet and says so', async () => {
    e = await makeEngineRig(dir())
    const registry = e.rig.deps.registry
    expect(registry.adapter('claude').provider).toBe('claude')
    expect(() => registry.adapter('codex')).toThrow(ProviderNotAvailableError)
    expect(() => registry.adapter('codex')).toThrow(/codex adapter is not available yet/)
  })
})

describe('BridgeToolNamer', () => {
  it('spells Claude tools with the mcp__arc__ prefix and Codex tools bare (spike S1)', () => {
    expect(bridgeToolNamer('claude').name('spawn_worker')).toBe('mcp__arc__spawn_worker')
    expect(bridgeToolNamer('codex').name('spawn_worker')).toBe('spawn_worker')
    expect(bridgeToolNamer('codex').namespace).toBe('mcp__arc')
    expect(bridgeToolNamer('claude').namespace).toBe('mcp__arc')
  })
})

describe('runningOn on the views', () => {
  it('fills the worker view and details from the provider columns, and the header for the brain', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const spawned = await e.call(e.brain(), 'spawn_worker', named('one'))
    const workerId = String(spawned.value['workerId'])

    const snapshot = e.rig.service.snapshot(sessionId)
    expect(snapshot.workers[0]?.runningOn).toEqual({ provider: 'claude', model: 'sonnet' })
    expect(snapshot.header.brainRunningOn).toEqual({ provider: 'claude', model: 'sonnet' })

    e.rig.deps.workersRepo.setFallback(workerId, 'codex', 'signed_out', 5)
    const after = e.rig.service.snapshot(sessionId)
    expect(after.workers[0]?.runningOn).toEqual({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: 'signed_out'
    })
    const details = await e.rig.service.workerDetails(workerId)
    expect(details.runningOn).toMatchObject({ requestedProvider: 'codex' })
  })

  it('gives each plan worker the provider and model it will run on', () => {
    const row = {
      id: 'p',
      sessionId: 's',
      status: 'proposed',
      workersJson: JSON.stringify([
        { name: 'a', task: 't', repos: [], model: null, rationale: 'r' },
        { name: 'b', task: 't', repos: [], model: 'haiku', rationale: 'r' },
        {
          name: 'c',
          task: 't',
          repos: [],
          model: 'haiku',
          rationale: 'r',
          provider: 'codex',
          approvedModel: 'gpt-5.5',
          approvedProvider: 'codex'
        }
      ]),
      messageId: null,
      replacedById: null,
      createdAt: 1,
      resolvedAt: null
    } as unknown as PlanRow
    expect(planView(row).workers.map((w) => w.runningOn)).toEqual([
      { provider: 'claude', model: 'sonnet' },
      { provider: 'claude', model: 'haiku' },
      { provider: 'codex', model: 'gpt-5.5' }
    ])
  })
})
