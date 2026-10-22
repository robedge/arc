import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { WORKER_PUSH_MS } from '../../../src/main/sessions/worker-manager'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-worker-channels-')
let e: EngineRig | undefined

afterEach(async () => {
  vi.useRealTimers()
  await e?.close()
  e = undefined
})

const apiWorker = { name: 'api-retry', task: 'Add retry to the API client', repos: ['api'] }

async function spawn(rig: EngineRig, repos: string[] = ['api']): Promise<string> {
  const started = await rig.call(rig.brain(), 'spawn_worker', { ...apiWorker, repos })
  return String(started.value['workerId'])
}

describe('channel schemas', () => {
  it('sessions:plan-decision accepts the three decisions and a models map', () => {
    const schema = channelSchemas['sessions:plan-decision']
    for (const decision of ['approve', 'ask-changes', 'reject']) {
      expect(schema.safeParse({ sessionId: 's', planId: 'p', decision }).success).toBe(true)
    }
    expect(
      schema.safeParse({
        sessionId: 's',
        planId: 'p',
        decision: 'approve',
        models: { w: { provider: 'claude', model: 'opus' } }
      }).success
    ).toBe(true)
  })

  it('rejects a bad decision, an empty model, extra keys and missing ids', () => {
    const schema = channelSchemas['sessions:plan-decision']
    expect(schema.safeParse({ sessionId: 's', planId: 'p', decision: 'maybe' }).success).toBe(false)
    expect(
      schema.safeParse({
        sessionId: 's',
        planId: 'p',
        decision: 'approve',
        models: { w: { provider: 'claude', model: '' } }
      }).success
    ).toBe(false)
    expect(
      schema.safeParse({ sessionId: 's', planId: 'p', decision: 'approve', extra: 1 }).success
    ).toBe(false)
    expect(schema.safeParse({ sessionId: 's', decision: 'approve' }).success).toBe(false)
    expect(channelSchemas['workers:get'].safeParse({}).success).toBe(false)
    expect(channelSchemas['workers:stop'].safeParse({ workerId: 'w', x: 1 }).success).toBe(false)
  })
})

describe('sessions:plan-decision validation', () => {
  it('refuses an unknown model with VALIDATION_FAILED and changes nothing', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('plan_first')
    const pending = e.call(e.brain(), 'propose_plan', {
      workers: [{ ...apiWorker, rationale: 'r' }]
    })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
    const plan = e.rig.deps.plansRepo.latest(sessionId)
    expect(() =>
      e?.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve', {
        'api-retry': { provider: 'claude', model: 'gpt-9' }
      })
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(e.rig.deps.plansRepo.latest(sessionId)?.status).toBe('proposed')

    e.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve', {
      'api-retry': { provider: 'claude', model: 'opus' }
    })
    await pending
    expect(e.rig.deps.workersRepo.listBySession(sessionId)).toHaveLength(0)
  })
})

describe('workers:get', () => {
  it('returns the worker, its working copy and its committed plus uncommitted changes', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const workerId = await spawn(e)
    const tree = e.rig.deps.worktreesRepo.listByWorker(workerId)[0]
    const path = tree?.path ?? ''

    writeFileSync(join(path, 'committed.txt'), 'one\n')
    gitIn(path, 'add', 'committed.txt')
    gitIn(path, 'commit', '-m', 'Add committed file')
    writeFileSync(join(path, 'README.md'), 'changed\n')
    writeFileSync(join(path, 'new-untracked.txt'), 'two\n')

    const details = await e.rig.service.workerDetails(workerId)
    expect(details).toMatchObject({
      id: workerId,
      number: 1,
      name: 'W1 · api-retry',
      status: 'starting',
      model: 'sonnet',
      task: 'Add retry to the API client',
      lastReport: null,
      failureReason: null,
      worktreePaths: [{ projectName: 'api', path }],
      projects: ['api']
    })
    expect(details.changedFiles).toEqual(['README.md', 'committed.txt', 'new-untracked.txt'])
  })

  it('prefixes paths with the project name when the worker has several working copies', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const workerId = await spawn(e, ['api', 'web'])
    const trees = e.rig.deps.worktreesRepo.listByWorker(workerId)
    writeFileSync(join(trees[0]?.path ?? '', 'a.txt'), 'a\n')
    writeFileSync(join(trees[1]?.path ?? '', 'b.txt'), 'b\n')
    const details = await e.rig.service.workerDetails(workerId)
    expect(details.changedFiles).toEqual(['api/a.txt', 'web/b.txt'])
    expect(details.projects).toEqual(['api', 'web'])
  })

  it('fails with VALIDATION_FAILED for an unknown worker', async () => {
    e = await makeEngineRig(dir())
    await expect(e.rig.service.workerDetails('nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(e.rig.service.stopWorker('nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})

describe('workers:stop', () => {
  it('stops a running worker as the user and logs "Stopped by you"', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const workerId = await spawn(e)
    await e.rig.service.stopWorker(workerId)
    expect(e.rig.deps.workersRepo.get(workerId)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'user'
    })
    await e.rig.service.stopWorker(workerId)
    expect(
      e.rig.eventsRepo
        .latest(sessionId, 50)
        .filter((x) => x.kind === 'worker-stopped')
        .map((x) => x.text)
    ).toEqual(['Stopped by you; working copy removed'])
    expect((await e.rig.service.workerDetails(workerId)).status).toBe('stopped')
  })
})

describe('push throttling', () => {
  it('sends a worker at most once per 250 ms and the latest state last', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const workerId = await spawn(e)
    const worker = e.workerHandle()
    await until(() => (e?.rig.of('session:worker-changed').length ?? 0) > 0)
    await new Promise((r) => setTimeout(r, 300))
    // Timers are faked only now; the bridge keeps using real sockets.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rig = e.rig
    rig.pushed.length = 0
    const progress = async (note: string): Promise<void> => {
      await e?.call(worker, 'report_progress', { note })
    }
    rig.clock.now += 10_000
    await progress('step 1')
    const first = rig.of('session:worker-changed').length
    for (const n of [2, 3, 4]) {
      rig.clock.now += 20
      await progress(`step ${n}`)
    }
    // Inside the window nothing more went out.
    expect(rig.of('session:worker-changed').length).toBe(first)
    rig.clock.now += WORKER_PUSH_MS
    vi.advanceTimersByTime(WORKER_PUSH_MS)
    const pushes = rig.of('session:worker-changed')
    expect(pushes.length).toBe(first + 1)
    expect(pushes.at(-1)?.worker).toMatchObject({ id: workerId })
  })

  it('batches event-log rows into one push per 100 ms', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    // Let the rows logged while starting flush on the real timer first.
    await new Promise((r) => setTimeout(r, 200))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rig = e.rig
    rig.pushed.length = 0
    rig.service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'opus' } })
    rig.service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'haiku' } })
    expect(rig.of('session:event-logged')).toHaveLength(0)
    vi.advanceTimersByTime(99)
    expect(rig.of('session:event-logged')).toHaveLength(0)
    vi.advanceTimersByTime(1)
    const batches = rig.of('session:event-logged')
    expect(batches).toHaveLength(1)
    expect(batches[0]?.entries.map((x) => x.text)).toEqual([
      'Brain model set to Claude · Opus',
      'Brain model set to Claude · Haiku'
    ])
  })
})
