import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeAgent } from '../../../src/main/bridge/types'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { AttentionCoordinator } from '../../../src/main/sessions/attention-coordinator'
import type { AttentionHost } from '../../../src/main/sessions/attention-coordinator'
import { SessionService } from '../../../src/main/sessions/session-service'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter } from './helpers'
import type { FakeHandle } from './helpers'

// @spec: 014-inline-needs-attention (functional spec 2.3: a request that goes away leaves no record)

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-attention-cancel-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

interface Push {
  count: number
  ids: string[]
}

interface Started {
  rig: EngineRig
  sessionId: string
  workerId: string
  worker: FakeHandle
  pushes: Push[]
}

async function startSession(): Promise<{ rig: EngineRig; sessionId: string; pushes: Push[] }> {
  const pushes: Push[] = []
  e = await makeEngineRig(dir(), {
    onAttentionChanged: (_sessionId, state) =>
      pushes.push({ count: state.count, ids: state.requests.map((r) => r.id) })
  })
  const sessionId = await e.startSession('autonomous')
  return { rig: e, sessionId, pushes }
}

async function addWorker(
  base: { rig: EngineRig; sessionId: string; pushes: Push[] },
  name: string,
  repo: string,
  index: number
): Promise<Started> {
  const started = await base.rig.call(base.rig.brain(), 'spawn_worker', {
    name,
    task: `Do ${name}`,
    repos: [repo]
  })
  const workerId = String(started.value['workerId'])
  const worker = base.rig.workerHandle(index)
  worker.emit({
    type: 'session',
    providerSessionId: `w-claude-${index}`,
    model: 'claude-sonnet-5-5',
    mcpServers: [{ name: 'arc', status: 'connected' }]
  })
  await until(() => base.rig.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { ...base, workerId, worker }
}

const startWorker = async (): Promise<Started> =>
  addWorker(await startSession(), 'api-retry', 'api', 0)

const permission = (s: Started, command: string, toolUseId = 'toolu_1'): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'Bash',
    input: { command, description: 'x' },
    tool_use_id: toolUseId
  })

const question = (s: Started, text: string): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'ask_brain', { question: text })

const repo = (s: Started) => s.rig.rig.deps.attentionRepo
const service = (s: Started) => s.rig.rig.service
const worker = (s: Started) => s.rig.rig.deps.workersRepo.get(s.workerId)

async function pendingOf(
  s: Started,
  workerId: string,
  count: number
): Promise<AttentionRequestRow[]> {
  await until(
    () =>
      repo(s)
        .listPending(s.sessionId)
        .filter((r) => r.workerId === workerId).length >= count
  )
  return repo(s)
    .listPending(s.sessionId)
    .filter((r) => r.workerId === workerId)
}

/** A worker's question goes to the user when the brain passes it on; the test plays that step. */
async function escalate(s: Started, row: AttentionRequestRow): Promise<void> {
  const out = await s.rig.call(s.rig.brain(), 'escalate_to_user', {
    requestId: row.id,
    reason: 'Needs the user.'
  })
  expect(out.isError).toBe(false)
}

const recordMessages = (s: Started) =>
  s.rig.rig.messagesRepo
    .latest(s.sessionId, 100)
    .filter((m) => m.promptJson?.includes('attention-record'))

const records = (s: Started): number => recordMessages(s).length

/** True once the blocked call has returned. */
function watch(call: Promise<unknown>): { settled: () => boolean } {
  let done = false
  void call.then(() => (done = true))
  return { settled: () => done }
}

describe("a user's stop cancels the worker's waiting requests", () => {
  it('cancels a permission and a question, marks them delivered, pushes the list without them and drops the count', async () => {
    const s = await startWorker()
    const perm = permission(s, 'git push origin arc/retry-work')
    const waiting = watch(perm)
    const [permRow] = await pendingOf(s, s.workerId, 1)
    const ask = question(s, 'Use Redis?')
    const rows = await pendingOf(s, s.workerId, 2)
    const askRow = rows.find((r) => r.kind === 'question') as AttentionRequestRow
    await escalate(s, askRow)
    expect(service(s).attentionState(s.sessionId).count).toBe(2)
    expect(waiting.settled()).toBe(false)

    await service(s).stopWorker(s.workerId)

    expect(worker(s)).toMatchObject({ status: 'stopped', stoppedBy: 'user' })
    for (const id of [(permRow as AttentionRequestRow).id, askRow.id]) {
      expect(repo(s).get(id)).toMatchObject({ status: 'cancelled', delivered: true, answer: null })
    }
    expect(repo(s).listPending(s.sessionId)).toEqual([])
    expect(repo(s).listUndelivered(s.sessionId)).toEqual([])
    expect(service(s).attentionState(s.sessionId)).toMatchObject({ count: 0, requests: [] })
    expect(s.pushes.at(-1)).toEqual({ count: 0, ids: [] })
    expect(service(s).snapshot(s.sessionId).attention).toEqual([])
    // The blocked calls end; nobody is left waiting on a cancelled request.
    expect((await perm).isError).toBe(true)
    expect((await ask).isError).toBe(true)
    expect(records(s)).toBe(0)
  })

  it('cancels a request that is answered in the stepped-in terminal as well', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)
    await service(s).stepInWorker(s.workerId)
    expect(repo(s).get((row as AttentionRequestRow).id)?.route).toBe('terminal')

    await service(s).stopWorker(s.workerId)

    expect(repo(s).get((row as AttentionRequestRow).id)).toMatchObject({
      status: 'cancelled',
      delivered: true
    })
    expect(s.pushes.at(-1)).toEqual({ count: 0, ids: [] })
    await call
    expect(records(s)).toBe(0)
  })

  it("leaves a second worker's requests and the list entry untouched", async () => {
    const base = await startSession()
    const one = await addWorker(base, 'api-retry', 'api', 0)
    const two = await addWorker(base, 'web-ui', 'web', 1)
    const first = permission(one, 'git push origin arc/retry-work')
    const second = permission(two, 'git push origin arc/web-ui')
    const [oneRow] = await pendingOf(one, one.workerId, 1)
    const [twoRow] = await pendingOf(one, two.workerId, 1)
    expect(service(one).attentionState(one.sessionId).count).toBe(2)

    await service(one).stopWorker(one.workerId)

    expect(repo(one).get((oneRow as AttentionRequestRow).id)?.status).toBe('cancelled')
    expect(repo(one).get((twoRow as AttentionRequestRow).id)).toMatchObject({
      status: 'pending',
      delivered: false
    })
    expect(
      service(one)
        .attentionState(one.sessionId)
        .requests.map((r) => r.id)
    ).toEqual([(twoRow as AttentionRequestRow).id])
    expect(service(one).attentionState(one.sessionId).count).toBe(1)
    expect(s2Status(two)).toBe('needs_approval')
    // The other worker's call is still blocked and its answer still works.
    const stillWaiting = watch(second)
    await new Promise((r) => setTimeout(r, 100))
    expect(stillWaiting.settled()).toBe(false)
    service(one).answerAttention((twoRow as AttentionRequestRow).id, { approve: true })
    expect((await second).value).toMatchObject({ behavior: 'allow' })
    await first
  })

  it('refuses a late answer to a cancelled request and writes no record', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)
    const id = (row as AttentionRequestRow).id
    await service(s).stopWorker(s.workerId)
    await call
    const pushes = s.pushes.length

    expect(() => service(s).answerAttention(id, { approve: true })).toThrow()
    expect(() => service(s).answerAttention(id, { approve: false })).toThrow()
    expect(repo(s).get(id)?.status).toBe('cancelled')
    expect(records(s)).toBe(0)
    expect(s.pushes.length).toBe(pushes)
  })

  it('writes no record and sends the brain no note of its own for the cancelled requests', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    await pendingOf(s, s.workerId, 1)
    await until(() => s.rig.brain().sent.some((t) => t.includes('cannot approve it')))

    await service(s).stopWorker(s.workerId)
    await call
    await new Promise((r) => setTimeout(r, 100))

    expect(records(s)).toBe(0)
    expect(s.rig.rig.messagesRepo.latest(s.sessionId, 100).map((m) => m.content)).not.toContain(
      expect.stringMatching(/^(Approved|Denied|Answered):/)
    )
    expect(s.rig.brain().sent.some((t) => /cancelled/i.test(t) && t.includes('request'))).toBe(
      false
    )
  })

  it('is harmless a second time: a repeated stop pushes nothing more', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    await pendingOf(s, s.workerId, 1)
    await service(s).stopWorker(s.workerId)
    await call
    const pushes = s.pushes.length

    await service(s).stopWorker(s.workerId)

    expect(s.pushes.length).toBe(pushes)
    expect(worker(s)).toMatchObject({ status: 'stopped', stoppedBy: 'user' })
  })
})

function s2Status(s: Started): string | undefined {
  return s.rig.rig.deps.workersRepo.get(s.workerId)?.status
}

describe('Arc quitting or crashing keeps the requests for the resumed worker', () => {
  it('a quit leaves the waiting worker and its pending permission and question as they were, and pushes no cancellation', async () => {
    const s = await startWorker()
    const perm = permission(s, 'git push origin arc/retry-work')
    const [permRow] = await pendingOf(s, s.workerId, 1)
    const ask = question(s, 'Use Redis?')
    const rows = await pendingOf(s, s.workerId, 2)
    const askRow = rows.find((r) => r.kind === 'question') as AttentionRequestRow
    await escalate(s, askRow)
    const pushes = s.pushes.length

    // `stopAll('quit')`: the quit-time stop is not the user's Stop.
    await s.rig.rig.service.shutdown()

    expect(worker(s)).toMatchObject({ status: 'has_question', stoppedBy: null })
    for (const id of [(permRow as AttentionRequestRow).id, askRow.id]) {
      expect(repo(s).get(id)).toMatchObject({ status: 'pending', delivered: false })
    }
    expect(s.pushes.slice(pushes).every((p) => p.ids.length > 0)).toBe(true)
    expect(records(s)).toBe(0)
    await Promise.allSettled([perm, ask])
  })

  it('a quit stops a working worker as "quit" and keeps its request for the resumed worker', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)
    // A request that is already answered is not what a quit keeps; this one is still waiting.
    await until(() => worker(s)?.status === 'needs_approval')

    await s.rig.rig.service.shutdown()

    expect(repo(s).get((row as AttentionRequestRow).id)).toMatchObject({
      status: 'pending',
      delivered: false
    })
    expect(worker(s)?.stoppedBy).not.toBe('user')
    await Promise.allSettled([call])
  })

  it('a crash of the worker process leaves its pending request pending', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)

    s.worker.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })
    await until(() => worker(s)?.status === 'failed')

    expect(repo(s).get((row as AttentionRequestRow).id)).toMatchObject({
      status: 'pending',
      delivered: false
    })
    expect(service(s).attentionState(s.sessionId).count).toBe(1)
    await Promise.allSettled([call])
  })

  it('a relaunched Arc still holds the request', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)
    await s.rig.rig.service.shutdown()
    await Promise.allSettled([call])
    const relaunched = new SessionService({
      ...s.rig.rig.deps,
      registry: claudeRegistry(new FakeAdapter())
    })
    extra.push(relaunched)

    expect(relaunched.attentionState(s.sessionId).requests.map((r) => r.id)).toEqual([
      (row as AttentionRequestRow).id
    ])
    expect(repo(s).get((row as AttentionRequestRow).id)?.status).toBe('pending')
  })

  it('a user Stop on a waiting worker that has no process left does not end it, so its requests stay and it is not resumed', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)
    await s.rig.rig.service.shutdown()
    await Promise.allSettled([call])
    const adapter = new FakeAdapter()
    const relaunched = new SessionService({
      ...s.rig.rig.deps,
      registry: claudeRegistry(adapter)
    })
    extra.push(relaunched)
    await relaunched.open(s.sessionId)

    await relaunched.stopWorker(s.workerId)

    expect(worker(s)?.status).toBe('needs_approval')
    expect(repo(s).get((row as AttentionRequestRow).id)).toMatchObject({
      status: 'pending',
      delivered: false
    })
    expect(adapter.starts).toEqual([])
  })
})

describe('removing a worker cancels the requests it left behind', () => {
  it('a failed worker that died with a request pending loses it on removal, and the list is pushed', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingOf(s, s.workerId, 1)
    const id = (row as AttentionRequestRow).id
    s.worker.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })
    await until(() => worker(s)?.status === 'failed')
    await Promise.allSettled([call])
    expect(service(s).attentionState(s.sessionId).count).toBe(1)
    const pushes = s.pushes.length

    await service(s).removeWorker(s.workerId)

    expect(repo(s).get(id)).toMatchObject({ status: 'cancelled', delivered: true })
    expect(service(s).attentionState(s.sessionId)).toMatchObject({ count: 0, requests: [] })
    expect(s.pushes.length).toBeGreaterThan(pushes)
    expect(s.pushes.at(-1)).toEqual({ count: 0, ids: [] })
    expect(worker(s)?.removedAt).not.toBeNull()
    expect(records(s)).toBe(0)
    expect(() => service(s).answerAttention(id, { approve: true })).toThrow()
  })

  it("leaves another worker's requests alone", async () => {
    const base = await startSession()
    const one = await addWorker(base, 'api-retry', 'api', 0)
    const two = await addWorker(base, 'web-ui', 'web', 1)
    const first = permission(one, 'git push origin arc/retry-work')
    const second = permission(two, 'git push origin arc/web-ui')
    const [oneRow] = await pendingOf(one, one.workerId, 1)
    const [twoRow] = await pendingOf(one, two.workerId, 1)
    one.worker.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })
    await until(() => worker(one)?.status === 'failed')
    await Promise.allSettled([first])

    await service(one).removeWorker(one.workerId)

    expect(repo(one).get((oneRow as AttentionRequestRow).id)?.status).toBe('cancelled')
    expect(repo(one).get((twoRow as AttentionRequestRow).id)?.status).toBe('pending')
    expect(service(one).attentionState(one.sessionId).count).toBe(1)
    service(one).answerAttention((twoRow as AttentionRequestRow).id, { approve: true })
    await second
  })
})

describe('AttentionCoordinator.cancelForWorker', () => {
  interface Bare {
    coordinator: AttentionCoordinator
    host: { onChanged: ReturnType<typeof vi.fn>; recordAnswer: ReturnType<typeof vi.fn> }
    notes: string[]
    statuses: string[]
    agent: BridgeAgent
    base: Started
  }

  async function bare(brainAnswerMs = 60_000): Promise<Bare> {
    const base = await startWorker()
    const onChanged = vi.fn()
    const recordAnswer = vi.fn()
    const notes: string[] = []
    const statuses: string[] = []
    const host = {
      sessionId: base.sessionId,
      now: () => Date.now(),
      newId: () => `bare-${Math.random().toString(36).slice(2)}`,
      logEvent: vi.fn(),
      notifyBrain: (text: string) => void notes.push(text),
      workerOf: () => ({ id: base.workerId, number: 1, slug: 'api-retry' }),
      workerLabel: () => 'W1 api-retry',
      setWorkerStatus: (_id: string, status: string) => void statuses.push(status),
      onBrainWaiting: vi.fn(),
      onChanged,
      isControlled: () => false,
      recordAnswer
    } as unknown as AttentionHost
    const coordinator = new AttentionCoordinator(repo(base), host, { brainAnswerMs })
    const agent: BridgeAgent = { sessionId: base.sessionId, agentId: 'agent-x', role: 'worker' }
    return { coordinator, host: { onChanged, recordAnswer }, notes, statuses, agent, base }
  }

  it('releases the blocked call the way a withdrawn request does, with a cancelled error', async () => {
    const b = await bare()
    const call = b.coordinator.askBrain(
      b.agent,
      { question: 'Which port?' },
      new AbortController().signal
    )
    const failure = call.then(
      () => null,
      (error: unknown) => error as Error & { code?: string }
    )
    const [row] = await pendingOf(b.base, b.base.workerId, 1)
    const id = (row as AttentionRequestRow).id
    b.host.onChanged.mockClear()

    b.coordinator.cancelForWorker(b.base.workerId)

    const error = await failure
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toMatch(/cancelled/i)
    expect(repo(b.base).get(id)).toMatchObject({ status: 'cancelled', delivered: true })
    expect(b.host.onChanged).toHaveBeenCalledTimes(1)
    expect(b.host.recordAnswer).not.toHaveBeenCalled()
    // The worker's state is refreshed: nothing waits on it any more.
    expect(b.statuses.at(-1)).toBe('working')
    // A late answer is refused and settles nothing.
    expect(() => b.coordinator.answer(id, { text: 'late' })).toThrow()
    expect(b.host.recordAnswer).not.toHaveBeenCalled()
  })

  it('clears the brain timer of a request the brain was still looking at', async () => {
    const b = await bare(5_000)
    vi.useFakeTimers()
    const call = b.coordinator.askBrain(
      b.agent,
      { question: 'Use Redis?' },
      new AbortController().signal
    )
    void call.catch(() => undefined)
    const before = vi.getTimerCount()
    expect(before).toBeGreaterThan(0)

    b.coordinator.cancelForWorker(b.base.workerId)

    expect(vi.getTimerCount()).toBe(before - 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(b.host.onChanged).toHaveBeenCalledTimes(1)
  })

  it('is a no-op with no push for a worker with nothing pending, and idempotent after a cancel', async () => {
    const b = await bare()
    b.coordinator.cancelForWorker(b.base.workerId)
    expect(b.host.onChanged).not.toHaveBeenCalled()
    expect(b.statuses).toEqual([])

    const call = b.coordinator.askBrain(
      b.agent,
      { question: 'Which port?' },
      new AbortController().signal
    )
    void call.catch(() => undefined)
    await pendingOf(b.base, b.base.workerId, 1)
    b.host.onChanged.mockClear()
    b.coordinator.cancelForWorker(b.base.workerId)
    b.coordinator.cancelForWorker(b.base.workerId)
    expect(b.host.onChanged).toHaveBeenCalledTimes(1)
    expect(b.notes.some((n) => /cancel/i.test(n))).toBe(false)
  })
})
