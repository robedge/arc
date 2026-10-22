import { afterEach, describe, expect, it } from 'vitest'
import { buildBrainPrompt, modeNote } from '../../../src/main/sessions/orchestrator'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-limit-')
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

function statusOf(rig: EngineRig, workerId: string): string | undefined {
  return rig.rig.deps.workersRepo.get(workerId)?.status
}

async function spawn(rig: EngineRig, name: string): Promise<{ id: string; status: string }> {
  const result = await rig.call(rig.brain(), 'spawn_worker', named(name))
  expect(result.isError).toBe(false)
  return { id: String(result.value['workerId']), status: String(result.value['status']) }
}

/** Plays the CLI of a started worker: reports done and ends the turn, so it exits as done. */
async function finish(rig: EngineRig, index: number, workerId: string): Promise<void> {
  const handle = rig.workerHandle(index)
  await rig.call(handle, 'report_done', { summary: 'ok' })
  handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await until(() => statusOf(rig, workerId) === 'done')
}

const eventTexts = (rig: EngineRig, sessionId: string): string[] =>
  rig.rig.eventsRepo.latest(sessionId, 100).map((x) => x.text)

describe('worker limit and queue', () => {
  it('queues the third worker at limit 2 and starts it when one finishes', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    e.rig.service.setConfig(sessionId, { workerLimit: 2 })

    const w1 = await spawn(e, 'one')
    const w2 = await spawn(e, 'two')
    const w3 = await spawn(e, 'three')
    expect([w1.status, w2.status, w3.status]).toEqual(['started', 'started', 'queued'])

    const queued = e.rig.deps.workersRepo.get(w3.id)
    expect(queued).toMatchObject({ number: 3, status: 'queued', activity: 'Queued' })
    expect(e.rig.deps.worktreesRepo.listByWorker(w3.id)).toHaveLength(0)
    expect(e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(2)
    expect(eventTexts(e, sessionId)).toContain('W3 three queued (limit 2)')

    await finish(e, 0, w1.id)
    await until(
      () => e?.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-')).length === 3
    )
    expect(['starting', 'working']).toContain(statusOf(e, w3.id))
    expect(e.rig.deps.worktreesRepo.listByWorker(w3.id)).toHaveLength(1)
    expect(eventTexts(e, sessionId)).toContain('started W3 three · Claude · Sonnet')
    expect(e.rig.deps.workersRepo.countActive(sessionId)).toBe(2)
    expect(e.rig.of('session:worker-changed').some((p) => p.worker.status === 'queued')).toBe(true)
  })

  it('starts queued workers in order when the limit is raised', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    await spawn(e, 'one')
    const w2 = await spawn(e, 'two')
    const w3 = await spawn(e, 'three')
    const w4 = await spawn(e, 'four')
    expect([w2.status, w3.status, w4.status]).toEqual(['queued', 'queued', 'queued'])

    e.rig.service.setConfig(sessionId, { workerLimit: 3 })
    await until(() => e?.rig.deps.workersRepo.countActive(sessionId) === 3)
    expect(statusOf(e, w2.id)).not.toBe('queued')
    expect(statusOf(e, w3.id)).not.toBe('queued')
    expect(statusOf(e, w4.id)).toBe('queued')
  })

  it('never stops running workers when the limit is lowered, and holds the queue until there is room', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const w1 = await spawn(e, 'one')
    const w2 = await spawn(e, 'two')
    const w3 = await spawn(e, 'three')
    e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    expect(e.rig.adapter.handles.filter((h) => h.stopped)).toHaveLength(0)
    expect(e.rig.deps.workersRepo.countActive(sessionId)).toBe(3)

    const w4 = await spawn(e, 'four')
    expect(w4.status).toBe('queued')
    await finish(e, 0, w1.id)
    await finish(e, 1, w2.id)
    // One worker still runs, which is at the limit of 1.
    expect(statusOf(e, w4.id)).toBe('queued')
    await finish(e, 2, w3.id)
    const rig = e
    await until(() => statusOf(rig, w4.id) !== 'queued')
  })

  it('applies a mode switch to the next spawn_worker only, and tells the running brain', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const w1 = await spawn(e, 'one')

    e.rig.service.setConfig(sessionId, { mode: 'plan_first' })
    expect(statusOf(e, w1.id)).toBe('starting')
    const refused = await e.call(e.brain(), 'spawn_worker', named('two'))
    expect(refused.value['error']).toBe('plan_not_approved')
    expect(e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(1)

    e.rig.service.setConfig(sessionId, { mode: 'autonomous', workerLimit: 4 })
    const ok = await spawn(e, 'two')
    expect(ok.status).toBe('started')

    // The note goes in front of the next message to the brain, once.
    const brain = e.brain()
    expect(brain.sent.some((t) => t.includes('Mode is now'))).toBe(false)
    await e.rig.service.sendMessage(sessionId, 'How is it going?')
    await until(() => brain.sent.length > 1)
    expect(brain.sent.at(-1)).toBe(`${modeNote('autonomous', 4)}\n\nHow is it going?`)
    await e.rig.service.sendMessage(sessionId, 'And now?')
    await until(() => brain.sent.length > 2)
    expect(brain.sent.at(-1)).toBe('And now?')
    expect(eventTexts(e, sessionId)).toContain('Mode is now Autonomous, limit 4.')
  })

  it('queues the extras of an approved plan when it lists more workers than the limit', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('plan_first')
    e.rig.service.setConfig(sessionId, { workerLimit: 2 })
    const workers = ['one', 'two', 'three'].map((name) => ({
      ...named(name),
      rationale: 'Needed.'
    }))
    const pending = e.call(e.brain(), 'propose_plan', { workers })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
    e.rig.service.decidePlan(sessionId, e.rig.deps.plansRepo.latest(sessionId)?.id ?? '', 'approve')
    await pending

    const results = []
    for (const name of ['one', 'two', 'three']) results.push(await spawn(e, name))
    expect(results.map((r) => r.status)).toEqual(['started', 'started', 'queued'])
    const third = e.rig.deps.workersRepo.get(results[2]?.id ?? '')
    expect(third?.planId).toBe(e.rig.deps.plansRepo.latest(sessionId)?.id)
  })

  it('removes a stopped queued worker from the queue without starting it', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    const w1 = await spawn(e, 'one')
    const w2 = await spawn(e, 'two')
    expect(w2.status).toBe('queued')
    await e.rig.service.stopWorker(w2.id)
    expect(e.rig.deps.workersRepo.get(w2.id)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'user'
    })

    await finish(e, 0, w1.id)
    expect(statusOf(e, w2.id)).toBe('stopped')
    expect(e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(1)
  })
})

describe('brain prompt', () => {
  const base = { groupName: 'G', knowledgePath: '/k', projects: [], workersEnabled: true }

  it('states the mode and the limit', () => {
    const auto = buildBrainPrompt({ ...base, mode: 'autonomous', workerLimit: 3 })
    expect(auto).toContain('Current mode: Autonomous (worker limit 3)')
    expect(auto).toContain('do not call propose_plan first')
    const plan = buildBrainPrompt({ ...base, mode: 'plan_first', workerLimit: 1 })
    expect(plan).toContain('Current mode: Plan-first (worker limit 1)')
    expect(plan).toContain('At most 1 worker run at once')
  })
})
