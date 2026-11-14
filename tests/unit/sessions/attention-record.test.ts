import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { recordSubject, requestRecord } from '../../../src/main/sessions/attention-record'
import { recordText } from '../../../src/shared/attention-record'
import type { AttentionRecordPrompt } from '../../../src/shared/types/session'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-attention-record-')
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

const permission = (s: Started, command: string): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'Bash',
    input: { command, description: 'x' },
    tool_use_id: 'toolu_1'
  })

const questionOf = (question: string, options: string[], multiSelect = false) => ({
  question,
  header: 'Q',
  options: options.map((label) => ({ label, description: '' })),
  multiSelect
})

const askCommandQuestions = (s: Started, questions: unknown[]): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'AskUserQuestion',
    input: { questions },
    tool_use_id: 'toolu_q1'
  })

const pending = (s: Started): AttentionRequestRow[] =>
  s.rig.rig.deps.attentionRepo.listPending(s.sessionId)

async function pendingRows(s: Started, count: number): Promise<AttentionRequestRow[]> {
  await until(() => pending(s).length >= count)
  return pending(s)
}

const answer = (
  s: Started,
  id: string,
  a: Parameters<typeof s.rig.rig.service.answerAttention>[1]
) => s.rig.rig.service.answerAttention(id, a)

/** The system messages that are records, oldest first, as stored. */
function records(s: Started): { content: string; prompt: AttentionRecordPrompt | null }[] {
  return s.rig.rig.messagesRepo
    .latest(s.sessionId, 100)
    .filter((m) => m.promptJson?.includes('attention-record'))
    .map((m) => {
      expect(m.role).toBe('system')
      return {
        content: m.content,
        prompt: m.promptJson ? (JSON.parse(m.promptJson) as AttentionRecordPrompt) : null
      }
    })
}

/** The record stored for the one answer just given, checked against `recordText`. */
function onlyRecord(s: Started, prompt: AttentionRecordPrompt): void {
  expect(records(s)).toEqual([{ content: recordText(prompt), prompt }])
}

describe('a record for each answer given in a panel', () => {
  it('approve: "Approved: <command> (W1 api-retry)"', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/fix-order-sync')
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { approve: true })
    await call
    onlyRecord(s, {
      kind: 'attention-record',
      decision: 'approved',
      subject: 'git push origin arc/fix-order-sync',
      from: 'W1 api-retry'
    })
    expect(records(s)[0]?.content).toBe(
      'Approved: git push origin arc/fix-order-sync (W1 api-retry)'
    )
  })

  it('deny: "Denied: <command> (W1 api-retry)"', async () => {
    const s = await startWorker()
    const call = permission(s, 'brew install jq')
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { approve: false })
    await call
    onlyRecord(s, {
      kind: 'attention-record',
      decision: 'denied',
      subject: 'brew install jq',
      from: 'W1 api-retry'
    })
  })

  it('always: one "Always allowed in this session" record', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin a')
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { approve: true, always: true })
    await call
    onlyRecord(s, {
      kind: 'attention-record',
      decision: 'always',
      subject: 'git push origin a',
      from: 'W1 api-retry'
    })
    expect(records(s)[0]?.content).toBe(
      'Always allowed in this session: git push origin a (W1 api-retry)'
    )
  })

  it('text: the brain\'s question, "Answered: <question> → <text> (Brain)"', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.rig.brain(), 'ask_user', { question: 'Which repository?' })
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { text: '  web ' })
    await call
    onlyRecord(s, {
      kind: 'attention-record',
      decision: 'answered',
      subject: 'Which repository?',
      answer: 'web',
      from: 'Brain'
    })
    expect(records(s)[0]?.content).toBe('Answered: Which repository? → web (Brain)')
  })

  it("choices: the pick of the brain's question with choices", async () => {
    const s = await startWorker()
    const call = s.rig.call(s.rig.brain(), 'ask_user', {
      question: 'Which repository?',
      choices: ['api', 'web']
    })
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { answers: { 'Which repository?': ['web'] } })
    await call
    expect(records(s).map((r) => r.content)).toEqual(['Answered: Which repository? → web (Brain)'])
  })

  it('choices: several questions say "and N more" and join the answers', async () => {
    const s = await startWorker()
    const call = askCommandQuestions(s, [
      questionOf('Pick colors', ['Red', 'Blue', 'Green'], true),
      questionOf('Which library?', ['axios', 'ky'])
    ])
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', {
      answers: { 'Pick colors': ['Red', 'Blue'], 'Which library?': ['ky'] }
    })
    await call
    onlyRecord(s, {
      kind: 'attention-record',
      decision: 'answered',
      subject: 'Pick colors and 1 more',
      answer: 'Red, Blue; ky',
      from: 'W1 api-retry'
    })
  })

  it('decline: "Declined: <question> (W1 api-retry)"', async () => {
    const s = await startWorker()
    const call = askCommandQuestions(s, [questionOf('Which library?', ['axios', 'ky'])])
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { decline: true })
    await call
    onlyRecord(s, {
      kind: 'attention-record',
      decision: 'declined',
      subject: 'Which library?',
      from: 'W1 api-retry'
    })
  })

  it('a worker question the brain passed on says "via brain" like its panel', async () => {
    const s = await startWorker()
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Use Redis?' })
    const [row] = await pendingRows(s, 1)
    await s.rig.call(s.rig.brain(), 'escalate_to_user', {
      requestId: row?.id,
      reason: 'You decide.'
    })
    answer(s, row?.id ?? '', { text: 'No.' })
    await call
    expect(records(s).map((r) => r.content)).toEqual([
      'Answered: Use Redis? → No. (W1 api-retry · via brain)'
    ])
  })
})

describe('no record when the user did not answer in a panel', () => {
  it("an answer in the stepped-in worker's terminal (the terminal route)", async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingRows(s, 1)
    await s.rig.rig.service.stepInWorker(s.workerId)
    expect(s.rig.rig.deps.attentionRepo.get(row?.id ?? '')).toMatchObject({ route: 'terminal' })
    answer(s, row?.id ?? '', { approve: true })
    await call
    expect(records(s)).toEqual([])
  })

  it("the brain's resolve_request", async () => {
    const s = await startWorker()
    const call = s.rig.call(s.worker, 'ask_brain', { question: 'Which port?' })
    const [row] = await pendingRows(s, 1)
    await s.rig.call(s.rig.brain(), 'resolve_request', {
      requestId: row?.id,
      decision: 'answer',
      answer: '8080'
    })
    await call
    expect(records(s)).toEqual([])
  })

  it('auto-approval', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    await permission(s, 'brew install jq')
    expect(records(s)).toEqual([])
  })

  it('an answer that fails because the request is no longer pending', async () => {
    const s = await startWorker()
    const call = permission(s, 'brew install jq')
    const [row] = await pendingRows(s, 1)
    answer(s, row?.id ?? '', { approve: false })
    await call
    expect(records(s)).toHaveLength(1)
    expect(() => answer(s, row?.id ?? '', { approve: true })).toThrow()
    expect(() => answer(s, 'no-such-request', { approve: true })).toThrow()
    expect(records(s)).toHaveLength(1)
  })

  it('an answer that is refused (always on a denial, a decline of a command)', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin a')
    const [row] = await pendingRows(s, 1)
    expect(() => answer(s, row?.id ?? '', { approve: false, always: true })).toThrow()
    expect(() => answer(s, row?.id ?? '', { decline: true })).toThrow()
    expect(records(s)).toEqual([])
    answer(s, row?.id ?? '', { approve: false })
    await call
  })

  it('the other requests an "always" answer clears: one record, for the answered one', async () => {
    const s = await startWorker()
    const calls = [
      permission(s, 'git push origin a'),
      permission(s, 'git push origin b'),
      permission(s, 'git push origin c')
    ]
    const rows = await pendingRows(s, 3)
    const first = rows.find((r) => r.action === 'git push origin a')
    answer(s, first?.id ?? '', { approve: true, always: true })
    await Promise.all(calls)
    expect(pending(s)).toEqual([])
    expect(records(s).map((r) => r.content)).toEqual([
      'Always allowed in this session: git push origin a (W1 api-retry)'
    ])
  })
})

describe('the subject of a record', () => {
  const row = (over: Partial<AttentionRequestRow>): AttentionRequestRow =>
    ({
      id: 'r',
      source: 'worker',
      kind: 'permission',
      action: 'x',
      mustEscalate: true,
      reason: null,
      question: null,
      toolName: null,
      toolInputJson: null,
      ...over
    }) as AttentionRequestRow

  it('is the action of a command', () => {
    expect(recordSubject(row({ toolName: 'Bash', action: 'rm -rf build' }))).toBe('rm -rf build')
  })

  it('is "<server> · <tool>" for a tool of a connected server, keeping `_` in the server', () => {
    expect(
      recordSubject(row({ toolName: 'mcp__claude_ai_Figma__use_figma', toolInputJson: '{}' }))
    ).toBe('claude_ai_Figma · use_figma')
  })

  it('is "more access" plus the reason when there is one', () => {
    const access = (reason: unknown): AttentionRequestRow =>
      row({
        toolName: 'CodexPermissions',
        toolInputJson: JSON.stringify({ reason, network: true })
      })
    expect(recordSubject(access('write the build output'))).toBe(
      'more access: write the build output'
    )
    expect(recordSubject(access(undefined))).toBe('more access')
  })

  it('is the question, or the first question and "and N more"', () => {
    expect(recordSubject(row({ kind: 'question', question: 'Which port?' }))).toBe('Which port?')
    const input = (n: number): string =>
      JSON.stringify({
        questions: Array.from({ length: n }, (_, i) => questionOf(`Q${i + 1}?`, ['a']))
      })
    expect(recordSubject(row({ kind: 'question', question: 'x', toolInputJson: input(1) }))).toBe(
      'Q1?'
    )
    expect(recordSubject(row({ kind: 'question', question: 'x', toolInputJson: input(3) }))).toBe(
      'Q1? and 2 more'
    )
  })

  it('keeps a long command whole', () => {
    const command = `echo ${'y'.repeat(300)}`
    expect(recordSubject(row({ toolName: 'Bash', action: command }))).toBe(command)
  })

  it('carries the same "from" as the panel, including the helper suffix', () => {
    expect(requestRecord(row({ mustEscalate: false }), 'W2 web-fix', 'approved').from).toBe(
      'W2 web-fix · via brain'
    )
    expect(requestRecord(row({ source: 'brain' }), 'A worker', 'approved').from).toBe('Brain')
    expect(
      requestRecord(row({ kind: 'question', reason: 'helper' }), 'W1 a', 'declined').from
    ).toBe('W1 a (helper)')
  })
})
