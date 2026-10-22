import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderHistoryMissingError } from '../../../src/main/agents/agent-adapter'
import {
  APPROVAL_WITHDRAWN,
  type CodexApprovalRequest
} from '../../../src/main/agents/codex/codex-types'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { SessionService } from '../../../src/main/sessions/session-service'
import { CODEX_SLASH_LINE, typedSlashName } from '../../../src/main/sessions/typed-slash'
import { HAND_BACK_TEXT } from '../../../src/main/sessions/worker-manager'
import type { ProviderStatus, ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter, FakeCodexAdapter } from './helpers'
import type { FakeHandle } from './helpers'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-codex-step-in-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

interface Started {
  e: EngineRig
  codex: FakeCodexAdapter
  sessionId: string
  workerId: string
  worker: FakeHandle
}

const codexStatus = (): ProviderStatusMap => ({
  codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 1 } as ProviderStatus
})

/** A session pinned to Codex, with one Codex worker that is Working on thread `thread-5`. */
async function codexWorker(): Promise<Started> {
  const codex = new FakeCodexAdapter()
  const models = new ModelRegistry({
    codex: {
      listModels: () =>
        Promise.resolve([{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }])
    },
    status: codexStatus
  })
  e = await makeEngineRig(dir(), {
    codexAdapter: codex,
    models,
    providers: { get: codexStatus, ensureFresh: () => Promise.resolve(codexStatus().codex) }
  })
  const sessionId = await e.startSession('autonomous')
  e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'api-retry',
    task: 'Add retries',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  await until(() => codex.handles.length === 1)
  const worker = codex.handles[0] as FakeHandle
  worker.emit({ type: 'session', providerSessionId: 'thread-5', model: 'gpt-deep', mcpServers: [] })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { e, codex, sessionId, workerId, worker }
}

const row = (s: Started): ReturnType<EngineRig['rig']['deps']['workersRepo']['get']> =>
  s.e.rig.deps.workersRepo.get(s.workerId)
const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms))
const lastView = (s: Started) =>
  s.e.rig
    .of('session:worker-changed')
    .filter((p) => p.worker.id === s.workerId)
    .at(-1)?.worker
const terminal = async (s: Started): Promise<string> =>
  (await s.e.rig.service.openTerminal(s.workerId)).backlog

/** What the adapter hands its approval handler for `git push`. */
function pushApproval(s: Started, id: number): CodexApprovalRequest {
  const cwd = s.e.rig.deps.worktreesRepo.listByWorker(s.workerId)[0]?.path ?? ''
  return {
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    requestId: id,
    agentId: s.worker.agentId,
    threadId: 'thread-5',
    turnId: 'turn-1',
    raw: { command: "/bin/zsh -lc 'git push origin HEAD'", cwd, itemId: `c${id}` }
  }
}

describe('stepping in on a Codex worker', () => {
  it('interrupts through the handle, stores control and tells the brain', async () => {
    const s = await codexWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    expect(s.worker.interrupts).toBe(1)
    expect(row(s)).toMatchObject({ provider: 'codex', userControl: 'active' })
    expect(s.worker.stopped).toBe(false)
    await until(() => s.e.brain().sent.some((t) => t.includes('stepped in on W1 api-retry')))
  })

  it('cancels the pending approval with the interrupt, and a typed turn asks in the terminal', async () => {
    const s = await codexWorker()
    const approvals = s.codex.starts[0]?.approvals
    if (!approvals) throw new Error('a Codex worker starts with an approval handler')

    // A push the worker was waiting on when the user stepped in.
    const waiting = new AbortController()
    const before = approvals.handle(pushApproval(s, 1), waiting.signal)
    await until(() => s.e.rig.deps.attentionRepo.listPending(s.sessionId).length === 1)
    const pending = s.e.rig.deps.attentionRepo.listPending(s.sessionId)[0]
    expect(pending).toMatchObject({ action: 'git push origin HEAD', route: 'queue' })
    // Codex withdraws the approvals of an interrupted turn (spike S6).
    const interrupt = s.worker.interrupt.bind(s.worker)
    s.worker.interrupt = () => {
      waiting.abort(APPROVAL_WITHDRAWN)
      return interrupt()
    }

    await s.e.rig.service.stepInWorker(s.workerId)
    await before.catch(() => undefined)

    // Nothing is left to re-route: the row is cancelled, not moved to the terminal.
    expect(s.e.rig.deps.attentionRepo.get(pending?.id ?? '')).toMatchObject({
      status: 'cancelled',
      route: 'queue'
    })
    expect(s.e.rig.deps.attentionRepo.listPendingForTerminal(s.workerId)).toEqual([])

    // The user's next line starts a turn that wants to push: the question is asked in the terminal.
    await s.e.rig.service.sendWorkerInput(s.workerId, 'push it')
    void approvals.handle(pushApproval(s, 2), new AbortController().signal)
    await until(() => s.e.rig.deps.attentionRepo.listPendingForTerminal(s.workerId).length === 1)
    expect(s.e.rig.deps.attentionRepo.listPendingForTerminal(s.workerId)[0]).toMatchObject({
      action: 'git push origin HEAD',
      route: 'terminal',
      status: 'pending'
    })
  })

  it('holds the brain messages that were queued behind the turn, drops the nudge, and delivers them at hand-back', async () => {
    const s = await codexWorker()
    // What the adapter had queued when the user stepped in.
    s.worker.discardQueuedSends = vi.fn(() => [
      '[Arc] Message from the brain: use the v2 endpoint',
      '[Arc] You have not called report_done. Commit your work and call report_done.'
    ])

    await s.e.rig.service.stepInWorker(s.workerId)

    expect(s.worker.discardQueuedSends).toHaveBeenCalledTimes(1)
    const held = s.e.rig.deps.heldMessagesRepo.listUndelivered(s.workerId)
    expect(held.map((m) => m.body)).toEqual(['use the v2 endpoint'])
    // None of it reached the worker while the user is in control.
    expect(s.worker.sent).toEqual(['Add retries'])

    await s.e.rig.service.handBackWorker(s.workerId)
    expect(s.worker.sent.at(-1)).toBe(
      `${HAND_BACK_TEXT}\n\n[Arc] Message from the brain (held while the user was in control): use the v2 endpoint`
    )
    expect(s.e.rig.deps.heldMessagesRepo.listUndelivered(s.workerId)).toEqual([])
  })

  it('shows the worker as replying from turn-started to turn-result', async () => {
    const s = await codexWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    expect(lastView(s)?.controlReplying).toBe(false)

    // A queued line of the user's starts its turn later, without sendInput being involved.
    s.worker.emit({ type: 'turn-started', turnId: 'turn-9' })
    await until(() => lastView(s)?.controlReplying === true)
    s.worker.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => lastView(s)?.controlReplying === false)
    // The worker is not judged while the user is in control: no nudge, no stop.
    await settle()
    expect(s.worker.sent).toEqual(['Add retries'])
    expect(s.worker.stopped).toBe(false)
  })

  it("does not show a turn the worker started on its own as the user's reply", async () => {
    const s = await codexWorker()
    s.worker.emit({ type: 'turn-started', turnId: 'turn-2' })
    await settle()
    expect(row(s)?.userControl).toBeNull()
    expect(lastView(s)?.controlReplying ?? false).toBe(false)
  })
})

describe('typed lines on a Codex worker', () => {
  it('sends plain text as a turn, verbatim', async () => {
    const s = await codexWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    await s.e.rig.service.sendWorkerInput(s.workerId, 'use 5 retries')
    expect(s.worker.sent.at(-1)).toBe('use 5 retries')
    expect(row(s)).toMatchObject({ controlUserMessages: 1, controlLastMessage: 'use 5 retries' })
  })

  it('answers a /command with an explanatory terminal line instead of sending it', async () => {
    const s = await codexWorker()
    await s.e.rig.service.stepInWorker(s.workerId)

    await s.e.rig.service.sendWorkerInput(s.workerId, '/awos:spec use 5 retries')

    expect(s.worker.sent).toEqual(['Add retries'])
    expect(row(s)).toMatchObject({ userControl: 'active', controlUserMessages: 0 })
    let log = ''
    for (let i = 0; i < 100 && !log.includes(CODEX_SLASH_LINE); i++) {
      log = await terminal(s)
      await settle(20)
    }
    expect(log).toContain('> /awos:spec use 5 retries')
    expect(log).toContain('Slash commands run in a new worker for Codex')
  })

  it('recognises a leading /name and nothing else', () => {
    expect(typedSlashName('/review the diff')).toBe('review')
    expect(typedSlashName('  /awos:spec')).toBe('awos:spec')
    expect(typedSlashName('/usr/bin/env')).toBeNull()
    expect(typedSlashName('see /review')).toBeNull()
    expect(typedSlashName('/')).toBeNull()
  })
})

/** Quits Arc and reopens the session over the same database with a fresh Codex adapter. */
async function reopen(s: Started): Promise<{ service: SessionService; codex: FakeCodexAdapter }> {
  await s.e.rig.service.shutdown()
  const codex = new FakeCodexAdapter()
  const service = new SessionService({
    ...s.e.rig.deps,
    registry: claudeRegistry(new FakeAdapter(), codex)
  })
  extra.push(service)
  await service.open(s.sessionId)
  return { service, codex }
}

describe('quit, pause and relaunch of a Codex worker', () => {
  it('quitting while in control pauses it; the first typed line resumes the thread through Codex', async () => {
    const s = await codexWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    const { service, codex } = await reopen(s)
    expect(row(s)).toMatchObject({ status: 'working', userControl: 'paused', failureReason: null })

    await service.sendWorkerInput(s.workerId, 'use 5 retries')

    expect(codex.resumes).toHaveLength(1)
    expect(codex.resumes[0]).toMatchObject({
      provider: 'codex',
      resume: { threadId: 'thread-5' }
    })
    expect((codex.handles[0] as FakeHandle).sent).toEqual(['use 5 retries'])
    expect(row(s)).toMatchObject({ userControl: 'active', controlUserMessages: 1 })
  })

  it('Hand back on a paused worker resumes the thread with the hand-back text', async () => {
    const s = await codexWorker()
    await s.e.rig.service.stepInWorker(s.workerId)
    const { service, codex } = await reopen(s)

    await service.handBackWorker(s.workerId)

    expect(codex.resumes[0]?.resume).toEqual({ threadId: 'thread-5' })
    expect((codex.handles[0] as FakeHandle).sent).toEqual([HAND_BACK_TEXT])
    expect(row(s)?.userControl).toBeNull()
  })
})

describe('a Codex history that is gone', () => {
  it('fails the worker with a clear reason instead of crashing or starting over', async () => {
    const s = await codexWorker()
    await s.e.rig.service.shutdown()
    const codex = new FakeCodexAdapter()
    codex.failResumeWith = new ProviderHistoryMissingError('codex', 'thread-5', 'thread not found')
    const service = new SessionService({
      ...s.e.rig.deps,
      registry: claudeRegistry(new FakeAdapter(), codex)
    })
    extra.push(service)
    expect(row(s)).toMatchObject({ status: 'stopped' })

    await service.continueWorker(s.workerId)

    expect(row(s)).toMatchObject({
      status: 'failed',
      failureReason: 'The Codex history for W1 is gone.'
    })
    // It is not started fresh on Codex, and it never moves to Claude.
    expect(codex.starts).toHaveLength(0)
    expect(s.e.rig.eventsRepo.latest(s.sessionId, 50).map((x) => x.text)).toContain(
      'W1 api-retry failed: The Codex history for W1 is gone.'
    )
  })

  it('treats any other resume error as the generic failure', async () => {
    const s = await codexWorker()
    await s.e.rig.service.shutdown()
    const codex = new FakeCodexAdapter()
    codex.failResumeWith = new Error('app-server exploded')
    const service = new SessionService({
      ...s.e.rig.deps,
      registry: claudeRegistry(new FakeAdapter(), codex)
    })
    extra.push(service)
    await service.continueWorker(s.workerId)
    expect(row(s)?.failureReason).toBe('The worker could not be continued: app-server exploded')
  })
})
