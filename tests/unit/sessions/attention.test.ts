import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROGRESS_INTERVAL_MS } from '../../../src/main/bridge/bridge-server'
import { BRAIN_MCP_TOOL_TIMEOUT_MS } from '../../../src/main/sessions/orchestrator'
import { WORKER_MCP_TOOL_TIMEOUT_MS } from '../../../src/main/sessions/worker-manager'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import type { AttentionState } from '../../../src/main/sessions/attention-coordinator'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-attention-')
let e: EngineRig | undefined

afterEach(async () => {
  vi.useRealTimers()
  await e?.close()
  e = undefined
})

interface Started {
  rig: EngineRig
  sessionId: string
  workerId: string
  worker: FakeHandle
  changes: { sessionId: string; state: AttentionState }[]
}

/** An autonomous session with one worker that is Working. */
async function startWorker(brainAnswerMs?: number): Promise<Started> {
  const changes: Started['changes'] = []
  e = await makeEngineRig(dir(), {
    onAttentionChanged: (sessionId, state) => changes.push({ sessionId, state }),
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
  return { rig: e, sessionId, workerId, worker, changes }
}

const permission = (
  s: Started,
  command: string,
  extra: Record<string, unknown> = {}
): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'Bash',
    input: { command, description: 'x' },
    tool_use_id: 'toolu_1',
    ...extra
  })

async function pendingRow(s: Started, count = 1): Promise<AttentionRequestRow> {
  await until(() => s.rig.rig.deps.attentionRepo.listPending(s.sessionId).length >= count)
  const rows = s.rig.rig.deps.attentionRepo.listPending(s.sessionId)
  return rows[count - 1] as AttentionRequestRow
}

const workerStatus = (s: Started): string | undefined =>
  s.rig.rig.deps.workersRepo.get(s.workerId)?.status

const eventTexts = (s: Started): string[] =>
  s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)

describe('limits that keep a blocked call alive', () => {
  it("sends progress every 15 s and gives workers the brain's 12 hour tool timeout", async () => {
    const s = await startWorker()
    expect(PROGRESS_INTERVAL_MS).toBe(15_000)
    expect(WORKER_MCP_TOOL_TIMEOUT_MS).toBe('43200000')
    expect(WORKER_MCP_TOOL_TIMEOUT_MS).toBe(BRAIN_MCP_TOOL_TIMEOUT_MS)
    expect(s.rig.rig.adapter.starts.find((x) => x.role === 'worker')?.extraEnv).toEqual({
      MCP_TOOL_TIMEOUT: '43200000'
    })
  })
})

describe('request_permission: escalated by policy', () => {
  it('stores the row, escalates it to the user at once, tells the brain, and waits', async () => {
    const s = await startWorker()
    const brainSent = s.rig.brain().sent.length
    const call = permission(s, 'git push origin arc/retry-work')
    const row = await pendingRow(s)

    expect(row).toMatchObject({
      sessionId: s.sessionId,
      workerId: s.workerId,
      source: 'worker',
      kind: 'permission',
      action: 'git push origin arc/retry-work',
      toolName: 'Bash',
      toolUseId: 'toolu_1',
      category: 'leaves_machine',
      mustEscalate: true,
      escalated: true,
      status: 'pending',
      delivered: false
    })
    expect(JSON.parse(row.toolInputJson ?? '{}')).toEqual({
      command: 'git push origin arc/retry-work',
      description: 'x'
    })
    expect(row.brainNote).toBe('Pushing leaves your machine, so this needs you.')

    // The worker waits as Needs approval, and the user sees one request.
    await until(() => workerStatus(s) === 'needs_approval')
    expect(s.rig.rig.deps.workersRepo.get(s.workerId)?.activity).toBe('Waiting for approval')
    expect(s.rig.rig.service.attentionState(s.sessionId)).toMatchObject({ count: 1 })
    expect(s.changes.at(-1)?.state.requests.map((r) => r.id)).toEqual([row.id])

    // The brain is told, with the request id, and that it cannot approve it.
    await until(() => s.rig.brain().sent.length > brainSent)
    const note = s.rig.brain().sent.at(-1) ?? ''
    expect(note).toContain(
      '[Arc] W1 api-retry asks permission to run `git push origin arc/retry-work`'
    )
    expect(note).toContain(`(request ${row.id})`)
    expect(note).toContain('you cannot approve it')

    // The call is still blocked.
    let settled = false
    void call.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 100))
    expect(settled).toBe(false)

    s.rig.rig.service.answerAttention(row.id, { approve: true })
    const outcome = await call
    expect(outcome.isError).toBe(false)
    expect(outcome.value).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git push origin arc/retry-work', description: 'x' }
    })
    expect(s.rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({
      status: 'approved',
      delivered: true
    })
    await until(() => workerStatus(s) === 'working')
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
    expect(eventTexts(s)).toContain('Approved by you')
    expect(s.changes.at(-1)?.state.count).toBe(0)
  })

  it('returns the S0 deny shape when the user denies, and logs Denied by you', async () => {
    const s = await startWorker()
    const call = permission(s, 'brew install jq')
    const row = await pendingRow(s)
    expect(row).toMatchObject({ category: 'global_install', mustEscalate: true, escalated: true })

    s.rig.rig.service.answerAttention(row.id, { approve: false })
    const outcome = await call
    expect(outcome.value).toEqual({ behavior: 'deny', message: 'The user denied this request.' })
    expect(s.rig.rig.deps.attentionRepo.get(row.id)?.status).toBe('denied')
    expect(eventTexts(s)).toContain('Denied by you')
    await until(() => workerStatus(s) === 'working')
  })

  it('refuses the brain approving it with policy_requires_user, and the request stays pending', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const row = await pendingRow(s)

    const attempt = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'approve',
      note: 'looks fine'
    })
    expect(attempt.isError).toBe(true)
    expect(attempt.value['error']).toBe('policy_requires_user')
    expect(s.rig.rig.deps.attentionRepo.get(row.id)?.status).toBe('pending')
    expect(workerStatus(s)).toBe('needs_approval')

    s.rig.rig.service.answerAttention(row.id, { approve: false })
    await call
  })

  it('escalates an Edit outside the worktree and a write to the user checkout', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.worker, 'request_permission', {
      tool_name: 'Write',
      input: { file_path: `${s.rig.api.path}/src/changed.ts`, content: 'x' },
      tool_use_id: 'toolu_2'
    })
    const row = await pendingRow(s)
    expect(row).toMatchObject({
      category: 'outside_worktree',
      mustEscalate: true,
      escalated: true,
      toolName: 'Write'
    })
    expect(row.action).toBe(`Write ${s.rig.api.path}/src/changed.ts`)
    s.rig.rig.service.answerAttention(row.id, { approve: false })
    await call
  })
})

describe('request_permission: unclassified commands', () => {
  it('allows pnpm test and ls at once: no row, no brain turn, no status change', async () => {
    const s = await startWorker()
    const brainSent = s.rig.brain().sent.length
    for (const command of ['pnpm test', 'ls', 'git status && git commit -m "x"']) {
      const outcome = await permission(s, command)
      expect(outcome.isError).toBe(false)
      expect(outcome.value).toEqual({
        behavior: 'allow',
        updatedInput: { command, description: 'x' }
      })
    }
    expect(s.rig.rig.deps.attentionRepo.listPending(s.sessionId)).toEqual([])
    expect(s.rig.rig.deps.attentionRepo.listUndelivered(s.sessionId)).toEqual([])
    expect(workerStatus(s)).toBe('working')
    expect(s.rig.brain().sent.length).toBe(brainSent)
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
  })
})

describe('brain-addressed questions', () => {
  it('escalate_to_user moves a request to the user with the brain note, and the brain can no longer resolve it', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Use Redis?' })
    const row = await pendingRow(s)
    const escalated = await s.rig.call(s.rig.brain(), 'escalate_to_user', {
      requestId: row.id,
      reason: 'The notes do not say; you decide.'
    })
    expect(escalated.value).toEqual({ ok: true })
    expect(s.rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({
      escalated: true,
      brainNote: 'The notes do not say; you decide.'
    })
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    expect(eventTexts(s)).toContain('Passed to you: The notes do not say; you decide.')

    const again = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'yes'
    })
    expect(again.value['error']).toBe('already_escalated')
    s.rig.rig.service.answerAttention(row.id, { text: 'No.' })
    expect((await call).value).toEqual({ answer: 'No.' })
  })

  it('a question needs decision "answer" with an answer', async () => {
    const s = await startWorker()
    const question = s.rig.call(s.worker, 'ask_brain', { question: 'Which port?' })
    const qrow = await pendingRow(s)
    const wrong = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: qrow.id,
      decision: 'approve'
    })
    expect(wrong.value['error']).toBe('wrong_decision')
    await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: qrow.id,
      decision: 'answer',
      answer: '8080'
    })
    await question
  })

  it('refuses a request id from another session and a resolved one', async () => {
    const s = await startWorker()
    const unknown = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: 'nope',
      decision: 'answer',
      answer: 'x'
    })
    expect(unknown.value['error']).toBe('unknown_request')
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Which?' })
    const row = await pendingRow(s)
    await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'This'
    })
    await call
    const twice = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'Again'
    })
    expect(twice.value['error']).toBe('already_resolved')
  })
})

describe('ask_brain', () => {
  it('blocks the worker as Has a question until the brain answers; the answer is logged', async () => {
    const s = await startWorker()
    const brainSent = s.rig.brain().sent.length
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'How many retries?' })
    const row = await pendingRow(s)
    expect(row).toMatchObject({
      kind: 'question',
      source: 'worker',
      question: 'How many retries?',
      escalated: false,
      status: 'pending'
    })
    await until(() => workerStatus(s) === 'has_question')
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
    await until(() => s.rig.brain().sent.length > brainSent)
    expect(s.rig.brain().sent.at(-1)).toContain('W1 api-retry asks: "How many retries?"')
    expect(s.rig.brain().sent.at(-1)).toContain(`(request ${row.id})`)

    await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'Three, with backoff.',
      note: 'From the plan.'
    })
    expect((await call).value).toEqual({ answer: 'Three, with backoff.' })
    expect(eventTexts(s)).toContain('W1 question answered by brain')
    expect(s.rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({
      status: 'answered',
      answer: 'Three, with backoff.',
      delivered: true
    })
    await until(() => workerStatus(s) === 'working')
  })

  it('goes to the user when the brain escalates it; the user answer reaches the worker and the log', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Use Redis or Postgres?' })
    const row = await pendingRow(s)
    await s.rig.call(s.rig.brain(), 'escalate_to_user', {
      requestId: row.id,
      reason: 'The notes do not say.'
    })
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    s.rig.rig.service.answerAttention(row.id, { text: 'Postgres.' })
    expect((await call).value).toEqual({ answer: 'Postgres.' })
    expect(eventTexts(s)).toContain('Answered by you: Postgres.')
    await until(() => workerStatus(s) === 'working')
  })

  it('rejects the wrong kind of user answer', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Which?' })
    const row = await pendingRow(s)
    expect(() => s.rig.rig.service.answerAttention(row.id, { approve: true })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' })
    )
    expect(() => s.rig.rig.service.answerAttention(row.id, { text: '  ' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' })
    )
    expect(() => s.rig.rig.service.answerAttention('missing', { text: 'x' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' })
    )
    s.rig.rig.service.answerAttention(row.id, { text: 'This one.' })
    await call
    expect(() => s.rig.rig.service.answerAttention(row.id, { text: 'again' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' })
    )
  })
})

describe('ask_user', () => {
  it('escalates at once, puts the brain in waiting, and returns the answer', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.rig.brain(), 'ask_user', { question: 'Ship it on Friday?' })
    const row = await pendingRow(s)
    expect(row).toMatchObject({
      source: 'brain',
      kind: 'question',
      workerId: null,
      question: 'Ship it on Friday?',
      escalated: true
    })
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    expect(s.rig.rig.service.snapshot(s.sessionId).brainState).toBe('waiting')
    // The brain cannot resolve its own question.
    const own = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'yes'
    })
    expect(own.value['error']).toBe('not_resolvable')

    s.rig.rig.service.answerAttention(row.id, { text: 'Yes, Friday.' })
    expect((await call).value).toEqual({ answer: 'Yes, Friday.' })
    expect(s.rig.rig.service.snapshot(s.sessionId).brainState).toBe('thinking')
    expect(eventTexts(s)).toContain('Answered by you: Yes, Friday.')
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
  })
})

describe('a call that dies', () => {
  it('keeps the row pending, and a later answer is stored undelivered', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const row = await pendingRow(s)
    // The worker process goes away: its token is revoked and the call is aborted.
    s.rig.bridge.revokeAgent(s.worker.agentId)
    const dead = await call
    expect(dead.isError).toBe(true)
    expect(dead.value['error']).toBe('cancelled')
    expect(s.rig.rig.deps.attentionRepo.get(row.id)?.status).toBe('pending')
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)

    s.rig.rig.service.answerAttention(row.id, { approve: true })
    expect(s.rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({
      status: 'approved',
      delivered: false
    })
    expect(eventTexts(s)).toContain('Approved by you')
    expect(s.rig.rig.deps.attentionRepo.listUndelivered(s.sessionId).map((r) => r.id)).toEqual([
      row.id
    ])
  })
})

describe('auto-escalation', () => {
  it('passes a request the brain left alone to the user after the timeout', async () => {
    const s = await startWorker(150)
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Which?' })
    const row = await pendingRow(s)
    expect(s.rig.rig.deps.attentionRepo.get(row.id)?.escalated).toBe(false)
    await until(() => s.rig.rig.deps.attentionRepo.get(row.id)?.escalated === true)
    expect(s.rig.rig.deps.attentionRepo.get(row.id)?.brainNote).toBe(
      "The brain didn't answer in time."
    )
    expect(eventTexts(s)).toContain("Passed to you: the brain didn't answer in time")
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    s.rig.rig.service.answerAttention(row.id, { text: 'This one.' })
    await call
  })
})
