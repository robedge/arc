import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import {
  AttentionCoordinator,
  BRAIN_ANSWER_TIMEOUT_MS
} from '../../../src/main/sessions/attention-coordinator'
import type { AttentionHost } from '../../../src/main/sessions/attention-coordinator'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-attention-timer-')
const agent = { sessionId: '', agentId: 'worker-w1', role: 'worker' as const }

let rig: Rig
let repo: AttentionRepo
let sessionId: string
let host: AttentionHost
let coordinator: AttentionCoordinator
const events: { text: string; workerId: string | null | undefined }[] = []
const notes: string[] = []
const changed = vi.fn()
const statuses: string[] = []

beforeEach(async () => {
  vi.useFakeTimers()
  rig = await makeRig(dir())
  const created = await rig.service.create(rig.groupId, 'Do the thing', 'autonomous', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  sessionId = created.sessionId
  agent.sessionId = sessionId
  rig.deps.workersRepo.insert({
    id: 'w1',
    sessionId,
    number: 1,
    slug: 'api-retry',
    task: 't',
    projectIdsJson: '[]',
    model: 'sonnet',
    status: 'working',
    activity: null,
    failureReason: null,
    summary: null,
    providerSessionId: null,
    planId: null,
    dependsOnJson: '[]',
    stoppedBy: null,
    createdAt: 1,
    updatedAt: 1
  })
  repo = new AttentionRepo(rig.opened.db)
  events.length = 0
  notes.length = 0
  statuses.length = 0
  changed.mockClear()
  let n = 0
  host = {
    sessionId,
    now: () => Date.now(),
    newId: () => `R${(n += 1)}`,
    logEvent: (_kind, text, _data, workerId) => events.push({ text, workerId }),
    notifyBrain: (text) => notes.push(text),
    workerOf: () => ({ id: 'w1', number: 1, slug: 'api-retry' }),
    workerLabel: () => 'W1 api-retry',
    policyContext: () => ({ worktreeRoots: [dir()], readOnlyDirs: [] }),
    setWorkerStatus: (_id, status) => statuses.push(status),
    isControlled: () => false,
    onBrainWaiting: () => undefined,
    onChanged: changed,
    autoApprove: () => false,
    allowRules: () => [],
    addAllowRule: () => {
      throw new Error('not used')
    }
  }
  coordinator = new AttentionCoordinator(repo, host)
})

afterEach(async () => {
  coordinator.releaseAll()
  vi.useRealTimers()
  await rig.service.shutdown()
  rig.close()
})

describe('auto-escalation after 60 s (fake timers)', () => {
  it('uses 60 seconds by default', () => {
    expect(BRAIN_ANSWER_TIMEOUT_MS).toBe(60_000)
  })

  it('passes a question the brain ignored to the user at exactly 60 s', async () => {
    const abort = new AbortController()
    const call = coordinator.askBrain(agent, { question: 'Which port?' }, abort.signal)
    expect(repo.get('R1')).toMatchObject({ escalated: false, status: 'pending' })
    expect(notes[0]).toContain('escalate_to_user')

    await vi.advanceTimersByTimeAsync(59_999)
    expect(repo.get('R1')?.escalated).toBe(false)
    expect(coordinator.state().count).toBe(0)
    changed.mockClear()

    await vi.advanceTimersByTimeAsync(1)
    expect(repo.get('R1')).toMatchObject({
      escalated: true,
      brainNote: "The brain didn't answer in time.",
      status: 'pending'
    })
    expect(events.at(-1)).toEqual({
      text: "Passed to you: the brain didn't answer in time",
      workerId: 'w1'
    })
    expect(coordinator.state().count).toBe(1)
    expect(changed).toHaveBeenCalledTimes(1)

    coordinator.answer('R1', { text: '8080' })
    await expect(call).resolves.toEqual({ answer: '8080' })
  })

  it('does not escalate a question the brain answered in time', async () => {
    const abort = new AbortController()
    const call = coordinator.askBrain(agent, { question: 'Which port?' }, abort.signal)
    await vi.advanceTimersByTimeAsync(30_000)
    coordinator.resolveRequest(
      { sessionId, agentId: 'brain-s', role: 'brain' },
      { requestId: 'R1', decision: 'answer', answer: '8080' }
    )
    await expect(call).resolves.toEqual({ answer: '8080' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(repo.get('R1')).toMatchObject({ escalated: false, status: 'answered' })
    expect(events.map((e) => e.text)).not.toContain(
      "Passed to you: the brain didn't answer in time"
    )
    expect(coordinator.state().count).toBe(0)
  })

  it('does not time a policy-escalated request, which is with the user from the start', async () => {
    const abort = new AbortController()
    const call = coordinator.requestPermission(
      agent,
      { tool_name: 'Bash', input: { command: 'git push' }, tool_use_id: 't2' },
      abort.signal
    )
    expect(repo.get('R1')).toMatchObject({ escalated: true, mustEscalate: true })
    expect(notes[0]).toContain('you cannot approve it')
    changed.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(changed).not.toHaveBeenCalled()
    expect(events.map((e) => e.text)).not.toContain(
      "Passed to you: the brain didn't answer in time"
    )
    coordinator.answer('R1', { approve: true })
    await call
  })

  it('still escalates after the call died, because the row is still pending', async () => {
    const abort = new AbortController()
    const call = coordinator.askBrain(agent, { question: 'Which?' }, abort.signal)
    abort.abort()
    await expect(call).rejects.toMatchObject({ code: 'cancelled' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(repo.get('R1')).toMatchObject({ escalated: true, status: 'pending' })
  })

  it('stops the timers when released', async () => {
    const abort = new AbortController()
    const call = coordinator.askBrain(agent, { question: 'q' }, abort.signal)
    coordinator.releaseAll()
    await expect(call).rejects.toMatchObject({ code: 'shutting_down' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(repo.get('R1')).toMatchObject({ escalated: false, status: 'pending' })
  })
})

describe('worker status while requests wait', () => {
  it('needs_approval for a permission, has_question for a question, working when the last one is answered', async () => {
    const abort = new AbortController()
    const permission = coordinator.requestPermission(
      agent,
      { tool_name: 'Bash', input: { command: 'git push' } },
      abort.signal
    )
    const question = coordinator.askBrain(agent, { question: 'Which?' }, abort.signal)
    expect(statuses).toEqual(['needs_approval', 'has_question'])

    coordinator.answer('R1', { approve: true })
    await permission
    // The question is still pending, so the worker now only has a question.
    expect(statuses.at(-1)).toBe('has_question')

    coordinator.answer('R2', { text: 'This.' })
    await question
    expect(statuses.at(-1)).toBe('working')
  })
})
