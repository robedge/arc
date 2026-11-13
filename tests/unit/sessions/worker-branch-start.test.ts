// @spec: 013-session-branches-on-demand
// @regression
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { trackedFile } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-worker-branch-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const spawnArgs = (name: string, repos: string[]): Record<string, unknown> => ({
  name,
  task: `Do ${name}`,
  repos,
  model: 'sonnet'
})

/** The branch a repository's checkout is on, and whether any `arc/` branch exists there. */
function state(path: string): { current: string; arcBranches: string } {
  return {
    current: gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD'),
    arcBranches: gitIn(path, 'branch', '--list', 'arc/*')
  }
}

function branchRows(rig: EngineRig, sessionId: string): Record<string, string | null> {
  return Object.fromEntries(
    rig.rig.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter((p) => p.projectName === 'api' || p.projectName === 'web')
      .map((p) => [p.projectName, p.branchName])
  )
}

describe('a worker start creates the session branch where it works', () => {
  it('a new session has no branch anywhere until a brain spawn, then only in the worker project', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('autonomous')
    expect(branchRows(e, id)).toEqual({ api: null, web: null })
    expect(state(e.api.path).arcBranches).toBe('')

    const result = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
    expect(result).toMatchObject({ isError: false, value: { status: 'started' } })

    const rows = branchRows(e, id)
    expect(rows['api']).toMatch(/^arc\//)
    expect(rows['web']).toBeNull()
    expect(state(e.api.path).current).toBe(rows['api'])
    expect(state(e.web.path)).toEqual({ current: 'dev', arcBranches: '' })
    const workerId = String(result.value['workerId'])
    expect(e.rig.deps.worktreesRepo.listByWorker(workerId)).toHaveLength(1)
    expect(e.workerHandle()).toBeDefined()
  })

  it('a command worker creates the branch only in its own project', async () => {
    e = await makeEngineRig(dir(), {
      commands: {
        list: () =>
          Promise.resolve([
            {
              id: 'claude:awos:spec',
              provider: 'claude',
              kind: 'command',
              name: 'awos:spec',
              description: 'Spec',
              source: 'plugin:awos'
            }
          ])
      }
    })
    const id = await e.startSession('autonomous')
    const result = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs('spec', ['web']),
      command: '/awos:spec retry'
    })
    expect(result).toMatchObject({ isError: false, value: { status: 'started' } })
    const rows = branchRows(e, id)
    expect(rows['web']).toMatch(/^arc\//)
    expect(rows['api']).toBeNull()
    expect(state(e.api.path)).toEqual({ current: 'dev', arcBranches: '' })
  })

  it('a plan-approved worker creates the branch only in its own project', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('plan_first')
    const planned = { name: 'web-fix', task: 'Do web-fix', repos: ['web'], rationale: '' }
    const pending = e.call(e.brain(), 'propose_plan', { workers: [planned] })
    await until(() => e?.rig.deps.plansRepo.latest(id)?.status === 'proposed')
    // Approving a plan starts nothing and creates no branch.
    e.rig.service.decidePlan(id, e.rig.deps.plansRepo.latest(id)?.id ?? '', 'approve')
    await pending
    expect(branchRows(e, id)).toEqual({ api: null, web: null })

    const result = await e.call(e.brain(), 'spawn_worker', spawnArgs('web-fix', ['web']))
    expect(result).toMatchObject({ isError: false, value: { status: 'started' } })
    const rows = branchRows(e, id)
    expect(rows['web']).toMatch(/^arc\//)
    expect(rows['api']).toBeNull()
    expect(state(e.api.path)).toEqual({ current: 'dev', arcBranches: '' })
  })

  it('a queued worker started by drain creates the branch only in its own projects, after the limit holds', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('autonomous')
    e.rig.service.setConfig(id, { workerLimit: 1 })
    const first = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-one', ['api']))
    const second = await e.call(e.brain(), 'spawn_worker', spawnArgs('web-two', ['web']))
    expect(second.value['status']).toBe('queued')
    // A held worker never creates a branch.
    expect(branchRows(e, id)['web']).toBeNull()
    expect(state(e.web.path)).toEqual({ current: 'dev', arcBranches: '' })

    const handle = e.workerHandle(0)
    await e.call(handle, 'report_done', { summary: 'ok' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    const secondId = String(second.value['workerId'])
    await until(() => e?.rig.deps.worktreesRepo.listByWorker(secondId).length === 1)

    const rows = branchRows(e, id)
    expect(rows['web']).toMatch(/^arc\//)
    expect(rows['api']).toBe(branchRows(e, id)['api'])
    expect(rows['web']).toBe(rows['api'])
    expect(state(e.web.path).current).toBe(rows['web'])
    expect(String(first.value['workerId'])).not.toBe(secondId)
  })

  it('keeps the worker queued, changes nothing and opens a question when the repository has unsaved changes', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('autonomous')
    writeFileSync(join(e.api.path, trackedFile), 'changed\n')
    const result = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
    expect(result).toMatchObject({ isError: false, value: { status: 'queued' } })
    const worker = e.rig.deps.workersRepo.listBySession(id)[0]
    expect(worker).toMatchObject({ status: 'queued' })
    expect(e.rig.deps.worktreesRepo.listByWorker(String(worker?.id))).toHaveLength(0)
    expect(branchRows(e, id)['api']).toBeNull()
    expect(state(e.api.path).arcBranches).toBe('')
    expect(readFileSync(join(e.api.path, trackedFile), 'utf8')).toBe('changed\n')
    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(1)
  })
  it('tells the brain which repository the worker waits on, and says so on the card', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('autonomous')
    writeFileSync(join(e.api.path, trackedFile), 'changed\n')
    const result = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
    expect(result.value['note']).toBe(
      "Waiting for the user's choice about unsaved changes in api. Do not spawn it again; Arc sends a message when it starts or is not started."
    )
    const worker = e.rig.deps.workersRepo.listBySession(id)[0]
    expect(worker?.activity).toBe('Waiting for your choice about unsaved changes in api')
    const queuedEvents = e.rig.deps.eventsRepo
      .latest(id, 50)
      .filter((ev) => ev.kind === 'worker-queued')
    expect(queuedEvents.map((ev) => ev.text)).toEqual([
      'W1 api-fix queued: Waiting for your choice about unsaved changes in api'
    ])
  })

  it('uses no slot while waiting, and a clean worker starts while another waits', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('autonomous')
    e.rig.service.setConfig(id, { workerLimit: 1 })
    writeFileSync(join(e.api.path, trackedFile), 'changed\n')
    const waiting = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
    expect(waiting.value['status']).toBe('queued')
    expect(e.rig.deps.workersRepo.countActive(id)).toBe(0)

    const clean = await e.call(e.brain(), 'spawn_worker', spawnArgs('web-fix', ['web']))

    expect(clean).toMatchObject({ isError: false, value: { status: 'started' } })
    expect(e.rig.deps.workersRepo.get(String(waiting.value['workerId']))?.status).toBe('queued')
    expect(branchRows(e, id)['web']).toMatch(/^arc\//)
    expect(branchRows(e, id)['api']).toBeNull()
    // The limit is full now, yet the waiting worker did not take the place of anyone.
    expect(e.rig.deps.workersRepo.countActive(id)).toBe(1)
  })

  it('does not let the brain spawn a waiting worker of an approved plan a second time', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('plan_first')
    const planned = { name: 'api-fix', task: 'Do api-fix', repos: ['api'], rationale: '' }
    const pending = e.call(e.brain(), 'propose_plan', { workers: [planned] })
    await until(() => e?.rig.deps.plansRepo.latest(id)?.status === 'proposed')
    e.rig.service.decidePlan(id, e.rig.deps.plansRepo.latest(id)?.id ?? '', 'approve')
    await pending
    writeFileSync(join(e.api.path, trackedFile), 'changed\n')

    const first = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
    expect(first.value['status']).toBe('queued')
    const again = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))

    expect(again.isError).toBe(true)
    expect(e.rig.deps.workersRepo.listBySession(id)).toHaveLength(1)
  })

  it('holds a worker behind the limit and a branch wait together, then starts it with the branch in place', async () => {
    e = await makeEngineRig(dir())
    const id = await e.startSession('autonomous')
    e.rig.service.setConfig(id, { workerLimit: 1 })
    writeFileSync(join(e.web.path, trackedFile), 'changed\n')
    // web-a waits for the user, so api-one still gets the only slot.
    const a = await e.call(e.brain(), 'spawn_worker', spawnArgs('web-a', ['web']))
    const one = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-one', ['api']))
    expect(a.value['status']).toBe('queued')
    expect(one.value['status']).toBe('started')
    // web-b is held by the limit; it has not asked anything yet.
    const b = await e.call(e.brain(), 'spawn_worker', spawnArgs('web-b', ['web']))
    expect(b.value['status']).toBe('queued')
    const aId = String(a.value['workerId'])
    const bId = String(b.value['workerId'])
    const question = e.rig.deps.branchQuestionsRepo.listPending(id)[0]
    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(1)
    expect(e.rig.deps.workersRepo.get(bId)?.activity).toBe(
      'Waiting for your choice about unsaved changes in web'
    )

    // The answer gives web its branch for both; the limit still holds them.
    await e.rig.service.branchOnDemand.answer(String(question?.id), 'stash')
    expect(branchRows(e, id)['web']).toMatch(/^arc\//)
    expect(e.rig.deps.workersRepo.get(aId)?.status).toBe('queued')
    expect(e.rig.deps.workersRepo.get(bId)?.status).toBe('queued')
    expect(e.rig.deps.workersRepo.get(bId)?.activity).toBe('Queued')
    expect(e.rig.deps.worktreesRepo.listByWorker(aId)).toHaveLength(0)

    // A slot frees: web-a starts later from drain with the branch already there.
    const handle = e.workerHandle(0)
    await e.call(handle, 'report_done', { summary: 'ok' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => e?.rig.deps.worktreesRepo.listByWorker(aId).length === 1)
    expect(e.rig.deps.workersRepo.get(bId)?.status).toBe('queued')
    await until(() => e?.brain().sent.some((m) => m.includes('web-a has started')) === true)
    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(0)
  })
})

describe('a question nobody waits on, and "Don\'t start"', () => {
  /** A session with unsaved changes in api and one worker waiting for the user's answer about them. */
  async function waiting(rig: EngineRig): Promise<{ id: string; workerId: string }> {
    const id = await rig.startSession('autonomous')
    writeFileSync(join(rig.api.path, trackedFile), 'changed\n')
    const result = await rig.call(rig.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
    expect(result.value['status']).toBe('queued')
    expect(rig.rig.deps.branchQuestionsRepo.countPending(id)).toBe(1)
    return { id, workerId: String(result.value['workerId']) }
  }

  it('fails the worker with the reason, tells the brain and leaves the repository as it was', async () => {
    e = await makeEngineRig(dir())
    const { id, workerId } = await waiting(e)
    const question = e.rig.deps.branchQuestionsRepo.listPending(id)[0]

    const result = await e.rig.service.answerBranchQuestion(String(question?.id), 'skip')

    expect(result).toEqual({ status: 'ok' })
    const row = e.rig.deps.workersRepo.get(workerId)
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toBe('Not started: you chose to leave api as it is')
    // The worker card carries the same reason.
    const card = e.rig.of('session:worker-changed').find((x) => x.worker.id === workerId)
    expect(card).toBeDefined()
    expect(e.rig.of('session:worker-changed').at(-1)?.worker).toMatchObject({
      id: workerId,
      status: 'failed',
      failureReason: 'Not started: you chose to leave api as it is'
    })
    await until(
      () => e?.brain().sent.some((m) => m.includes('chose not to start work in api')) === true
    )
    expect(e.brain().sent.filter((m) => m.includes('chose not to start work in api'))).toEqual([
      '[Arc] The user chose not to start work in api (unsaved changes). Not started: W1 api-fix. Nothing was changed in api. Tell the user or change your approach.'
    ])
    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(0)
    expect(state(e.api.path)).toEqual({ current: 'dev', arcBranches: '' })
    expect(readFileSync(join(e.api.path, trackedFile), 'utf8')).toBe('changed\n')
    expect(branchRows(e, id)['api']).toBeNull()
  })

  it('asks again when the brain later starts another worker in the same dirty project', async () => {
    e = await makeEngineRig(dir())
    const { id } = await waiting(e)
    const question = e.rig.deps.branchQuestionsRepo.listPending(id)[0]
    await e.rig.service.answerBranchQuestion(String(question?.id), 'skip')

    const again = await e.call(e.brain(), 'spawn_worker', spawnArgs('api-retry', ['api']))

    expect(again.value['status']).toBe('queued')
    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(1)
  })

  it('closes the card when the only waiting worker is stopped', async () => {
    e = await makeEngineRig(dir())
    const { id, workerId } = await waiting(e)

    await e.rig.service.stopWorker(workerId)

    expect(e.rig.deps.workersRepo.get(workerId)?.status).toBe('stopped')
    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(0)
    expect(state(e.api.path)).toEqual({ current: 'dev', arcBranches: '' })
  })

  it('keeps the card while another worker still waits after one is stopped', async () => {
    e = await makeEngineRig(dir())
    const { id, workerId } = await waiting(e)
    await e.call(e.brain(), 'spawn_worker', spawnArgs('api-docs', ['api']))

    await e.rig.service.stopWorker(workerId)

    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(1)
  })

  it('closes the card of a project that left the group', async () => {
    e = await makeEngineRig(dir())
    const { id } = await waiting(e)
    const projects = new ProjectsRepo(e.rig.opened.db)
    projects.removeMembership(e.rig.groupId, 'p-api')
    projects.deleteIfOrphan('p-api')

    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })

    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(0)
  })

  it('closes a card whose workers are gone when the session is opened', async () => {
    e = await makeEngineRig(dir())
    const { id, workerId } = await waiting(e)
    // The worker ended while the session was closed.
    e.rig.deps.workersRepo.setStatus(workerId, 'stopped', 5, 'user')

    await e.rig.service.open(id)

    expect(e.rig.deps.branchQuestionsRepo.countPending(id)).toBe(0)
  })
})
