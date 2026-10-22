import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { BRAIN_DISALLOWED_TOOLS } from '../../../src/main/agents/claude-adapter'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { askUserTool } from '../../../src/main/bridge/tools/ask-user'
import { attentionView } from '../../../src/main/sessions/attention-service'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-attention-questions-')
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
}

async function startWorker(): Promise<Started> {
  e = await makeEngineRig(dir())
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
  return { rig: e, sessionId, workerId, worker }
}

const library = {
  question: 'Which library?',
  header: 'Library',
  options: [
    { label: 'axios', description: 'Popular' },
    { label: 'ky', description: 'Small' }
  ],
  multiSelect: false
}
const colors = {
  question: 'Pick colors',
  header: 'Colors',
  options: [
    { label: 'Red', description: 'r' },
    { label: 'Blue', description: 'b' }
  ],
  multiSelect: true
}

const ask = (
  s: Started,
  questions: unknown[],
  extra: Record<string, unknown> = {}
): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'AskUserQuestion',
    input: { questions },
    tool_use_id: 'toolu_q1',
    ...extra
  })

const pending = (s: Started): AttentionRequestRow[] =>
  s.rig.rig.deps.attentionRepo.listPending(s.sessionId)

async function pendingRow(s: Started): Promise<AttentionRequestRow> {
  await until(() => pending(s).length >= 1)
  return pending(s)[0] as AttentionRequestRow
}

const answerAttention = (
  s: Started,
  id: string,
  answer: Parameters<Started['rig']['rig']['service']['answerAttention']>[1]
): void => s.rig.rig.service.answerAttention(id, answer)

describe('AskUserQuestion from a worker', () => {
  it('bypasses Auto-approve and allow rules, escalates to the user with questions[] and has_question', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    s.rig.rig.deps.allowRulesRepo.create({
      id: 'rule1',
      sessionId: s.sessionId,
      category: 'leaves_machine',
      tool: 'AskUserQuestion',
      prefix: '',
      folder: null,
      text: 'anything',
      createdAt: 1
    })
    const brainSent = s.rig.brain().sent.length
    const call = ask(s, [library])
    const row = await pendingRow(s)
    expect(row).toMatchObject({
      source: 'worker',
      kind: 'question',
      toolName: 'AskUserQuestion',
      question: 'Which library?',
      mustEscalate: true,
      escalated: true
    })
    expect(
      s.rig.rig.eventsRepo
        .latest(s.sessionId, 50)
        .some(
          (x) => x.text.startsWith('Auto-approved') || x.text.startsWith('Allowed by your rule')
        )
    ).toBe(false)
    expect(s.rig.rig.deps.workersRepo.get(s.workerId)?.status).toBe('has_question')
    const state = s.rig.rig.service.attentionState(s.sessionId)
    expect(state.count).toBe(1)
    const view = attentionView(state.requests[0] as AttentionRequestRow, {
      number: 1,
      slug: 'api-retry',
      dependsOnJson: '[]'
    })
    expect(view).toMatchObject({ kind: 'question', from: 'W1 api-retry', questions: [library] })

    // The brain is told once, and cannot answer it.
    await until(() => s.rig.brain().sent.length > brainSent)
    expect(s.rig.brain().sent.at(-1)).toBe(
      '[Arc] W1 api-retry asks the user a question. Arc passed it to the user; you cannot answer it.'
    )
    const resolved = await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'answer',
      answer: 'axios'
    })
    expect(resolved.value['error']).toBe('not_resolvable')
    expect(pending(s)).toHaveLength(1)

    answerAttention(s, row.id, { answers: { 'Which library?': ['ky'] } })
    await call
  })

  it('returns a single choice as the label in updatedInput.answers', async () => {
    const s = await startWorker()
    const call = ask(s, [library])
    const row = await pendingRow(s)
    answerAttention(s, row.id, { answers: { 'Which library?': ['axios'] } })
    expect((await call).value).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [library], answers: { 'Which library?': 'axios' } }
    })
    expect(s.rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({
      status: 'answered',
      delivered: true
    })
    expect(s.rig.rig.deps.workersRepo.get(s.workerId)?.status).toBe('working')
  })

  it('returns a typed answer verbatim', async () => {
    const s = await startWorker()
    const call = ask(s, [library])
    const row = await pendingRow(s)
    answerAttention(s, row.id, { answers: { 'Which library?': ['  node:http with retries '] } })
    expect((await call).value).toMatchObject({
      updatedInput: { answers: { 'Which library?': 'node:http with retries' } }
    })
  })

  it('joins a multi-select answer with ", "', async () => {
    const s = await startWorker()
    const call = ask(s, [colors])
    const row = await pendingRow(s)
    answerAttention(s, row.id, { answers: { 'Pick colors': ['Red', 'Blue'] } })
    expect((await call).value).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Pick colors': 'Red, Blue' } }
    })
  })

  it('answers several questions of one call together in one answers object', async () => {
    const s = await startWorker()
    const size = {
      ...library,
      question: 'Pick a size',
      header: 'Size',
      options: [{ label: 'Large' }]
    }
    const call = ask(s, [colors, size])
    const row = await pendingRow(s)
    expect(row.question).toBe('Pick colors / Pick a size')
    answerAttention(s, row.id, {
      answers: { 'Pick colors': ['Red', 'Blue'], 'Pick a size': ['Large'] }
    })
    expect((await call).value).toMatchObject({
      updatedInput: { answers: { 'Pick colors': 'Red, Blue', 'Pick a size': 'Large' } }
    })
  })

  it('rejects answers that do not fit the questions and stays pending', async () => {
    const s = await startWorker()
    const call = ask(s, [library, colors])
    const row = await pendingRow(s)
    const bad: Record<string, string[]>[] = [
      { 'Which library?': ['ky'] },
      { 'Which library?': ['ky', 'axios'], 'Pick colors': ['Red'] },
      { 'Which library?': ['ky'], 'Pick colors': [' '] },
      { 'Which library?': ['ky'], 'Pick colors': ['Red'], Other: ['x'] }
    ]
    for (const answers of bad) expect(() => answerAttention(s, row.id, { answers })).toThrow()
    expect(() => answerAttention(s, row.id, { text: 'ky' })).toThrow()
    expect(() => answerAttention(s, row.id, { approve: true })).toThrow()
    expect(pending(s)).toHaveLength(1)
    answerAttention(s, row.id, { answers: { 'Which library?': ['ky'], 'Pick colors': ['Red'] } })
    await call
  })

  it('returns a deny with "The user declined to answer." on decline', async () => {
    const s = await startWorker()
    const call = ask(s, [library])
    const row = await pendingRow(s)
    answerAttention(s, row.id, { decline: true })
    expect((await call).value).toEqual({
      behavior: 'deny',
      message: 'The user declined to answer.'
    })
    expect(s.rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({ status: 'denied' })
    expect(s.rig.rig.deps.workersRepo.get(s.workerId)?.status).toBe('working')
  })

  it('denies a call without a readable question and creates no row', async () => {
    const s = await startWorker()
    const out = await ask(s, [])
    expect(out.value).toEqual({ behavior: 'deny', message: 'The question could not be read.' })
    expect(pending(s)).toEqual([])
  })

  it('labels a helper-originated question "(helper)"', async () => {
    const s = await startWorker()
    const call = ask(s, [library])
    const row = await pendingRow(s)
    const view = attentionView(
      { ...row, reason: 'helper' },
      {
        number: 1,
        slug: 'api-retry',
        dependsOnJson: '[]'
      }
    )
    expect(view.from).toBe('W1 api-retry (helper)')
    answerAttention(s, row.id, { decline: true })
    await call
  })

  it('persists as a row the renderer reads again after a reload', async () => {
    const s = await startWorker()
    const call = ask(s, [library])
    const row = await pendingRow(s)
    const snap = s.rig.rig.service.snapshot(s.sessionId)
    expect(snap.attention).toMatchObject([{ id: row.id, kind: 'question', questions: [library] }])
    answerAttention(s, row.id, { decline: true })
    await call
  })
})

describe('ask_user with choices', () => {
  it('stores one single-select question and returns the chosen label', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.rig.brain(), 'ask_user', {
      question: 'Which repository?',
      choices: ['api', 'web']
    })
    const row = await pendingRow(s)
    expect(row).toMatchObject({ source: 'brain', kind: 'question', question: 'Which repository?' })
    const view = attentionView(row, undefined)
    expect(view).toMatchObject({
      kind: 'question',
      from: 'Brain',
      questions: [
        {
          question: 'Which repository?',
          options: [{ label: 'api' }, { label: 'web' }],
          multiSelect: false
        }
      ]
    })
    answerAttention(s, row.id, { answers: { 'Which repository?': ['web'] } })
    expect((await call).value).toEqual({ answer: 'web' })
  })

  it('returns typed text for the free-text box, and still takes a plain text answer', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.rig.brain(), 'ask_user', { question: 'Which?', choices: ['a', 'b'] })
    const row = await pendingRow(s)
    answerAttention(s, row.id, { answers: { 'Which?': ['neither, use c'] } })
    expect((await call).value).toEqual({ answer: 'neither, use c' })
    const plain = s.rig.call(s.rig.brain(), 'ask_user', { question: 'Why?' })
    await until(() => pending(s).length === 1)
    expect(attentionView(pending(s)[0] as AttentionRequestRow, undefined)).not.toHaveProperty(
      'questions'
    )
    answerAttention(s, (pending(s)[0] as AttentionRequestRow).id, { text: 'Because.' })
    expect((await plain).value).toEqual({ answer: 'Because.' })
  })
})

describe('contracts', () => {
  it('ask_user accepts 2 to 6 choices only', () => {
    const schema = z.object(askUserTool.inputShape)
    expect(schema.safeParse({ question: 'x' }).success).toBe(true)
    expect(schema.safeParse({ question: 'x', choices: ['a', 'b'] }).success).toBe(true)
    expect(schema.safeParse({ question: 'x', choices: ['a'] }).success).toBe(false)
    expect(
      schema.safeParse({ question: 'x', choices: ['1', '2', '3', '4', '5', '6', '7'] }).success
    ).toBe(false)
  })

  it('keeps AskUserQuestion out of the brain tools', () => {
    expect(BRAIN_DISALLOWED_TOOLS.split(' ')).toContain('AskUserQuestion')
  })

  it('validates the structured and decline shapes of attention:answer', () => {
    const schema = channelSchemas['attention:answer']
    expect(schema.safeParse({ requestId: 'r', answers: { Q: ['a', 'b'] } }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r', answers: { Q: [] } }).success).toBe(false)
    expect(schema.safeParse({ requestId: 'r', answers: { Q: ['a'] }, text: 'x' }).success).toBe(
      false
    )
    expect(schema.safeParse({ requestId: 'r', decline: true }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r', decline: false }).success).toBe(false)
  })
})
