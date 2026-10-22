import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../../src/main/sessions/session-service'
import { readMcpConfig } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter } from './helpers'
import type { FakeHandle } from './helpers'
import { eventTexts, spawnWorker } from './merge-rig'
import type { DoneWorker } from './merge-rig'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-continue-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

async function start(): Promise<string> {
  e = await makeEngineRig(dir())
  return e.startSession('autonomous')
}

/** A worker that stored its Claude session id and is Working. */
async function workingWorker(name = 'api-retry', repo = 'api'): Promise<DoneWorker> {
  if (!e) throw new Error('rig')
  const w = await spawnWorker(e, name, repo, { [`${name}.txt`]: `${name}\n` })
  w.handle.emit({
    type: 'session',
    providerSessionId: `claude-${name}`,
    model: 'claude-sonnet-5-5',
    mcpServers: [{ name: 'arc', status: 'connected' }]
  })
  await until(() => e?.rig.deps.workersRepo.get(w.workerId)?.status === 'working')
  return w
}

/** Quits Arc and builds a new service over the same database, as a relaunch would. */
async function relaunch(): Promise<{ service: SessionService; adapter: FakeAdapter }> {
  if (!e) throw new Error('rig')
  await e.rig.service.shutdown()
  const adapter = new FakeAdapter()
  const service = new SessionService({ ...e.rig.deps, registry: claudeRegistry(adapter) })
  extra.push(service)
  return { service, adapter }
}

const worker = (id: string): ReturnType<EngineRig['rig']['deps']['workersRepo']['get']> =>
  e?.rig.deps.workersRepo.get(id)

describe('workers:continue', () => {
  it('respawns with --resume in the existing working copy and sends the continue prompt', async () => {
    const sessionId = await start()
    const w1 = await workingWorker()
    const oldConfig = e?.configOf(w1.handle)
    const { service, adapter } = await relaunch()
    expect(worker(w1.workerId)).toMatchObject({ status: 'stopped', stoppedBy: 'quit' })
    expect(existsSync(w1.treePath)).toBe(true)

    await service.continueWorker(w1.workerId)

    const started = adapter.starts[0]
    expect(started).toMatchObject({
      role: 'worker',
      agentId: `worker-${w1.workerId}`,
      cwd: w1.treePath,
      model: worker(w1.workerId)?.model,
      resume: { threadId: 'claude-api-retry' },
      claude: { permissionPromptTool: 'mcp__arc__request_permission' }
    })
    // A new bridge token for the new process.
    const newConfig = readMcpConfig(started?.claude.mcpConfigPath ?? '')
    expect(newConfig.headers).not.toEqual(oldConfig?.headers)
    const handle = adapter.handles[0] as FakeHandle
    expect(handle.sent).toEqual(['You were interrupted. Continue the task.'])
    expect(worker(w1.workerId)).toMatchObject({ status: 'starting', stoppedBy: null })

    handle.emit({
      type: 'session',
      providerSessionId: 'claude-api-retry',
      model: 'claude-sonnet-5-5',
      mcpServers: [{ name: 'arc', status: 'connected' }]
    })
    await until(() => worker(w1.workerId)?.status === 'working')
    expect(eventTexts(e as EngineRig, sessionId)).toContain('Continuing W1 api-retry')
  })

  it('continues every continuable worker with all, and skips the rest', async () => {
    const sessionId = await start()
    const w1 = await workingWorker('api-retry', 'api')
    const w2 = await workingWorker('web-docs', 'web')
    const { service, adapter } = await relaunch()
    // W2 was stopped by the user before: it has no working copy and is skipped.
    await e?.rig.deps.worktreesRepo.listByWorker(w2.workerId).forEach((t) => {
      e?.rig.deps.worktreesRepo.markRemoved(t.id, 1)
    })

    await service.continueAllWorkers(sessionId)

    expect(adapter.starts.map((s) => s.agentId)).toEqual([`worker-${w1.workerId}`])
  })

  it('refuses a worker the user stopped, with a reason', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    await e.rig.service.stopWorker(w1.workerId)
    expect(worker(w1.workerId)).toMatchObject({ status: 'stopped', stoppedBy: 'user' })

    await expect(e.rig.service.continueWorker(w1.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: expect.stringContaining('You stopped this worker') as unknown }
    })
  })

  it('refuses running, removed, finished and working-copy-less workers', async () => {
    await start()
    if (!e) throw new Error('rig')
    const running = await workingWorker('api-retry', 'api')
    await expect(e.rig.service.continueWorker(running.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'This worker is already running.' }
    })
    const { service } = await relaunch()
    // Stopped by quit, but its working copy was removed.
    for (const t of e.rig.deps.worktreesRepo.listByWorker(running.workerId)) {
      e.rig.deps.worktreesRepo.markRemoved(t.id, 1)
    }
    await expect(service.continueWorker(running.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: expect.stringContaining('working copy is gone') as unknown }
    })
    e.rig.deps.workersRepo.setStatus(running.workerId, 'done', 5)
    await expect(service.continueWorker(running.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: expect.stringContaining('done') as unknown }
    })
    e.rig.deps.workersRepo.markRemoved(running.workerId, 6)
    await expect(service.continueWorker(running.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(service.continueWorker('nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })

  it('starts over with the original task when no Claude session id was stored', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'api-retry', 'api')
    expect(worker(w1.workerId)?.providerSessionId).toBeNull()
    const { service, adapter } = await relaunch()

    await service.continueWorker(w1.workerId)

    expect(adapter.starts[0]?.resume?.threadId).toBeUndefined()
    expect(adapter.starts[0]?.cwd).toBe(w1.treePath)
    expect((adapter.handles[0] as FakeHandle).sent).toEqual(['Do api-retry'])
  })

  it('hands over answers that were never delivered after the continue prompt', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    const { service, adapter } = await relaunch()
    e.rig.deps.attentionRepo.create({
      id: 'r1',
      sessionId: worker(w1.workerId)?.sessionId ?? '',
      workerId: w1.workerId,
      source: 'worker',
      kind: 'question',
      action: null,
      reason: null,
      question: 'Which port?',
      toolName: null,
      toolInputJson: null,
      toolUseId: null,
      category: null,
      mustEscalate: false,
      escalated: true,
      brainNote: null,
      status: 'answered',
      answer: '8080',
      delivered: false,
      createdAt: 1,
      resolvedAt: 2
    })

    await service.continueWorker(w1.workerId)

    expect((adapter.handles[0] as FakeHandle).sent).toEqual([
      'You were interrupted. Continue the task.\n\nAnswer to your question: 8080'
    ])
    expect(e.rig.deps.attentionRepo.get('r1')?.delivered).toBe(true)
  })

  it('tells a resumed worker that its AskUserQuestion was cancelled when Arc closed', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    const { service, adapter } = await relaunch()
    e.rig.deps.attentionRepo.create({
      id: 'r2',
      sessionId: worker(w1.workerId)?.sessionId ?? '',
      workerId: w1.workerId,
      source: 'worker',
      kind: 'question',
      action: null,
      reason: null,
      question: 'Which library?',
      toolName: 'AskUserQuestion',
      toolInputJson: JSON.stringify({ questions: [] }),
      toolUseId: 'toolu_1',
      category: null,
      mustEscalate: true,
      escalated: true,
      brainNote: null,
      status: 'cancelled',
      answer: null,
      delivered: false,
      createdAt: 1,
      resolvedAt: 2
    })

    await service.continueWorker(w1.workerId)

    expect((adapter.handles[0] as FakeHandle).sent).toEqual([
      'You were interrupted. Continue the task.\n\nYour question was cancelled when Arc closed; ask it again if you still need the answer.'
    ])
    expect(e.rig.deps.attentionRepo.get('r2')?.delivered).toBe(true)
  })
})

describe('the Continue prompt', () => {
  it('is posted once per occurrence and Not now only marks it answered', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker('api-retry', 'api')
    const w2 = await workingWorker('web-docs', 'web')
    const { service } = await relaunch()

    const snap = async (): Promise<{ content: string; id: number; prompt?: unknown }[]> => {
      const opened = await service.open(sessionId)
      if (!('messages' in opened)) throw new Error('expected a snapshot')
      return opened.messages.filter((m) => m.prompt !== undefined)
    }

    const first = await snap()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      content: '2 workers were stopped when Arc closed. Continue them?',
      prompt: { kind: 'continue-workers', status: 'open' }
    })
    const ids = (first[0]?.prompt as { workerIds: string[] }).workerIds
    expect([...ids].sort()).toEqual([w1.workerId, w2.workerId].sort())
    // Opening again does not post it again.
    expect(await snap()).toHaveLength(1)

    service.dismissPrompt(sessionId, first[0]?.id ?? 0)
    const dismissed = await snap()
    expect(dismissed).toHaveLength(1)
    expect(dismissed[0]?.prompt).toMatchObject({ status: 'dismissed' })
    // Not now leaves the workers Stopped and continuable from their cards.
    expect(worker(w1.workerId)?.status).toBe('stopped')
    expect(() => service.dismissPrompt(sessionId, first[0]?.id ?? 0)).toThrow()

    // Stopped again later (a new quit or crash): a new occurrence, so it asks again.
    e.rig.clock.now += 10_000
    e.rig.deps.workersRepo.setStatus(w1.workerId, 'stopped', e.rig.clock.now, 'crash')
    e.rig.clock.now += 10_000
    const again = await snap()
    expect(again).toHaveLength(2)
    expect(again[1]).toMatchObject({
      content: '1 worker was stopped when Arc closed. Continue it?',
      prompt: { status: 'open' }
    })
  })

  it('Continue starts the workers and the prompt becomes continued', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    const { service, adapter } = await relaunch()
    const opened = await service.open(sessionId)
    if (!('messages' in opened)) throw new Error('expected a snapshot')
    expect(opened.messages.at(-1)?.content).toBe(
      '1 worker was stopped when Arc closed. Continue it?'
    )

    await service.continueAllWorkers(sessionId)
    expect(adapter.starts).toHaveLength(1)
    const pushed = e.rig.of('session:message').filter((m) => m.message.prompt !== undefined)
    expect(pushed.at(-1)?.message.prompt).toMatchObject({ status: 'continued' })
    expect(worker(w1.workerId)?.status).toBe('starting')
  })

  it('is not posted when nothing can be continued', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    await e.rig.service.stopWorker(w1.workerId)
    const { service } = await relaunch()
    const opened = await service.open(sessionId)
    if (!('messages' in opened)) throw new Error('expected a snapshot')
    expect(opened.messages.some((m) => m.prompt !== undefined)).toBe(false)
  })
})

describe('requests answered after a restart', () => {
  it('resumes the worker with the approval as a user turn and marks it delivered', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    void e.call(w1.handle, 'request_permission', {
      tool_name: 'Bash',
      input: { command: 'git push origin arc/retry-work' },
      tool_use_id: 'toolu_1'
    })
    await until(() => e?.rig.deps.attentionRepo.listPending(sessionId).length === 1)
    const requestId = e.rig.deps.attentionRepo.listPending(sessionId)[0]?.id ?? ''
    await until(() => worker(w1.workerId)?.status === 'needs_approval')

    const { service, adapter } = await relaunch()
    // Still paused after the restart: no process, no change of status.
    expect(worker(w1.workerId)?.status).toBe('needs_approval')
    expect(adapter.starts).toHaveLength(0)

    service.answerAttention(requestId, { approve: true })

    await until(() => adapter.handles.length === 1)
    expect(adapter.starts[0]).toMatchObject({
      cwd: w1.treePath,
      resume: { threadId: 'claude-api-retry' }
    })
    expect((adapter.handles[0] as FakeHandle).sent).toEqual([
      "Your earlier request 'git push origin arc/retry-work' was approved: you may go ahead."
    ])
    await until(() => e?.rig.deps.attentionRepo.get(requestId)?.delivered === true)
    expect(e.rig.deps.attentionRepo.get(requestId)).toMatchObject({ status: 'approved' })
    expect(worker(w1.workerId)?.status).toBe('starting')
  })

  it('delivers a denial with its reason, and an answer to a question', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    void e.call(w1.handle, 'ask_brain', { question: 'Which port?' })
    await until(() => e?.rig.deps.attentionRepo.listPending(sessionId).length === 1)
    const requestId = e.rig.deps.attentionRepo.listPending(sessionId)[0]?.id ?? ''
    const { service, adapter } = await relaunch()

    service.answerAttention(requestId, { text: 'Use 8080.' })

    await until(() => adapter.handles.length === 1)
    expect((adapter.handles[0] as FakeHandle).sent).toEqual(['Answer to your question: Use 8080.'])
    await until(() => e?.rig.deps.attentionRepo.get(requestId)?.delivered === true)
  })

  it('keeps the worker stopped, with the answer stored, when its working copy is gone', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    void e.call(w1.handle, 'ask_brain', { question: 'Which port?' })
    await until(() => e?.rig.deps.attentionRepo.listPending(sessionId).length === 1)
    const requestId = e.rig.deps.attentionRepo.listPending(sessionId)[0]?.id ?? ''
    const { service, adapter } = await relaunch()
    for (const t of e.rig.deps.worktreesRepo.listByWorker(w1.workerId)) {
      e.rig.deps.worktreesRepo.markRemoved(t.id, 1)
    }

    service.answerAttention(requestId, { text: 'Use 8080.' })

    expect(adapter.starts).toHaveLength(0)
    expect(worker(w1.workerId)).toMatchObject({ status: 'stopped', stoppedBy: 'quit' })
    expect(e.rig.deps.attentionRepo.get(requestId)?.delivered).toBe(false)
  })

  it('resumes the brain with the answer to ask_user as its next user message', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    void e.call(e.brain(), 'ask_user', { question: 'Should the retry count be configurable?' })
    await until(() => e?.rig.deps.attentionRepo.listPending(sessionId).length === 1)
    const requestId = e.rig.deps.attentionRepo.listPending(sessionId)[0]?.id ?? ''
    const { service, adapter } = await relaunch()

    service.answerAttention(requestId, { text: 'Yes, make it configurable.' })

    await until(() => adapter.handles.length === 1)
    expect(adapter.starts[0]).toMatchObject({
      role: 'brain',
      resume: { threadId: 'brain-claude-1' }
    })
    expect((adapter.handles[0] as FakeHandle).sent).toEqual([
      'Answer to your question: Yes, make it configurable.'
    ])
    await until(() => e?.rig.deps.attentionRepo.get(requestId)?.delivered === true)
  })
})

describe('usage limit', () => {
  const rateLimited = (h: FakeHandle, resetsAt?: number): void => {
    h.emit({
      type: 'rate-limit',
      status: 'rejected',
      ...(resetsAt === undefined ? {} : { resetsAt })
    })
    h.emit({ type: 'error', kind: 'rate-limit', message: 'Usage limit reached' })
    h.emit({ type: 'turn-result', ok: false, interrupted: false, durationMs: 1 })
  }

  /** Lets queued microtasks and fake timers run. */
  const settle = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('shows Waiting for limit, pauses the queue, and retries once with Continue.', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    const resetsAt = (e.rig.clock.now + 120_000) / 1000
    const sent0 = w1.handle.sent.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    rateLimited(w1.handle, resetsAt)
    await settle(50)

    expect(worker(w1.workerId)).toMatchObject({ status: 'working', activity: 'Waiting for limit' })
    expect(
      eventTexts(e, sessionId).some((t) =>
        t.startsWith('Waiting for the Claude usage limit (resets ')
      )
    ).toBe(true)
    // Not failed, not nudged about report_done, not signed out.
    expect(w1.handle.sent.slice(sent0)).toEqual([])
    expect(e.rig.signedOut).not.toHaveBeenCalled()

    // The queue is paused: a new worker waits even though the limit has room.
    const started = await e.call(e.brain(), 'spawn_worker', {
      name: 'docs',
      task: 'Do docs',
      repos: ['web']
    })
    expect(started.value['status']).toBe('queued')
    expect(eventTexts(e, sessionId)).toContain('W2 docs queued: waiting for the Claude usage limit')
    expect(worker(String(started.value['workerId']))?.activity).toBe('Waiting for Claude limit')
    expect(e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(1)

    // The limit event and the error for the same wait made one retry, not two.
    await settle(60_000)
    expect(w1.handle.sent.slice(sent0)).toEqual([])

    await settle(70_000)
    expect(w1.handle.sent.slice(sent0)).toEqual(['Continue.'])
    expect(worker(w1.workerId)?.activity).toBe('Working')
    // The paused queue starts the waiting worker.
    await vi.waitFor(() =>
      expect(e?.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(2)
    )

    // No retry loop on its own.
    await settle(30 * 60_000)
    expect(w1.handle.sent.slice(sent0)).toEqual(['Continue.'])
  })

  it('resumes a worker whose process ended while it waited, with --resume and Continue.', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await workingWorker()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const before = e.rig.adapter.starts.length

    w1.handle.emit({ type: 'error', kind: 'rate-limit', message: 'Usage limit reached' })
    w1.handle.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: '429' })
    await settle(50)

    // Still Working while it waits; not failed.
    expect(worker(w1.workerId)).toMatchObject({ status: 'working', activity: 'Waiting for limit' })
    expect(e.rig.adapter.starts).toHaveLength(before)

    await settle(5 * 60_000 + 10)
    await vi.waitFor(() => expect(e?.rig.adapter.starts).toHaveLength(before + 1))
    const resumed = e.rig.adapter.starts[before]
    expect(resumed).toMatchObject({ resume: { threadId: 'claude-api-retry' }, cwd: w1.treePath })
    expect((e.rig.adapter.handles[before] as FakeHandle).sent).toEqual(['Continue.'])

    await settle(60 * 60_000)
    expect(e.rig.adapter.starts).toHaveLength(before + 1)
  })

  it('sends Continue. to the brain after the wait', async () => {
    await start()
    if (!e) throw new Error('rig')
    const brain = e.brain()
    const sent = brain.sent.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    rateLimited(brain)
    rateLimited(brain)
    await settle(50)
    expect(brain.sent).toHaveLength(sent)
    await settle(5 * 60_000 + 10)

    expect(brain.sent.slice(sent)).toEqual(['Continue.'])
    expect(e.rig.signedOut).not.toHaveBeenCalled()
  })

  it('a brain turn that completes ends the wait: no stray Continue.', async () => {
    await start()
    if (!e) throw new Error('rig')
    const brain = e.brain()
    const sent = brain.sent.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    rateLimited(brain)
    await settle(50)
    brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await settle(5 * 60_000 + 10)

    expect(brain.sent).toHaveLength(sent)
  })

  it('switching the brain model drops its wait and starts the workers it held', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const brain = e.brain()
    const sent = brain.sent.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    rateLimited(brain)
    await settle(50)
    const held = await e.call(e.brain(), 'spawn_worker', {
      name: 'docs',
      task: 'Do docs',
      repos: ['web']
    })
    expect(held.value['status']).toBe('queued')

    e.rig.service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'opus' } })
    await vi.waitFor(() =>
      expect(e?.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(1)
    )
    await settle(5 * 60_000 + 10)
    expect(brain.sent.slice(sent)).not.toContain('Continue.')
  })

  it('a plan refusal is not a usage limit: the brain says so and does not wait', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const brain = e.brain()
    const sent = brain.sent.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    brain.emit({ type: 'error', kind: 'plan-refused', message: 'Upgrade your plan to continue' })
    brain.emit({ type: 'turn-result', ok: false, interrupted: false, durationMs: 1 })
    await settle(50)

    expect(
      eventTexts(e, sessionId).some((t) =>
        /^Claude refused .+: it isn't on your Claude plan\. Choose another model\.$/.test(t)
      )
    ).toBe(true)
    expect(eventTexts(e, sessionId).some((t) => t.includes('usage limit'))).toBe(false)
    await settle(5 * 60_000 + 10)
    expect(brain.sent).toHaveLength(sent)
  })
})
