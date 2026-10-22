import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { AttentionService } from '../../../src/main/sessions/attention-service'
import type { AttentionNotice } from '../../../src/main/sessions/attention-service'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-attention-terminal-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

interface Started {
  changes: { count: number; ids: string[] }[]
  rig: EngineRig
  sessionId: string
  workerId: string
  worker: FakeHandle
}

async function startWorker(brainAnswerMs?: number): Promise<Started> {
  const changes: Started['changes'] = []
  e = await makeEngineRig(dir(), {
    onAttentionChanged: (_sessionId, state) =>
      changes.push({ count: state.count, ids: state.requests.map((r) => r.id) }),
    ...(brainAnswerMs === undefined ? {} : { timings: { brainAnswerMs } })
  })
  const sessionId = await e.startSession('autonomous')
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'api-retry',
    task: 'Add retry',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  const worker = e.workerHandle()
  worker.emit({
    type: 'session',
    providerSessionId: 'w-claude-1',
    model: 'claude-sonnet-5-5',
    mcpServers: [{ name: 'arc', status: 'connected' }]
  })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { changes, rig: e, sessionId, workerId, worker }
}

const permission = (s: Started, command: string): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'Bash',
    input: { command, description: 'x' },
    tool_use_id: 'toolu_1'
  })

const askUserQuestion = (s: Started): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          options: [{ label: 'axios', description: 'Popular' }],
          multiSelect: false
        }
      ]
    },
    tool_use_id: 'toolu_q1'
  })

const repo = (s: Started) => s.rig.rig.deps.attentionRepo
const stepIn = (s: Started): Promise<void> => s.rig.rig.service.stepInWorker(s.workerId)
const handBack = (s: Started): Promise<void> => s.rig.rig.service.handBackWorker(s.workerId)
const events = (s: Started): string[] =>
  s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)
const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function pendingRow(s: Started, count = 1): Promise<AttentionRequestRow> {
  await until(() => repo(s).listPending(s.sessionId).length >= count)
  return repo(s).listPending(s.sessionId)[count - 1] as AttentionRequestRow
}

/** True while the blocked call has not returned. */
function watch(call: Promise<unknown>): { settled: () => boolean } {
  let done = false
  void call.then(() => (done = true))
  return { settled: () => done }
}

describe('a request that is pending at step-in', () => {
  it('moves to the terminal and stays blocked: not approved, denied, dropped or counted', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const waiting = watch(call)
    const row = await pendingRow(s)
    expect(row).toMatchObject({ route: 'queue', escalated: true })
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)

    await stepIn(s)
    await settle()

    expect(repo(s).get(row.id)).toMatchObject({
      route: 'terminal',
      escalated: true,
      status: 'pending'
    })
    expect(waiting.settled()).toBe(false)
    // Out of Needs attention, but still in the pushed list with its route.
    const state = s.rig.rig.service.attentionState(s.sessionId)
    expect(state.count).toBe(0)
    expect(state.requests.map((r) => [r.id, r.route])).toEqual([[row.id, 'terminal']])
    // The push after step-in carries the request, and the badge count excludes it.
    expect(s.changes.at(-1)).toEqual({ count: 0, ids: [row.id] })
    expect(repo(s).countPendingEscalatedBySession(s.sessionId)).toBe(0)
    expect(repo(s).countPendingEscalatedByGroup()).toEqual({})
    expect(s.rig.rig.service.snapshot(s.sessionId).attention).toMatchObject([
      { id: row.id, route: 'terminal' }
    ])
    expect(s.rig.rig.deps.workersRepo.get(s.workerId)?.status).toBe('needs_approval')

    // Only the user's answer in the terminal releases it.
    s.rig.rig.service.answerAttention(row.id, { approve: true })
    expect((await call).value).toMatchObject({ behavior: 'allow' })
    expect(repo(s).get(row.id)?.status).toBe('approved')
  })

  it('is not auto-resolved when Auto-approve is turned on', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const waiting = watch(call)
    const row = await pendingRow(s)
    await stepIn(s)

    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    await settle()

    expect(repo(s).get(row.id)?.status).toBe('pending')
    expect(waiting.settled()).toBe(false)
    s.rig.rig.service.answerAttention(row.id, { approve: false })
    expect((await call).value).toMatchObject({ behavior: 'deny' })
  })

  it('cancels the brain timer of a question the brain was still looking at', async () => {
    const s = await startWorker(150)
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Use Redis?' })
    const row = await pendingRow(s)
    expect(row).toMatchObject({ route: 'queue', escalated: false })

    await stepIn(s)
    expect(repo(s).get(row.id)).toMatchObject({ route: 'terminal', escalated: true })
    await settle(400)

    // The timer would have passed it to the user with a note; it did not run.
    expect(repo(s).get(row.id)?.brainNote).toBeNull()
    expect(events(s)).not.toContain("Passed to you: the brain didn't answer in time")
    s.rig.rig.service.answerAttention(row.id, { text: 'Postgres.' })
    expect((await call).value).toEqual({ answer: 'Postgres.' })
  })

  it('is refused to the brain with not_resolvable', async () => {
    const s = await startWorker()
    const question = s.rig.call(s.worker, 'ask_brain', { question: 'Which port?' })
    const qrow = await pendingRow(s)
    await stepIn(s)

    const attempt = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: qrow.id,
      decision: 'answer',
      answer: '8080'
    })
    expect(attempt.isError).toBe(true)
    expect(attempt.value['error']).toBe('not_resolvable')
    expect(String(attempt.value['message'] ?? '')).toContain("worker's terminal")
    expect(repo(s).get(qrow.id)?.status).toBe('pending')

    s.rig.rig.service.answerAttention(qrow.id, { text: '8080' })
    await question
  })
})

describe('new requests from a controlled worker', () => {
  it('a push goes to the terminal with no brain turn, and the brain cannot approve it', async () => {
    const s = await startWorker()
    await stepIn(s)
    await until(() => s.rig.brain().sent.some((t) => t.includes('stepped in')))
    const brainSent = s.rig.brain().sent.length

    const call = permission(s, 'git push origin arc/retry-work')
    const row = await pendingRow(s)

    expect(row).toMatchObject({
      route: 'terminal',
      escalated: true,
      mustEscalate: true,
      category: 'leaves_machine',
      status: 'pending'
    })
    await until(() => s.rig.rig.deps.workersRepo.get(s.workerId)?.status === 'needs_approval')
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
    await settle()
    expect(s.rig.brain().sent.length).toBe(brainSent)

    const attempt = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'approve'
    })
    expect(attempt.value['error']).toBe('not_resolvable')

    s.rig.rig.service.answerAttention(row.id, { approve: true })
    expect((await call).value).toMatchObject({ behavior: 'allow' })
    await until(() => s.rig.rig.deps.workersRepo.get(s.workerId)?.status === 'working')
  })

  it('classification still decides: a command that needs no one runs with no row', async () => {
    const s = await startWorker()
    await stepIn(s)
    const outcome = await permission(s, 'pnpm test')
    expect(outcome.value).toMatchObject({ behavior: 'allow' })
    expect(repo(s).listPending(s.sessionId)).toEqual([])
  })

  it('Auto-approve still covers a protected action, but never a push', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    await stepIn(s)

    const install = await permission(s, 'brew install jq')
    expect(install.value).toMatchObject({ behavior: 'allow' })
    expect(repo(s).listPending(s.sessionId)).toEqual([])
    expect(events(s).some((t) => t.startsWith('Auto-approved'))).toBe(true)

    const push = permission(s, 'git push origin arc/retry-work')
    const waiting = watch(push)
    const row = await pendingRow(s)
    await settle()
    expect(row).toMatchObject({ route: 'terminal', status: 'pending' })
    expect(waiting.settled()).toBe(false)
    s.rig.rig.service.answerAttention(row.id, { approve: false })
    await push
  })

  it('an allow rule still covers a protected action', async () => {
    const s = await startWorker()
    s.rig.rig.deps.allowRulesRepo.create({
      id: 'rule1',
      sessionId: s.sessionId,
      category: 'global_install',
      tool: 'Bash',
      prefix: 'brew install',
      folder: null,
      text: 'brew install',
      createdAt: 1
    })
    await stepIn(s)
    const outcome = await permission(s, 'brew install jq')
    expect(outcome.value).toMatchObject({ behavior: 'allow' })
    expect(repo(s).listPending(s.sessionId)).toEqual([])
    expect(events(s).some((t) => t.startsWith('Allowed by your rule'))).toBe(true)
  })

  it('an AskUserQuestion goes to the terminal with no brain turn', async () => {
    const s = await startWorker()
    await stepIn(s)
    await until(() => s.rig.brain().sent.some((t) => t.includes('stepped in')))
    const brainSent = s.rig.brain().sent.length

    const call = askUserQuestion(s)
    const row = await pendingRow(s)
    expect(row).toMatchObject({ route: 'terminal', escalated: true, toolName: 'AskUserQuestion' })
    await until(() => s.rig.rig.deps.workersRepo.get(s.workerId)?.status === 'has_question')
    await settle()
    expect(s.rig.brain().sent.length).toBe(brainSent)
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)

    s.rig.rig.service.answerAttention(row.id, { answers: { 'Which library?': ['axios'] } })
    expect((await call).value).toMatchObject({ behavior: 'allow' })
  })

  it('an ask_brain goes to the user in the terminal, and their answer is the tool result', async () => {
    const s = await startWorker(150)
    await stepIn(s)
    await until(() => s.rig.brain().sent.some((t) => t.includes('stepped in')))
    const brainSent = s.rig.brain().sent.length

    const call = s.rig.call(s.worker, 'ask_brain', { question: 'How many retries?' })
    const row = await pendingRow(s)
    expect(row).toMatchObject({
      route: 'terminal',
      escalated: true,
      brainNote: null,
      kind: 'question',
      toolName: null
    })
    await until(() => s.rig.rig.deps.workersRepo.get(s.workerId)?.status === 'has_question')
    // No brain note and no timer: past the brain timeout nothing was passed on or sent.
    await settle(400)
    expect(s.rig.brain().sent.length).toBe(brainSent)
    expect(events(s)).not.toContain("Passed to you: the brain didn't answer in time")
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)

    const refused = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'three'
    })
    expect(refused.value['error']).toBe('not_resolvable')

    s.rig.rig.service.answerAttention(row.id, { text: 'Three, with backoff.' })
    expect((await call).value).toEqual({ answer: 'Three, with backoff.' })
    expect(repo(s).get(row.id)).toMatchObject({ status: 'answered', delivered: true })
    expect(events(s)).toContain('Answered by you: Three, with backoff.')
  })
})

describe('hand-back', () => {
  it('returns a pending push to Needs attention, still blocked, and tells the brain it cannot approve it', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const waiting = watch(call)
    const row = await pendingRow(s)
    await stepIn(s)
    expect(repo(s).get(row.id)?.route).toBe('terminal')
    const brainSent = s.rig.brain().sent.length

    await handBack(s)

    expect(repo(s).get(row.id)).toMatchObject({
      route: 'queue',
      escalated: true,
      status: 'pending'
    })
    expect(waiting.settled()).toBe(false)
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    await until(() =>
      s.rig
        .brain()
        .sent.slice(brainSent)
        .some((t) => t.includes('you cannot approve it') && t.includes(`request ${row.id}`))
    )
    s.rig.rig.service.answerAttention(row.id, { approve: true })
    expect((await call).value).toMatchObject({ behavior: 'allow' })
  })

  it('returns a question the brain may answer to the brain-first path, with a timer', async () => {
    const s = await startWorker(150)
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Use Redis?' })
    const row = await pendingRow(s)
    await stepIn(s)
    const brainSent = s.rig.brain().sent.length

    await handBack(s)

    expect(repo(s).get(row.id)).toMatchObject({ route: 'queue', escalated: false, brainNote: null })
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
    await until(() =>
      s.rig
        .brain()
        .sent.slice(brainSent)
        .some((t) => t.includes('asks: "Use Redis?"') && t.includes(`request ${row.id}`))
    )
    // The brain can answer it again.
    const resolved = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'Yes.'
    })
    expect(resolved.value).toEqual({ ok: true })
    expect((await call).value).toEqual({ answer: 'Yes.' })
  })

  it('the brain timer runs again for a question the brain leaves alone', async () => {
    const s = await startWorker(150)
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Which?' })
    const row = await pendingRow(s)
    await stepIn(s)
    await handBack(s)
    await until(() => repo(s).get(row.id)?.escalated === true)
    expect(repo(s).get(row.id)?.brainNote).toBe("The brain didn't answer in time.")
    s.rig.rig.service.answerAttention(row.id, { text: 'This one.' })
    await call
  })

  it('keeps an AskUserQuestion with the user and tells the brain it cannot answer it', async () => {
    const s = await startWorker()
    await stepIn(s)
    const call = askUserQuestion(s)
    const row = await pendingRow(s)
    const brainSent = s.rig.brain().sent.length

    await handBack(s)

    expect(repo(s).get(row.id)).toMatchObject({ route: 'queue', escalated: true })
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    await until(() =>
      s.rig
        .brain()
        .sent.slice(brainSent)
        .some((t) => t.includes('asks the user a question'))
    )
    s.rig.rig.service.answerAttention(row.id, { answers: { 'Which library?': ['axios'] } })
    await call
  })
})

describe('what the renderer is sent', () => {
  it('puts route on the attention view and keeps notifications for the queue only', async () => {
    const s = await startWorker()
    const notices: AttentionNotice[] = []
    const pushes: { count: number; requests: { id: string; route: string }[] }[] = []
    const service = new AttentionService({
      sessions: { answerAttention: () => undefined },
      attentionRepo: repo(s),
      sessionsRepo: s.rig.rig.sessionsRepo,
      workerOf: (id) => s.rig.rig.deps.workersRepo.get(id),
      emit: (_event, payload) => void pushes.push(payload),
      onNewRequest: (n) => notices.push(n)
    })
    const queued = permission(s, 'git push origin arc/one')
    const queuedRow = await pendingRow(s)
    service.onAttentionChanged(s.sessionId, s.rig.rig.service.attentionState(s.sessionId))
    expect(pushes.at(-1)?.requests.map((r) => [r.id, r.route])).toEqual([[queuedRow.id, 'queue']])
    expect(notices.map((n) => n.requestId)).toEqual([queuedRow.id])
    notices.length = 0
    await stepIn(s)
    const inTerminal = permission(s, 'git push origin arc/two')
    const terminalRow = await pendingRow(s, 2)

    service.onAttentionChanged(s.sessionId, s.rig.rig.service.attentionState(s.sessionId))

    expect(pushes.at(-1)?.count).toBe(0)
    expect(pushes.at(-1)?.requests.map((r) => [r.id, r.route])).toEqual([
      [queuedRow.id, 'terminal'],
      [terminalRow.id, 'terminal']
    ])
    expect(notices).toEqual([])
    s.rig.rig.service.answerAttention(queuedRow.id, { approve: false })
    s.rig.rig.service.answerAttention(terminalRow.id, { approve: false })
    await Promise.all([queued, inTerminal])
  })
})
