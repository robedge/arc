import { afterEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { HAND_BACK_TEXT } from '../../../src/main/sessions/worker-manager'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-control-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

interface Started {
  rig: EngineRig
  workerId: string
  worker: FakeHandle
  sessionId: string
}

async function startWorker(timings: { helperSettleMs?: number } = {}): Promise<Started> {
  e = await makeEngineRig(dir(), { timings })
  const sessionId = await e.startSession('autonomous')
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'api-retry',
    task: 'Add retries',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  const worker = e.workerHandle()
  worker.emit({ type: 'session', providerSessionId: 'w1', model: 'sonnet', mcpServers: [] })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { rig: e, workerId, worker, sessionId }
}

const row = (s: Started) => s.rig.rig.deps.workersRepo.get(s.workerId)
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))
const result = (s: Started, interrupted = false): void =>
  s.worker.emit({ type: 'turn-result', ok: !interrupted, interrupted, durationMs: 1 })
const stepIn = (s: Started): Promise<void> => s.rig.rig.service.stepInWorker(s.workerId)
const terminal = async (s: Started): Promise<string> =>
  (await s.rig.rig.service.openTerminal(s.workerId)).backlog
const terminalHas = async (s: Started, text: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if ((await terminal(s)).includes(text)) return
    await settle(20)
  }
  throw new Error(`the terminal never showed "${text}"`)
}
const events = (s: Started): string[] =>
  s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)
const lastView = (s: Started) =>
  s.rig.rig
    .of('session:worker-changed')
    .filter((p) => p.worker.id === s.workerId)
    .at(-1)?.worker

describe('step-in eligibility', () => {
  it('refuses queued and finished workers, allows a live status once', async () => {
    const s = await startWorker()
    const repo = s.rig.rig.deps.workersRepo
    for (const status of ['queued', 'done', 'merged', 'failed', 'stopped'] as const) {
      repo.setStatus(s.workerId, status, 5)
      await expect(stepIn(s)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect(row(s)?.userControl).toBeNull()
    repo.setStatus(s.workerId, 'needs_approval', 5)
    await stepIn(s)
    expect(row(s)?.userControl).toBe('active')
    expect(row(s)?.status).toBe('needs_approval')
    await expect(stepIn(s)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('refuses an unknown worker', async () => {
    const s = await startWorker()
    await expect(s.rig.rig.service.stepInWorker('nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})

describe('stepping in', () => {
  it('stores control and the base of every working copy before the interrupt is sent', async () => {
    const s = await startWorker()
    const seen: { control: unknown; bases: number } = { control: undefined, bases: -1 }
    const original = s.worker.interrupt.bind(s.worker)
    s.worker.interrupt = () => {
      seen.control = row(s)?.userControl
      seen.bases = s.rig.rig.deps.worktreesRepo.listControlBases(s.workerId).length
      return original()
    }
    await stepIn(s)
    expect(seen).toEqual({ control: 'active', bases: 1 })
    expect(s.worker.interrupts).toBe(1)
  })

  it('logs the event, writes the terminal line, tells the brain and pushes userControl', async () => {
    const s = await startWorker()
    await stepIn(s)
    expect(events(s)).toContain('You stepped in on W1 api-retry')
    await terminalHas(s, 'You stepped in')
    await until(
      () => e?.brain().sent.some((t) => t.includes('stepped in on W1 api-retry')) === true
    )
    expect(lastView(s)).toMatchObject({ userControl: 'active', controlReplying: false })
    expect(row(s)?.controlStartedAt).not.toBeNull()
  })

  it('stores paused when the interrupt kills the process', async () => {
    const s = await startWorker()
    s.worker.interruptOutcome = 'killed'
    await stepIn(s)
    expect(row(s)?.userControl).toBe('paused')
    expect(row(s)?.status).toBe('working')
  })
})

describe('while the user is in control', () => {
  it('a late finished or interrupted turn causes no nudge, failure or stop', async () => {
    const s = await startWorker()
    await stepIn(s)
    result(s, true)
    result(s)
    result(s)
    await settle()
    expect(s.worker.sent).toHaveLength(1)
    expect(s.worker.stopped).toBe(false)
    expect(row(s)).toMatchObject({ status: 'working', failureReason: null })
  })

  it('does not stop a worker that reported done, until control ends', async () => {
    const s = await startWorker()
    await s.rig.call(s.worker, 'report_done', { summary: 'Done' })
    await stepIn(s)
    result(s)
    await settle()
    expect(s.worker.stopped).toBe(false)
  })

  it('a helper settle timer that was running at step-in settles nothing', async () => {
    const s = await startWorker({ helperSettleMs: 100 })
    s.worker.emit({
      type: 'tasks-changed',
      running: 1,
      tasks: [{ taskId: 't1', description: 'Helper' }]
    })
    result(s)
    await settle(40)
    s.worker.emit({ type: 'tasks-changed', running: 0, tasks: [] })
    await settle(20)
    await stepIn(s)
    await settle(300)
    expect(s.worker.sent).toHaveLength(1)
    expect(s.worker.stopped).toBe(false)
    expect(row(s)?.failureReason).toBeNull()
  })

  it('a process that ends is stored as paused, not failed', async () => {
    const s = await startWorker()
    await stepIn(s)
    s.worker.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })
    s.worker.queue.close()
    await until(() => row(s)?.userControl === 'paused')
    expect(row(s)).toMatchObject({ status: 'working', failureReason: null })
  })
})

describe('typing to the worker', () => {
  it('sends the line verbatim, counts it and echoes it in the terminal', async () => {
    const s = await startWorker()
    await stepIn(s)
    await s.rig.rig.service.sendWorkerInput(s.workerId, '/awos:spec x')
    expect(s.worker.sent.at(-1)).toBe('/awos:spec x')
    expect(row(s)).toMatchObject({ controlUserMessages: 1, controlLastMessage: '/awos:spec x' })
    await terminalHas(s, '> /awos:spec x')
    expect(lastView(s)?.controlReplying).toBe(true)
    result(s)
    await until(() => lastView(s)?.controlReplying === false)
    expect(s.worker.sent).toHaveLength(2)
  })

  it('refuses input when the user is not in control', async () => {
    const s = await startWorker()
    await expect(s.rig.rig.service.sendWorkerInput(s.workerId, 'hi')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })

  it('Escape interrupts the reply, logs it, and leaves the worker controlled', async () => {
    const s = await startWorker()
    await stepIn(s)
    await s.rig.rig.service.sendWorkerInput(s.workerId, 'work on it')
    const res = await s.rig.rig.service.interruptWorker(s.workerId)
    expect(res).toEqual({ outcome: 'acked' })
    expect(s.worker.interrupts).toBe(2)
    await terminalHas(s, 'Interrupted')
    await settle(50)
    expect(s.worker.sent).toHaveLength(2)
    expect(row(s)?.userControl).toBe('active')
    expect(lastView(s)?.controlReplying).toBe(false)
  })
})

describe('handing back', () => {
  it('clears control, sends the hand-back text, logs and tells the brain', async () => {
    const s = await startWorker()
    await stepIn(s)
    await s.rig.rig.service.sendWorkerInput(s.workerId, 'use 5 retries')
    result(s)
    await until(() => lastView(s)?.controlReplying === false)
    await s.rig.rig.service.handBackWorker(s.workerId)
    expect(s.worker.sent.at(-1)).toBe(HAND_BACK_TEXT)
    expect(row(s)).toMatchObject({
      userControl: null,
      controlStartedAt: null,
      controlUserMessages: 0,
      controlLastMessage: null
    })
    expect(s.rig.rig.deps.worktreesRepo.listControlBases(s.workerId)).toEqual([])
    expect(events(s)).toContain('You handed W1 api-retry back')
    await terminalHas(s, 'You handed back')
    await until(() => e?.brain().sent.some((t) => t.includes('handed W1 api-retry back')) === true)
    // Control is over: the worker is judged like any other (here: the one nudge).
    const before = s.worker.sent.length
    result(s)
    await until(() => s.worker.sent.length === before + 1)
    expect(s.worker.sent.at(-1)).toContain('report_done')
  })

  it('stops a running reply first, and its interrupted result does not nudge', async () => {
    const s = await startWorker()
    await stepIn(s)
    await s.rig.rig.service.sendWorkerInput(s.workerId, 'work on it')
    await s.rig.rig.service.handBackWorker(s.workerId)
    await settle(150)
    expect(s.worker.interrupts).toBe(2)
    expect(s.worker.sent).toEqual(['Add retries', 'work on it', HAND_BACK_TEXT])
  })

  it('refuses a worker the user is not in control of', async () => {
    const s = await startWorker()
    await expect(s.rig.rig.service.handBackWorker(s.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})

describe('the control channels', () => {
  it('validate their requests, and keep the text between 1 and 20,000 characters', () => {
    const input = channelSchemas['workers:send-input']
    expect(input.safeParse({ workerId: 'w', text: 'x' }).success).toBe(true)
    expect(input.safeParse({ workerId: 'w', text: 'x'.repeat(20_000) }).success).toBe(true)
    expect(input.safeParse({ workerId: 'w', text: 'x'.repeat(20_001) }).success).toBe(false)
    expect(input.safeParse({ workerId: 'w', text: '' }).success).toBe(false)
    expect(input.safeParse({ workerId: 'w', text: 'x', extra: 1 }).success).toBe(false)
    for (const channel of ['workers:step-in', 'workers:hand-back', 'workers:interrupt'] as const) {
      expect(channelSchemas[channel].safeParse({ workerId: 'w' }).success).toBe(true)
      expect(channelSchemas[channel].safeParse({}).success).toBe(false)
    }
  })
})
