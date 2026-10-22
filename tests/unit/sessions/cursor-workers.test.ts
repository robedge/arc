import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersonalLaunchConfig } from '../../../src/main/personal/personal-config'
import { BypassDetector } from '../../../src/main/personal/bypass-detector'
import { mapCursorModels } from '../../../src/main/agents/cursor/cursor-probe'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { buildResolverPrompt, buildWorkerPrompt } from '../../../src/main/sessions/worker-manager'
import type { WorkerManager } from '../../../src/main/sessions/worker-manager'
import type {
  ProviderState,
  ProviderStatus,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import { listTools } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { FakeCursorAdapter } from './helpers'
import { eventTexts } from './merge-rig'
import type { FakeHandle } from './helpers'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-cursor-workers-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const MODELS = mapCursorModels([
  { modelId: 'default[]', name: 'Auto' },
  { modelId: 'claude-haiku-5-5[thinking=true]', name: 'claude-haiku-5-5' },
  { modelId: 'gpt-5.4[reasoning=medium]', name: 'gpt-5.4' }
])

interface CursorRig {
  e: EngineRig
  cursor: FakeCursorAdapter
  setState: (state: ProviderState | undefined) => void
  ensureFresh: ReturnType<typeof vi.fn>
}

async function cursorRig(
  initial: ProviderState = 'ok',
  personal?: PersonalLaunchConfig
): Promise<CursorRig> {
  const cursor = new FakeCursorAdapter()
  let state: ProviderState | undefined = initial
  const map = (): ProviderStatusMap =>
    state === undefined
      ? {}
      : { cursor: { provider: 'cursor', state, message: '', checkedAt: 1 } as ProviderStatus }
  const models = new ModelRegistry({
    cursor: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  await models.refresh()
  const ensureFresh = vi.fn(() => Promise.resolve(map().cursor))
  e = await makeEngineRig(dir(), {
    cursorAdapter: cursor,
    models,
    providers: { get: map, ensureFresh },
    ...(personal ? { personal } : {})
  })
  return {
    e,
    cursor,
    ensureFresh,
    setState: (next) => {
      state = next
    }
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

describe('a session pinned to Cursor starts Cursor workers', () => {
  it('starts registry.adapter("cursor") with a Cursor start in the first working copy, and stores the row', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    const adapterSpy = vi.spyOn(r.e.rig.deps.registry, 'adapter')

    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      status: 'started',
      provider: 'cursor',
      model: 'default[]'
    })
    await until(() => r.cursor.starts.length === 1)
    expect(adapterSpy.mock.calls).toEqual([['cursor']])
    const start = r.cursor.starts[0]
    expect(start).toMatchObject({
      provider: 'cursor',
      role: 'worker',
      model: 'default[]',
      access: 'worker-write',
      cursor: {}
    })
    expect(start).not.toHaveProperty('claude')
    expect(start).not.toHaveProperty('codex')
    // cwd is the worker's own working copy; Arc's instructions and the bridge ride along.
    const workerId = String(result.value['workerId'])
    const trees = r.e.rig.deps.worktreesRepo.listByWorker(workerId)
    expect(trees).toHaveLength(1)
    expect(start?.cwd).toBe(trees[0]?.path)
    expect(start?.bridge?.url).toBe(r.e.bridge.url)
    expect(start?.bridge?.token).toMatch(/^[0-9a-f]{64}$/)
    expect(start?.bridgeTools).toContain('report_done')
    expect(start?.bridgeTools).not.toContain('request_permission')
    // Cursor asks over ACP: the start carries the approval handler that feeds the coordinator.
    expect(start?.cursor.approvals).toBeDefined()
    expect(start?.instructions).toContain('[arc-role:worker]')
    expect(start?.instructions).toContain('wait_for')
    expect(start?.instructions).not.toContain('ToolSearch')
    // Only the brain ran on Claude.
    expect(r.e.rig.adapter.starts.map((s) => s.role)).toEqual(['brain'])
    expect(r.e.rig.deps.workersRepo.get(workerId)).toMatchObject({
      provider: 'cursor',
      model: 'default[]'
    })
  })

  it('stores the ACP session id from the session event', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    const workerId = String(result.value['workerId'])
    await until(() => r.cursor.handles.length === 1)
    const handle = r.cursor.handles[0] as FakeHandle
    expect(handle.provider).toBe('cursor')

    handle.emit({
      type: 'session',
      providerSessionId: 'acp-session-1',
      model: 'default[]',
      mcpServers: [{ name: 'arc', status: 'ready' }]
    })
    await until(() => r.e.rig.deps.workersRepo.get(workerId)?.status === 'working')
    expect(r.e.rig.deps.workersRepo.get(workerId)).toMatchObject({
      provider: 'cursor',
      providerSessionId: 'acp-session-1'
    })
  })

  it('gives the worker the bridge with wait_for, and a Claude worker the bridge without it', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    await until(() => r.cursor.starts.length === 1)
    const bridge = r.cursor.starts[0]?.bridge
    const cursorTools = await listTools({
      url: bridge?.url ?? '',
      headers: { authorization: `Bearer ${bridge?.token}` }
    })
    expect(cursorTools).toEqual(['ask_brain', 'report_done', 'report_progress', 'wait_for'])

    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'claude' } })
    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('docs'))
    await until(() => r.e.workerHandle(0) !== undefined)
    const claudeTools = await listTools(r.e.configOf(r.e.workerHandle(0)))
    expect(claudeTools).not.toContain('wait_for')
    expect(claudeTools).toContain('ask_brain')
  })

  it('accepts a listed Cursor model id from the brain', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'auto' } })
    const result = await r.e.call(
      r.e.brain(),
      'spawn_worker',
      spawnArgs('review', { provider: 'cursor', model: 'gpt-5.4[reasoning=medium]' })
    )
    expect(result.value).toMatchObject({
      provider: 'cursor',
      model: 'gpt-5.4[reasoning=medium]',
      note: null
    })
    await until(() => r.cursor.starts.length === 1)
    expect(r.cursor.starts[0]?.model).toBe('gpt-5.4[reasoning=medium]')
  })

  it('replaces an unknown Cursor model with the default and says so', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'auto' } })
    const result = await r.e.call(
      r.e.brain(),
      'spawn_worker',
      spawnArgs('review', { provider: 'cursor', model: 'nope[]' })
    )
    expect(result.value).toMatchObject({
      provider: 'cursor',
      model: 'default[]',
      note: expect.stringContaining('Unknown model "nope[]"') as unknown
    })
  })

  it('runs on Claude when Cursor is not signed in, as for Codex', async () => {
    const r = await cursorRig('signed_out')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(result.value).toMatchObject({ provider: 'claude' })
    expect(r.cursor.starts).toHaveLength(0)
  })

  it('a Claude worker keeps its prompt and is not given the Cursor bridge shape', async () => {
    const r = await cursorRig()
    await r.e.startSession('autonomous')
    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('docs'))
    await until(() => r.e.rig.adapter.starts.some((s) => s.role === 'worker'))
    const start = r.e.rig.adapter.starts.find((s) => s.role === 'worker')
    expect(start?.instructions).toContain('ToolSearch')
    expect(start?.instructions).not.toContain('wait_for')
    expect(r.cursor.starts).toHaveLength(0)
  })
})

describe('plan-first with Cursor', () => {
  it('stores a Cursor proposal, approves the user pick and starts the worker on Cursor', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('plan_first')
    const result = r.e.call(r.e.brain(), 'propose_plan', {
      workers: [
        {
          name: 'api',
          task: 'Do api',
          repos: ['api'],
          rationale: 'because',
          provider: 'cursor',
          model: 'claude-haiku-5-5[thinking=true]'
        }
      ]
    })
    await until(() => r.e.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
    const planId = r.e.rig.deps.plansRepo.latest(sessionId)?.id ?? ''
    expect(r.e.rig.service.snapshot(sessionId).plan?.workers[0]).toMatchObject({
      provider: 'cursor',
      model: 'claude-haiku-5-5[thinking=true]'
    })
    r.e.rig.service.decidePlan(sessionId, planId, 'approve', {
      api: { provider: 'cursor', model: 'default[]' }
    })
    expect((await result).value).toEqual({
      planId,
      decision: 'approved',
      models: { api: 'default[]' },
      providers: { api: 'cursor' }
    })
    const started = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('api'))
    expect(started.value).toMatchObject({ provider: 'cursor', model: 'default[]' })
    await until(() => r.cursor.starts.length === 1)
  })
})

interface SessionInternals {
  workers: WorkerManager
  isRateLimitWaiting: (provider: string) => boolean
  rateLimit: {
    limitedProviders: () => ReadonlySet<string>
    cancel: (agentId: string) => void
    hit: (agentId: string, hit: { provider: string; retry: () => void }) => boolean
  }
}

function internalsOf(r: CursorRig, sessionId: string): SessionInternals {
  const orchestrators = (
    r.e.rig.service as unknown as { orchestrators: Map<string, SessionInternals> }
  ).orchestrators
  const orchestrator = orchestrators.get(sessionId)
  if (!orchestrator) throw new Error('no orchestrator')
  return orchestrator
}

const SIGNED_OUT_SENTENCE = "Cursor isn't signed in. Run agent login in Terminal to use Cursor."

describe('a worker meant for Cursor while Cursor is not ready', () => {
  it('runs on Claude, stores requested_provider and logs the card line with the worker name', async () => {
    const r = await cursorRig('signed_out')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(result.value).toMatchObject({ provider: 'claude', model: 'sonnet' })
    expect(r.e.rig.deps.workersRepo.get(String(result.value['workerId']))).toMatchObject({
      provider: 'claude',
      requestedProvider: 'cursor',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    expect(r.e.rig.service.snapshot(sessionId).workers[0]?.runningOn).toEqual({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'cursor',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
    expect(eventTexts(r.e, sessionId)).toContain(
      "Cursor isn't signed in, so W1 runs on Claude. Run agent login in Terminal to use Cursor."
    )
    expect(r.cursor.starts).toHaveLength(0)
  })

  it('a Cursor that went down between the spawn and the start moves the worker too', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    let calls = 0
    r.ensureFresh.mockImplementation(() => {
      calls += 1
      if (calls >= 2) r.setState('signed_out')
      return Promise.resolve(undefined)
    })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(result.value).toMatchObject({ provider: 'cursor' })
    await until(() => r.e.rig.adapter.starts.some((x) => x.role === 'worker'))
    expect(r.cursor.starts).toHaveLength(0)
    expect(r.e.rig.deps.workersRepo.get(String(result.value['workerId']))).toMatchObject({
      provider: 'claude',
      requestedProvider: 'cursor',
      fallbackReason: SIGNED_OUT_SENTENCE
    })
  })

  it('a Cursor at its limit (the retry failed too) gives new work to Claude with the limit reason', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    internalsOf(r, sessionId).rateLimit.limitedProviders = () => new Set(['cursor'])
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(result.value).toMatchObject({ provider: 'claude' })
    expect(r.e.rig.deps.workersRepo.get(String(result.value['workerId']))).toMatchObject({
      requestedProvider: 'cursor',
      fallbackReason: 'Cursor has reached its usage limit.'
    })
    expect(eventTexts(r.e, sessionId)).toContain(
      'Cursor has reached its usage limit, so W1 runs on Claude.'
    )
    expect(r.cursor.starts).toHaveLength(0)
  })
})

describe('a worker that runs a Cursor command', () => {
  it('is blocked, not moved to Claude, when Cursor is not ready', async () => {
    const r = await cursorRig('signed_out')
    const sessionId = await r.e.startSession('autonomous')
    const workers = internalsOf(r, sessionId).workers
    const target = await workers.resolveTarget({ command: { provider: 'cursor', name: '/review' } })
    const outcome = await workers
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
    const reason =
      "W1 needs Cursor for /review. Cursor isn't signed in. Run agent login in Terminal to use Cursor."
    expect(outcome).toMatchObject({ code: 'cursor_unavailable', message: reason })
    expect(r.e.rig.deps.workersRepo.listBySession(sessionId)[0]).toMatchObject({
      status: 'failed',
      provider: 'cursor',
      failureReason: reason,
      requestedProvider: null
    })
    expect(r.cursor.starts).toHaveLength(0)
    expect(r.e.rig.adapter.starts.map((s) => s.role)).toEqual(['brain'])
  })
})

describe('a Cursor worker that hits its plan limit', () => {
  it('waits with the Cursor message and pauses the queue', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    await until(() => r.cursor.handles.length === 1)
    ;(r.cursor.handles[0] as FakeHandle).emit({
      type: 'error',
      kind: 'rate-limit',
      message: 'Upgrade your plan to continue'
    })
    await until(() => internalsOf(r, sessionId).isRateLimitWaiting('cursor'))
    expect(eventTexts(r.e, sessionId)).toContain(
      'Waiting for the Cursor usage limit (trying again in 5 minutes)'
    )
  })
})

/** A Cursor worker that hit the plan limit and now waits; resolves with its id. */
async function limitedCursorWorker(r: CursorRig, sessionId: string): Promise<string> {
  const started = await r.e.call(
    r.e.brain(),
    'spawn_worker',
    spawnArgs('review', { provider: 'cursor' })
  )
  await until(() => r.cursor.handles.length === 1)
  ;(r.cursor.handles[0] as FakeHandle).emit({
    type: 'error',
    kind: 'rate-limit',
    message: 'You have reached your usage limit'
  })
  await until(() => internalsOf(r, sessionId).isRateLimitWaiting('cursor'))
  return String(started.value['workerId'])
}

/** Claude waits for its limit too, so a held Cursor worker has nowhere to go. */
function claudeWaits(r: CursorRig, sessionId: string): void {
  internalsOf(r, sessionId).rateLimit.hit('worker-claude-wait', {
    provider: 'claude',
    retry: () => undefined
  })
}

const spawnOn = (r: CursorRig, name: string, provider: 'claude' | 'cursor') =>
  r.e.call(r.e.brain(), 'spawn_worker', spawnArgs(name, { provider }))

const rowOf = (r: CursorRig, result: { value: Record<string, unknown> }) =>
  r.e.rig.deps.workersRepo.get(String(result.value['workerId']))

describe('a Cursor usage-limit wait holds only the Cursor workers', () => {
  it('lets a Claude worker start and starts a new Cursor one on Claude with the fallback line', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    await limitedCursorWorker(r, sessionId)

    const claude = await spawnOn(r, 'docs', 'claude')
    expect(claude.value).toMatchObject({ status: 'started', provider: 'claude' })

    const moved = await spawnOn(r, 'web', 'cursor')
    expect(moved.value).toMatchObject({ status: 'started', provider: 'claude' })
    expect(rowOf(r, moved)).toMatchObject({
      provider: 'claude',
      requestedProvider: 'cursor',
      fallbackReason: 'Cursor has reached its usage limit.'
    })
    expect(eventTexts(r.e, sessionId)).toContain(
      'Cursor has reached its usage limit, so W3 runs on Claude.'
    )
    expect(r.cursor.starts).toHaveLength(1)
  })

  it('holds a new Cursor worker with the reason when nothing can stand in, and starts it when the wait ends', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    const first = await limitedCursorWorker(r, sessionId)
    claudeWaits(r, sessionId)

    const held = await spawnOn(r, 'web', 'cursor')
    expect(held.value).toMatchObject({ status: 'queued', provider: 'cursor' })
    expect(rowOf(r, held)).toMatchObject({ status: 'queued', activity: 'Waiting for Cursor limit' })
    const texts = eventTexts(r.e, sessionId)
    expect(texts).toContain('W2 web queued: waiting for the Cursor usage limit')
    expect(texts.some((t) => t.includes('(limit'))).toBe(false)

    internalsOf(r, sessionId).rateLimit.cancel(`worker-${first}`)
    await until(() => r.cursor.starts.length === 2)
  })

  it('names the provider wait, not the limit, when a worker is both over the limit and held', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    await limitedCursorWorker(r, sessionId)
    claudeWaits(r, sessionId)

    const held = await spawnOn(r, 'web', 'cursor')
    expect(held.value['status']).toBe('queued')
    expect(rowOf(r, held)?.activity).toBe('Waiting for Cursor limit')
    const texts = eventTexts(r.e, sessionId)
    expect(texts).toContain('W2 web queued: waiting for the Cursor usage limit')
    expect(texts.some((t) => t.includes('(limit'))).toBe(false)
  })

  it('keeps the over-the-limit reason when the limit is the cause', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    await spawnOn(r, 'review', 'cursor')
    const queued = await spawnOn(r, 'docs', 'claude')
    expect(queued.value['status']).toBe('queued')
    expect(eventTexts(r.e, sessionId)).toContain('W2 docs queued (limit 1)')
    expect(rowOf(r, queued)?.activity).toBe('Queued')
  })

  it('drain relabels every held row, even past the limit, and a ended wait that is still over the limit reads Queued', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    const first = await limitedCursorWorker(r, sessionId)
    claudeWaits(r, sessionId)
    const held = await spawnOn(r, 'web', 'cursor')
    expect(rowOf(r, held)?.activity).toBe('Waiting for Cursor limit')
    const events = eventTexts(r.e, sessionId).length

    // The Cursor wait ends while W1 still fills the limit: the card goes back to Queued.
    internalsOf(r, sessionId).rateLimit.cancel(`worker-${first}`)
    expect(rowOf(r, held)).toMatchObject({
      status: 'queued',
      activity: 'Queued',
      provider: 'cursor'
    })
    expect(eventTexts(r.e, sessionId)).toHaveLength(events)
  })

  it('drain moves a held worker that has not run to the stand-in once one is ready, and starts it within the limit', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    await limitedCursorWorker(r, sessionId)
    claudeWaits(r, sessionId)
    const held = await spawnOn(r, 'web', 'cursor')
    expect(rowOf(r, held)?.status).toBe('queued')

    // Claude's wait ends: Claude can take the worker, but the limit is still full.
    internalsOf(r, sessionId).rateLimit.cancel('worker-claude-wait')
    expect(rowOf(r, held)).toMatchObject({
      status: 'queued',
      activity: 'Queued',
      provider: 'claude',
      requestedProvider: 'cursor'
    })
    expect(eventTexts(r.e, sessionId)).toContain(
      'Cursor has reached its usage limit, so W2 runs on Claude.'
    )

    r.e.rig.service.setConfig(sessionId, { workerLimit: 2 })
    await until(() => rowOf(r, held)?.status !== 'queued')
    expect(r.cursor.starts).toHaveLength(1)
  })

  it('does not move a held worker that runs a Cursor command', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    await limitedCursorWorker(r, sessionId)
    const held = await internalsOf(r, sessionId).workers.spawn({
      input: { name: 'review', task: 'Review W1', repos: ['api'], command: '/review' },
      planId: null,
      provider: 'cursor',
      model: 'default[]',
      modelNote: null,
      fallback: undefined,
      blocked: undefined
    })
    expect(held).toMatchObject({ status: 'queued', provider: 'cursor' })
    expect(r.e.rig.deps.workersRepo.get(held.workerId)?.activity).toBe('Waiting for Cursor limit')
  })
})

describe('a Cursor worker whose model is not on the plan', () => {
  it('fails with the plan sentence, does not wait, and tells the brain', async () => {
    const r = await cursorRig('ok')
    const sessionId = await r.e.startSession('autonomous')
    const started = await r.e.call(
      r.e.brain(),
      'spawn_worker',
      spawnArgs('review', { provider: 'cursor' })
    )
    const workerId = String(started.value['workerId'])
    await until(() => r.cursor.handles.length === 1)
    const handle = r.cursor.handles[0] as FakeHandle
    const sent = handle.sent.length
    handle.emit({
      type: 'error',
      kind: 'plan-refused',
      message: 'Upgrade your plan to continue'
    })
    handle.emit({ type: 'turn-result', ok: false, interrupted: false, durationMs: 1 })
    await until(() => r.e.rig.deps.workersRepo.get(workerId)?.status === 'failed')

    const reason = "Cursor refused Auto: it isn't on your Cursor plan. Choose another model."
    expect(r.e.rig.deps.workersRepo.get(workerId)?.failureReason).toBe(reason)
    expect(eventTexts(r.e, sessionId)).toContain(`W1 review failed: ${reason}`)
    expect(internalsOf(r, sessionId).isRateLimitWaiting('cursor')).toBe(false)
    // No nudge about report_done, no wait line.
    expect(handle.sent).toHaveLength(sent)
    expect(eventTexts(r.e, sessionId).some((t) => t.includes('usage limit'))).toBe(false)
  })
})

describe('the worker and resolver prompts', () => {
  const input = {
    groupName: 'Alpha',
    number: 2,
    slug: 'api-retry',
    task: 'Add retries',
    branchName: 'arc/retry',
    worktrees: [{ projectName: 'api', path: '/w/api' }]
  }

  it('tell a Cursor worker to call the arc tools directly and to follow pending with wait_for', () => {
    const prompt = buildWorkerPrompt({ ...input, provider: 'cursor' })
    expect(prompt).toContain('MCP server named `arc`')
    expect(prompt).toContain('wait_for')
    expect(prompt).toContain('"status":"pending"')
    expect(prompt).not.toContain('ToolSearch')
  })

  it('tell a Cursor worker not to work around a rejected action but to ask the brain', () => {
    expect(buildWorkerPrompt({ ...input, provider: 'cursor' })).toContain(
      "If an action is rejected, don't work around it; call ask_brain."
    )
    expect(buildWorkerPrompt({ ...input, provider: 'claude' })).not.toContain(
      'If an action is rejected'
    )
  })

  it.each([undefined, 'claude', 'codex'] as const)(
    'keep the ToolSearch rule for %s',
    (provider) => {
      const prompt = buildWorkerPrompt({ ...input, provider })
      expect(prompt).toContain('ToolSearch')
      expect(prompt).not.toContain('wait_for')
    }
  )

  it('tell a Cursor resolver the same', () => {
    const resolver = {
      groupName: 'Alpha',
      number: 3,
      label: 'W1 api-retry',
      projectName: 'api',
      branchName: 'arc/retry',
      mergePath: '/m',
      files: ['a.txt']
    }
    expect(buildResolverPrompt({ ...resolver, provider: 'cursor' })).toContain('wait_for')
    expect(buildResolverPrompt(resolver)).toContain('ToolSearch')
    expect(buildResolverPrompt(resolver)).not.toContain('wait_for')
  })
})

/** sha256 of every file under `<home>/.cursor` that the test wrote, ignoring Cursor's own `privacyCache.updatedAt`. */
function cursorFileHashes(home: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const file = join(home, '.cursor', name)
    if (!existsSync(file)) {
      out[name] = 'absent'
      continue
    }
    let text = readFileSync(file, 'utf8')
    try {
      const parsed = JSON.parse(text) as { privacyCache?: { updatedAt?: unknown } }
      if (parsed.privacyCache) delete parsed.privacyCache.updatedAt
      text = JSON.stringify(parsed)
    } catch {
      // not JSON: hash the raw bytes
    }
    out[name] = createHash('sha256').update(text).digest('hex')
  }
  return out
}

describe("Arc's deny file for a Cursor worker (tech spec 2.4)", () => {
  const eventsOf = (
    r: CursorRig,
    sessionId: string
  ): { kind: string; text: string; dataJson: string | null; workerId: string | null }[] =>
    r.e.rig.deps.eventsRepo.latest(sessionId, 100)

  async function startCursorWorker(r: CursorRig, sessionId: string, name: string): Promise<string> {
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs(name))
    expect(result.isError).toBe(false)
    return String(result.value['workerId'])
  }

  const denyOf = (path: string): string[] =>
    (
      JSON.parse(readFileSync(join(path, '.cursor', 'cli.json'), 'utf8')) as {
        permissions: { deny: string[] }
      }
    ).permissions.deny

  it("is written into the worker's working copy before Cursor starts, hidden from git, and denies the checkouts and the knowledge folder but not the working copy", async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    const workerId = await startCursorWorker(r, sessionId, 'review')
    await until(() => r.cursor.starts.length === 1)
    const tree = r.e.rig.deps.worktreesRepo.listByWorker(workerId)[0]?.path ?? ''

    const deny = denyOf(tree)
    expect(deny).toContain('Shell(git push)')
    expect(deny).toContain('Shell(gh)')
    expect(
      deny.some((d) => d.startsWith('Write(') && d.includes(r.e.api.path) && d.endsWith('/**)'))
    ).toBe(true)
    expect(deny.some((d) => d.includes('/knowledge/**)'))).toBe(true)
    expect(deny.filter((d) => d.includes(tree))).toEqual([])
    expect(gitIn(tree, 'status', '--short')).toBe('')
    expect(gitIn(tree, 'check-ignore', '-v', '.cursor/cli.json')).toContain('info/exclude')
  })

  it("is refreshed in a running worker's working copy when another worker's copy appears", async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    const first = await startCursorWorker(r, sessionId, 'first')
    await until(() => r.cursor.starts.length === 1)
    const firstTree = r.e.rig.deps.worktreesRepo.listByWorker(first)[0]?.path ?? ''
    expect(denyOf(firstTree).filter((d) => d.includes('/worktrees/'))).toEqual([])

    const second = await startCursorWorker(r, sessionId, 'second')
    await until(() => r.cursor.starts.length === 2)
    const secondTree = r.e.rig.deps.worktreesRepo.listByWorker(second)[0]?.path ?? ''

    expect(denyOf(firstTree).some((d) => d.includes(secondTree))).toBe(true)
    expect(denyOf(secondTree).some((d) => d.includes(firstTree))).toBe(true)
    expect(denyOf(secondTree).some((d) => d.includes(secondTree))).toBe(false)
  })

  it('turns a tool call that completed without asking into a cursor-blocked event for that worker', async () => {
    const r = await cursorRig()
    const sessionId = await r.e.startSession('autonomous')
    const workerId = await startCursorWorker(r, sessionId, 'review')
    await until(() => r.cursor.starts.length === 1)
    const start = r.cursor.starts[0]
    const tree = r.e.rig.deps.worktreesRepo.listByWorker(workerId)[0]?.path ?? ''
    const base = {
      status: 'completed',
      rawInput: {},
      locations: [],
      content: [],
      permissionAsked: false,
      startedAt: 1,
      inProgressAt: 2,
      completedAt: 64
    }

    start?.cursor.onUnasked?.({
      ...base,
      toolCallId: 'a',
      title: '',
      kind: 'execute',
      rawInput: { command: 'git push origin HEAD' }
    })
    start?.cursor.onUnasked?.({
      ...base,
      toolCallId: 'b',
      title: '',
      kind: 'execute',
      rawInput: { command: 'git status' },
      rawOutput: { exitCode: 0, stdout: '', stderr: '' }
    })
    start?.cursor.onUnasked?.({
      ...base,
      toolCallId: 'c',
      title: '',
      kind: 'edit',
      locations: [join(r.e.web.path, 'src', 'x.ts')],
      content: [{ type: 'diff', path: join(r.e.web.path, 'src', 'x.ts') }]
    })
    start?.cursor.onUnasked?.({
      ...base,
      toolCallId: 'd',
      title: '',
      kind: 'edit',
      locations: [join(tree, 'ok.ts')],
      content: [{ type: 'diff', path: join(tree, 'ok.ts') }]
    })

    const notes = eventsOf(r, sessionId).filter((e) => e.kind === 'cursor-blocked')
    expect(notes.map((n) => JSON.parse(n.dataJson ?? '{}') as Record<string, string>)).toEqual(
      [
        expect.objectContaining({ workerId, outcome: 'outside-edit', kind: 'edit' }),
        expect.objectContaining({
          workerId,
          action: 'git push origin HEAD',
          outcome: 'blocked',
          kind: 'execute'
        })
      ].reverse()
    )
    expect(notes.every((n) => n.workerId === workerId)).toBe(true)
    expect(notes.map((n) => n.text).join('\n')).toContain('W1 (Cursor)')
  })

  it("leaves the user's ~/.cursor files unchanged through a worker start and the bypass check", async () => {
    const home = join(dir(), 'home')
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const config = {
      permissions: { allow: ['Shell(ls)'], deny: [] },
      approvalMode: 'allowlist',
      privacyCache: { updatedAt: 1 }
    }
    writeFileSync(join(home, '.cursor', 'cli-config.json'), JSON.stringify(config))
    writeFileSync(
      join(home, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'x' }] } })
    )
    const names = ['cli-config.json', 'hooks.json', 'mcp.json', 'cli.json']
    vi.stubEnv('HOME', home)
    try {
      const before = cursorFileHashes(home, names)
      const r = await cursorRig()
      const sessionId = await r.e.startSession('autonomous')
      await startCursorWorker(r, sessionId, 'review')
      await until(() => r.cursor.starts.length === 1)
      const report = await new BypassDetector({ getHome: () => home }).detect([r.e.api.path])
      expect(report.cursor?.allowEntries).toEqual(['Shell(ls)'])
      expect(report.cursor?.hookEvents).toEqual(['preToolUse'])
      // Cursor itself rewrites privacyCache.updatedAt on runs; that field is not compared.
      const file = join(home, '.cursor', 'cli-config.json')
      const bumped = JSON.parse(readFileSync(file, 'utf8')) as typeof config
      bumped.privacyCache.updatedAt = 999
      writeFileSync(file, JSON.stringify(bumped))
      expect(cursorFileHashes(home, names)).toEqual(before)
      expect(existsSync(join(home, '.cursor', 'cli.json'))).toBe(false)
      expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the user Cursor servers switched off for Workers', () => {
  it('adds a no-op session entry, an Mcp deny entry and a rejecting handler for each', async () => {
    const cursorMcp = vi.fn((_cwd: string, role: 'brain' | 'workers') =>
      Promise.resolve({
        servers: ['github', 'linear'],
        off: role === 'workers' ? ['github'] : [],
        degraded: false
      })
    )
    const personal: PersonalLaunchConfig = {
      claude: () => Promise.reject(new Error('no claude here')),
      codexMcp: () => Promise.resolve({ servers: [], degraded: false }),
      cursorMcp
    }
    const r = await cursorRig('ok', personal)
    const sessionId = await r.e.startSession('autonomous')
    r.e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
    const result = await r.e.call(r.e.brain(), 'spawn_worker', spawnArgs('review'))
    expect(result.isError).toBe(false)
    await until(
      () => r.cursor.starts.length === 2 || r.cursor.starts.some((s) => s.role === 'worker')
    )
    const start = r.cursor.starts.find((s) => s.role === 'worker')
    expect(start?.cursor.offMcpServers).toEqual(['github'])
    expect(cursorMcp).toHaveBeenCalledWith(start?.cwd, 'workers')
    const denyFile = join(start?.cwd ?? '', '.cursor', 'cli.json')
    expect(readFileSync(denyFile, 'utf8')).toContain('Mcp(github:*)')
    expect(readFileSync(denyFile, 'utf8')).not.toContain('Mcp(linear:*)')
    const decision = await start?.cursor.approvals?.handle(
      {
        agentId: 'w',
        sessionId: 'p',
        requestId: 0,
        toolCallId: 't',
        title: 'github-search: search',
        kind: 'other',
        options: [],
        raw: {}
      },
      new AbortController().signal
    )
    expect(decision?.decision).toBe('reject')
  })
})
