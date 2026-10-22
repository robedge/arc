import { afterEach, describe, expect, it } from 'vitest'
import type { WorkerView } from '../../../src/shared/types/session'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { HELPER_CAP_MS, capText } from '../../../src/main/sessions/worker-manager'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-helpers-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const AGENT_CALL = 'toolu_agent_1'

interface Started {
  rig: EngineRig
  workerId: string
  worker: FakeHandle
  sessionId: string
}

async function startWorker(helperCapMs?: number, helperSettleMs?: number): Promise<Started> {
  e = await makeEngineRig(dir(), {
    timings: {
      ...(helperCapMs === undefined ? {} : { helperCapMs }),
      ...(helperSettleMs === undefined ? {} : { helperSettleMs })
    }
  })
  const sessionId = await e.startSession('autonomous')
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'docs-pass',
    task: 'Write the docs',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  const worker = e.workerHandle()
  worker.emit({ type: 'session', providerSessionId: 'w1', model: 'sonnet', mcpServers: [] })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { rig: e, workerId, worker, sessionId }
}

const startHelpers = (s: Started, count: number): void => {
  const tasks = Array.from({ length: count }, (_, i) => ({
    taskId: `task${i + 1}`,
    description: `Helper ${i + 1}`
  }))
  s.worker.emit({ type: 'tasks-changed', running: count, tasks })
  s.worker.emit({
    type: 'task-started',
    taskId: 'task1',
    toolUseId: AGENT_CALL,
    description: 'Helper 1',
    backgrounded: true
  })
}

const endHelpers = (s: Started): void => {
  s.worker.emit({ type: 'task-ended', taskId: 'task1', status: 'completed' })
  s.worker.emit({ type: 'tasks-changed', running: 0, tasks: [] })
}

const result = (s: Started): void =>
  s.worker.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })

const row = (s: Started) => s.rig.rig.deps.workersRepo.get(s.workerId)
const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms))
const latestView = (s: Started): WorkerView | undefined =>
  s.rig.rig
    .of('session:worker-changed')
    .filter((p) => p.worker.id === s.workerId)
    .at(-1)?.worker

describe('background helpers: the first turn ending is not the worker ending', () => {
  it('does not nudge, stop or finish the worker on a result while helpers run', async () => {
    const s = await startWorker()
    startHelpers(s, 2)
    result(s)
    await settle()
    expect(s.worker.sent).toHaveLength(1)
    expect(s.worker.stopped).toBe(false)
    expect(row(s)?.status).toBe('working')
    expect(row(s)?.failureReason).toBeNull()
  })

  it('judges the follow-up turn after the helpers end as it does any turn (here: the nudge)', async () => {
    const s = await startWorker()
    startHelpers(s, 1)
    result(s)
    await settle()
    endHelpers(s)
    result(s)
    await until(() => s.worker.sent.length === 2)
    expect(s.worker.sent[1]).toContain('report_done')
  })

  it('finishes as Done after the helpers end, report_done and the second result', async () => {
    const s = await startWorker()
    startHelpers(s, 1)
    result(s)
    await settle()
    expect(row(s)?.status).toBe('working')
    endHelpers(s)
    await s.rig.call(s.worker, 'report_done', { summary: 'Docs written' })
    result(s)
    await until(() => row(s)?.status === 'done')
    expect(s.worker.stopped).toBe(true)
  })

  it('defers the stop of a report_done made while helpers run until they end and the next turn ends', async () => {
    const s = await startWorker()
    startHelpers(s, 1)
    await s.rig.call(s.worker, 'report_done', { summary: 'Docs written' })
    result(s)
    await settle()
    expect(s.worker.stopped).toBe(false)
    expect(row(s)?.status).toBe('working')

    endHelpers(s)
    await settle(60)
    expect(s.worker.stopped).toBe(false)
    result(s)
    await until(() => row(s)?.status === 'done')
    expect(s.worker.stopped).toBe(true)
  })

  it('stops waiting after the safety cap, logs it, and proceeds as it would without helpers', async () => {
    const s = await startWorker(1000)
    startHelpers(s, 1)
    await s.rig.call(s.worker, 'report_done', { summary: 'Docs written' })
    result(s)
    await settle(60)
    expect(s.worker.stopped).toBe(false)
    await until(() => s.worker.stopped)
    await until(() => row(s)?.status === 'done')
    const texts = s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)
    expect(texts).toContain('Helpers still running after 1 second; stopping W1')
  })

  it('settles a deferred report_done after the grace period when no follow-up turn starts', async () => {
    const s = await startWorker(undefined, 300)
    startHelpers(s, 1)
    await s.rig.call(s.worker, 'report_done', { summary: 'Docs written' })
    result(s)
    await settle(60)
    endHelpers(s)
    await settle(100)
    expect(s.worker.stopped).toBe(false)
    await until(() => s.worker.stopped)
    await until(() => row(s)?.status === 'done')
    const texts = s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)
    expect(texts.some((t) => t.includes('no follow-up turn within'))).toBe(true)
  })

  it('cancels the grace timer when the follow-up turn starts, and handles that turn normally', async () => {
    const s = await startWorker(undefined, 300)
    startHelpers(s, 1)
    await s.rig.call(s.worker, 'report_done', { summary: 'Docs written' })
    result(s)
    await settle(60)
    endHelpers(s)
    s.worker.emit({ type: 'assistant-message', messageId: 'm2', text: 'Both helpers finished.' })
    await settle(500)
    expect(s.worker.stopped).toBe(false)
    expect(row(s)?.status).toBe('working')
    result(s)
    await until(() => row(s)?.status === 'done')
    const texts = s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)
    expect(texts.some((t) => t.includes('no follow-up turn within'))).toBe(false)
  })

  it('uses a 10 minute cap by default, worded as the event text says', () => {
    expect(HELPER_CAP_MS).toBe(600_000)
    expect(`Helpers still running after ${capText(HELPER_CAP_MS)}; stopping W2`).toBe(
      'Helpers still running after 10 minutes; stopping W2'
    )
  })
})

describe('background helpers: what the card and the terminal show', () => {
  it('reports helpersRunning in the view and the activity as "Working (2 helpers)"', async () => {
    const s = await startWorker()
    startHelpers(s, 2)
    await until(() => latestView(s)?.helpersRunning === 2)
    expect(latestView(s)?.activity).toBe('Working (2 helpers)')
    expect(s.rig.rig.service.snapshot(s.sessionId).workers[0]?.helpersRunning).toBe(2)

    s.worker.emit({
      type: 'tasks-changed',
      running: 1,
      tasks: [{ taskId: 'task2', description: 'B' }]
    })
    await until(() => latestView(s)?.helpersRunning === 1)
    expect(latestView(s)?.activity).toBe('Working (1 helper)')

    endHelpers(s)
    await until(() => latestView(s)?.helpersRunning === 0)
    expect(latestView(s)?.activity).toBe('Working')
  })

  it('keeps the note in the activity line: "<note> (1 helper)"', async () => {
    const s = await startWorker()
    await s.rig.call(s.worker, 'report_progress', { note: 'Reading the sync module' })
    startHelpers(s, 1)
    await until(() => latestView(s)?.helpersRunning === 1)
    expect(latestView(s)?.activity).toBe('Reading the sync module (1 helper)')
  })

  it('keeps helpersRunning after an interrupt cancels the turn', async () => {
    const s = await startWorker()
    startHelpers(s, 1)
    await until(() => latestView(s)?.helpersRunning === 1)
    s.worker.emit({ type: 'turn-result', ok: false, interrupted: true, durationMs: 1 })
    await settle()
    expect(latestView(s)?.helpersRunning).toBe(1)
    expect(s.worker.stopped).toBe(false)
    expect(row(s)?.status).toBe('working')
  })

  it('writes helper lines to the worker terminal', async () => {
    const s = await startWorker()
    startHelpers(s, 1)
    s.worker.emit({
      type: 'tool-use',
      toolUseId: 'h-bash',
      name: 'Bash',
      summary: 'Bash: ls',
      parentToolUseId: AGENT_CALL
    })
    s.worker.emit({
      type: 'assistant-message',
      messageId: 'hm',
      text: 'Found two files.',
      parentToolUseId: AGENT_CALL
    })
    endHelpers(s)
    const text = async (): Promise<string> =>
      (await s.rig.rig.service.openTerminal(s.workerId)).backlog
    await settle(150)
    const out = await text()
    expect(out).toContain('  ↳ helper (Helper 1): started\n')
    expect(out).toContain('  ↳ helper (Helper 1): ▸ Bash  ls\n')
    expect(out).toContain('  ↳ helper (Helper 1): Found two files.\n')
    expect(out).toContain('  ↳ helper (Helper 1): finished (completed)\n')
  })

  it('labels a permission request from a helper "(helper)" and not one from the worker', async () => {
    const s = await startWorker()
    startHelpers(s, 1)
    s.worker.emit({
      type: 'tool-use',
      toolUseId: 'h-push',
      name: 'Bash',
      summary: 'Bash: git push origin x',
      parentToolUseId: AGENT_CALL
    })
    s.worker.emit({
      type: 'tool-use',
      toolUseId: 'w-push',
      name: 'Bash',
      summary: 'Bash: git push origin y'
    })
    await settle(60)
    const ask = (id: string, command: string) =>
      s.rig.call(s.worker, 'request_permission', {
        tool_name: 'Bash',
        input: { command, description: 'x' },
        tool_use_id: id
      })
    void ask('h-push', 'git push origin x')
    void ask('w-push', 'git push origin y')
    await until(() => s.rig.rig.deps.attentionRepo.listPending(s.sessionId).length === 2)
    const rows = s.rig.rig.deps.attentionRepo.listPending(s.sessionId)
    expect(rows.find((r) => r.toolUseId === 'h-push')?.action).toBe('(helper) git push origin x')
    expect(rows.find((r) => r.toolUseId === 'w-push')?.action).toBe('git push origin y')
  })
})
