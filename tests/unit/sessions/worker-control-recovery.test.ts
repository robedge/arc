import { existsSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../../src/main/sessions/session-service'
import { HAND_BACK_TEXT } from '../../../src/main/sessions/worker-manager'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter } from './helpers'
import type { FakeHandle } from './helpers'
import { spawnWorker } from './merge-rig'
import type { DoneWorker } from './merge-rig'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-control-recovery-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

const row = (id: string): ReturnType<EngineRig['rig']['deps']['workersRepo']['get']> =>
  e?.rig.deps.workersRepo.get(id)

/** A worker that stored its Claude session id, is Working and the user has stepped in on. */
async function controlledWorker(): Promise<DoneWorker> {
  e = await makeEngineRig(dir())
  await e.startSession('autonomous')
  const w = await spawnWorker(e, 'api-retry', 'api', { 'a.txt': 'a\n' })
  w.handle.emit({
    type: 'session',
    providerSessionId: 'claude-api-retry',
    model: 'claude-sonnet-5-5',
    mcpServers: [{ name: 'arc', status: 'connected' }]
  })
  await until(() => row(w.workerId)?.status === 'working')
  await e.rig.service.stepInWorker(w.workerId)
  return w
}

/** Quits Arc, builds a new service over the same database and reopens the session, as a relaunch would. */
async function relaunch(
  workerId: string
): Promise<{ service: SessionService; adapter: FakeAdapter }> {
  if (!e) throw new Error('rig')
  const sessionId = row(workerId)?.sessionId ?? ''
  await e.rig.service.shutdown()
  const adapter = new FakeAdapter()
  const service = new SessionService({ ...e.rig.deps, registry: claudeRegistry(adapter) })
  extra.push(service)
  await service.open(sessionId)
  return { service, adapter }
}

const workerStart = (adapter: FakeAdapter): FakeAdapter['starts'][number] | undefined =>
  adapter.starts.find((o) => o.role === 'worker')
const workerHandle = (adapter: FakeAdapter): FakeHandle =>
  adapter.handles.find((h) => h.agentId.startsWith('worker-')) as FakeHandle

describe('quitting while in control', () => {
  it('leaves the worker paused, not stopped', async () => {
    const w = await controlledWorker()
    await relaunch(w.workerId)
    expect(row(w.workerId)).toMatchObject({
      status: 'working',
      userControl: 'paused',
      stoppedBy: null,
      failureReason: null
    })
  })
})

describe('after a restart, while paused', () => {
  it('the first typed line resumes the worker with --resume and is the first message', async () => {
    const w = await controlledWorker()
    const { service, adapter } = await relaunch(w.workerId)

    await service.sendWorkerInput(w.workerId, '/awos:spec use 5 retries')

    expect(workerStart(adapter)).toMatchObject({
      agentId: `worker-${w.workerId}`,
      cwd: w.treePath,
      resume: { threadId: 'claude-api-retry' }
    })
    const handle = workerHandle(adapter)
    expect(handle.sent).toEqual(['/awos:spec use 5 retries'])
    expect(row(w.workerId)).toMatchObject({
      userControl: 'active',
      controlUserMessages: 1,
      controlLastMessage: '/awos:spec use 5 retries'
    })
  })

  it('Hand back resumes it with the hand-back text as the first message and ends control', async () => {
    const w = await controlledWorker()
    const { service, adapter } = await relaunch(w.workerId)

    await service.handBackWorker(w.workerId)

    expect(workerStart(adapter)).toMatchObject({ resume: { threadId: 'claude-api-retry' } })
    expect(workerHandle(adapter).sent).toEqual([HAND_BACK_TEXT])
    expect(row(w.workerId)?.userControl).toBeNull()
  })

  it('a process that dies after the resumed line pauses the worker again', async () => {
    const w = await controlledWorker()
    const { service, adapter } = await relaunch(w.workerId)
    await service.sendWorkerInput(w.workerId, 'go')
    const handle = workerHandle(adapter)
    handle.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: '' })
    handle.queue.close()
    await until(() => row(w.workerId)?.userControl === 'paused')
    expect(row(w.workerId)).toMatchObject({ status: 'starting', failureReason: null })
  })

  it('typing is refused when the working copy is gone', async () => {
    const w = await controlledWorker()
    const { service, adapter } = await relaunch(w.workerId)
    rmSync(w.treePath, { recursive: true, force: true })

    await expect(service.sendWorkerInput(w.workerId, 'hi')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(service.handBackWorker(w.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    expect(adapter.starts.filter((o) => o.role === 'worker')).toHaveLength(0)
    expect(row(w.workerId)?.userControl).toBe('paused')
  })

  it('the user can still stop a paused worker, which ends control', async () => {
    const w = await controlledWorker()
    const { service } = await relaunch(w.workerId)

    await service.stopWorker(w.workerId)

    expect(row(w.workerId)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'user',
      userControl: null
    })
    expect(e?.rig.deps.worktreesRepo.listControlBases(w.workerId)).toEqual([])
    expect(existsSync(w.treePath)).toBe(false)
  })
})

describe('Stop while in control', () => {
  it('ends control with the stop', async () => {
    const w = await controlledWorker()
    await e?.rig.service.stopWorker(w.workerId)
    await until(() => row(w.workerId)?.status === 'stopped')
    expect(row(w.workerId)).toMatchObject({ stoppedBy: 'user', userControl: null })
    expect(row(w.workerId)?.controlStartedAt).toBeNull()
  })
})
