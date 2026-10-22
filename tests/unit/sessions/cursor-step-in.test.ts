import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderHistoryMissingError } from '../../../src/main/agents/agent-adapter'
import { mapCursorModels } from '../../../src/main/agents/cursor/cursor-probe'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { SessionService } from '../../../src/main/sessions/session-service'
import { HAND_BACK_TEXT } from '../../../src/main/sessions/worker-manager'
import type { ProviderStatus, ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter, FakeCursorAdapter } from './helpers'
import type { FakeHandle } from './helpers'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-cursor-step-in-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

interface Started {
  e: EngineRig
  cursor: FakeCursorAdapter
  sessionId: string
  workerId: string
  worker: FakeHandle
}

const cursorStatus = (): ProviderStatusMap => ({
  cursor: { provider: 'cursor', state: 'ok', message: '', checkedAt: 1 } as ProviderStatus
})

/** A session pinned to Cursor, with one Cursor worker that is Working on session `acp-session-5`. */
async function cursorWorker(): Promise<Started> {
  const cursor = new FakeCursorAdapter()
  const models = new ModelRegistry({
    cursor: {
      listModels: () => Promise.resolve(mapCursorModels([{ modelId: 'default[]', name: 'Auto' }]))
    },
    status: cursorStatus
  })
  await models.refresh()
  e = await makeEngineRig(dir(), {
    cursorAdapter: cursor,
    models,
    providers: { get: cursorStatus, ensureFresh: () => Promise.resolve(cursorStatus().cursor) }
  })
  const sessionId = await e.startSession('autonomous')
  e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'cursor' } })
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'api-retry',
    task: 'Add retries',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  await until(() => cursor.handles.length === 1)
  const worker = cursor.handles[0] as FakeHandle
  worker.emit({
    type: 'session',
    providerSessionId: 'acp-session-5',
    model: 'default[]',
    mcpServers: []
  })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { e, cursor, sessionId, workerId, worker }
}

const row = (s: Started): ReturnType<EngineRig['rig']['deps']['workersRepo']['get']> =>
  s.e.rig.deps.workersRepo.get(s.workerId)

describe('stepping in on a Cursor worker', () => {
  it('interrupts through the handle, stores control and tells the brain', async () => {
    const s = await cursorWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    expect(s.worker.interrupts).toBe(1)
    expect(row(s)).toMatchObject({ provider: 'cursor', userControl: 'active' })
    expect(s.worker.stopped).toBe(false)
    await until(() => s.e.brain().sent.some((t) => t.includes('stepped in on W1 api-retry')))
  })

  it('sends the typed line as a turn, verbatim, including a /command (Cursor reads it itself)', async () => {
    const s = await cursorWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    await s.e.rig.service.sendWorkerInput(s.workerId, 'use 5 retries')
    expect(s.worker.sent.at(-1)).toBe('use 5 retries')
    expect(row(s)).toMatchObject({ controlUserMessages: 1, controlLastMessage: 'use 5 retries' })
    await s.e.rig.service.sendWorkerInput(s.workerId, '/review the diff')
    expect(s.worker.sent.at(-1)).toBe('/review the diff')
  })

  it('holds the brain messages queued behind the turn through discardQueuedSends, drops the nudge, and delivers them at hand-back', async () => {
    const s = await cursorWorker()
    s.worker.discardQueuedSends = vi.fn(() => [
      '[Arc] Message from the brain: use the v2 endpoint',
      '[Arc] You have not called report_done. Commit your work and call report_done.'
    ])

    await s.e.rig.service.stepInWorker(s.workerId)

    expect(s.worker.discardQueuedSends).toHaveBeenCalledTimes(1)
    expect(s.e.rig.deps.heldMessagesRepo.listUndelivered(s.workerId).map((m) => m.body)).toEqual([
      'use the v2 endpoint'
    ])
    expect(s.worker.sent).toEqual(['Add retries'])

    await s.e.rig.service.handBackWorker(s.workerId)
    expect(s.worker.sent.at(-1)).toBe(
      `${HAND_BACK_TEXT}\n\n[Arc] Message from the brain (held while the user was in control): use the v2 endpoint`
    )
    expect(row(s)?.userControl).toBeNull()
  })
})

/** Quits Arc and reopens the session over the same database with a fresh Cursor adapter. */
async function reopen(
  s: Started,
  cursor = new FakeCursorAdapter()
): Promise<{ service: SessionService; cursor: FakeCursorAdapter }> {
  await s.e.rig.service.shutdown()
  const service = new SessionService({
    ...s.e.rig.deps,
    registry: claudeRegistry(new FakeAdapter(), undefined, cursor)
  })
  extra.push(service)
  await service.open(s.sessionId)
  return { service, cursor }
}

describe('quit, pause and relaunch of a Cursor worker', () => {
  it('quitting while in control pauses it; the first typed line loads the ACP session', async () => {
    const s = await cursorWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    const { service, cursor } = await reopen(s)
    expect(row(s)).toMatchObject({ status: 'working', userControl: 'paused', failureReason: null })

    await service.sendWorkerInput(s.workerId, 'use 5 retries')

    expect(cursor.resumes).toHaveLength(1)
    expect(cursor.resumes[0]).toMatchObject({
      provider: 'cursor',
      resume: { threadId: 'acp-session-5' }
    })
    expect((cursor.handles[0] as FakeHandle).sent).toEqual(['use 5 retries'])
    expect(row(s)).toMatchObject({ userControl: 'active', controlUserMessages: 1 })
  })

  it('a worker whose session Cursor no longer has fails with a Cursor reason, and is not started over', async () => {
    const s = await cursorWorker()
    await s.e.rig.service.shutdown()
    const cursor = new FakeCursorAdapter()
    cursor.failResumeWith = new ProviderHistoryMissingError(
      'cursor',
      'acp-session-5',
      'Session "acp-session-5" not found'
    )
    const service = new SessionService({
      ...s.e.rig.deps,
      registry: claudeRegistry(new FakeAdapter(), undefined, cursor)
    })
    extra.push(service)

    await service.continueWorker(s.workerId)

    expect(row(s)).toMatchObject({
      status: 'failed',
      failureReason: 'The Cursor history for W1 is gone.'
    })
    expect(cursor.starts).toHaveLength(0)
  })
})
