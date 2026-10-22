import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelRef } from '../../../src/shared/types/provider'
import { git } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { gitFails, gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-engine-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const apiWorker = {
  name: 'api-retry',
  task: 'Add retry to the API client',
  repos: ['api'],
  model: 'sonnet',
  rationale: 'No retry yet.'
}
const webWorker = {
  name: 'docs-update',
  task: 'Document it',
  repos: ['web'],
  rationale: 'Docs.'
}

/** Proposes a plan through the brain's tool and approves it. Returns the tool's result. */
async function planAndApprove(
  rig: EngineRig,
  sessionId: string,
  workers: unknown[] = [apiWorker],
  models?: Record<string, ModelRef>
): Promise<Record<string, unknown>> {
  const pending = rig.call(rig.brain(), 'propose_plan', { workers })
  await until(() => rig.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
  const plan = rig.rig.deps.plansRepo.latest(sessionId)
  rig.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve', models)
  return (await pending).value
}

const spawnArgs = (w: Record<string, unknown>): Record<string, unknown> => ({
  name: w['name'],
  task: w['task'],
  repos: w['repos'],
  ...(w['model'] ? { model: w['model'] } : {})
})

describe('plan-first gate', () => {
  it('refuses spawn_worker with plan_not_approved until a matching plan is approved', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('plan_first')

    const early = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(early).toMatchObject({ isError: true, value: { error: 'plan_not_approved' } })
    expect(e.rig.deps.workersRepo.listBySession(sessionId)).toHaveLength(0)

    // A proposed (not yet approved) plan does not open the gate either.
    const pending = e.call(e.brain(), 'propose_plan', { workers: [apiWorker] })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId)?.status === 'proposed')
    const whileProposed = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(whileProposed.value['error']).toBe('plan_not_approved')
    const plan = e.rig.deps.plansRepo.latest(sessionId)
    e.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve')
    await pending

    // Another name, or other repos, still do not match the approved entry.
    const otherName = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs(apiWorker),
      name: 'something-else'
    })
    expect(otherName.value['error']).toBe('plan_not_approved')
    const otherRepos = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs(apiWorker),
      repos: ['web']
    })
    expect(otherRepos.value['error']).toBe('plan_not_approved')

    const ok = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(ok).toMatchObject({ isError: false, value: { status: 'started' } })

    // One approved entry starts one worker.
    const again = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(again.value['error']).toBe('plan_not_approved')
    expect(e.rig.deps.workersRepo.listBySession(sessionId)).toHaveLength(1)
  })

  it('lets autonomous sessions spawn without a plan, and a mode switch applies to the next call', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const first = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(first.value['status']).toBe('started')

    e.rig.sessionsRepo.setMode(sessionId, 'plan_first')
    const second = await e.call(e.brain(), 'spawn_worker', spawnArgs(webWorker))
    expect(second.value['error']).toBe('plan_not_approved')

    e.rig.sessionsRepo.setMode(sessionId, 'autonomous')
    const third = await e.call(e.brain(), 'spawn_worker', spawnArgs(webWorker))
    expect(third.value['status']).toBe('started')
  })

  it('answers unknown_repo for a project that is not in the session', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const result = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs(apiWorker),
      repos: ['nope']
    })
    expect(result.value['error']).toBe('unknown_repo')
    const readOnly = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs(apiWorker),
      repos: ['repo-a']
    })
    expect(readOnly.value['error']).toBe('unknown_repo')
  })
})

describe('propose_plan', () => {
  it('stores the plan and its message, pushes it, and blocks until the user approves', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession()
    e.rig.pushed.length = 0

    let settled = false
    const pending = e
      .call(e.brain(), 'propose_plan', { workers: [apiWorker, webWorker] })
      .then((r) => {
        settled = true
        return r
      })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId) !== undefined)
    await new Promise((r) => setTimeout(r, 120))
    expect(settled).toBe(false)

    const row = e.rig.deps.plansRepo.latest(sessionId)
    expect(row).toMatchObject({ status: 'proposed', sessionId })
    const messages = e.rig.messagesRepo.latest(sessionId, 20)
    const planMessage = messages.find((m) => m.planId === row?.id)
    expect(planMessage).toMatchObject({ role: 'brain', state: 'complete' })
    expect(row?.messageId).toBe(planMessage?.id)
    const pushedPlan = e.rig.of('session:plan')[0]?.plan
    expect(pushedPlan).toMatchObject({ id: row?.id, status: 'proposed', changesRequested: false })
    expect(pushedPlan?.workers.map((w) => w.name)).toEqual(['api-retry', 'docs-update'])
    expect(e.rig.of('session:message').some((m) => m.message.planId === row?.id)).toBe(true)
    expect(e.rig.service.snapshot(sessionId).plan).toMatchObject({ id: row?.id })

    e.rig.service.decidePlan(sessionId, row?.id ?? '', 'approve', {
      'docs-update': { provider: 'claude', model: 'haiku' }
    })
    const result = await pending
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      planId: row?.id,
      decision: 'approved',
      models: { 'api-retry': 'sonnet', 'docs-update': 'haiku' },
      providers: { 'api-retry': 'claude', 'docs-update': 'claude' }
    })
    expect(e.rig.deps.plansRepo.get(row?.id ?? '')?.status).toBe('approved')
  })

  it('ask for changes delivers the next chat message as the comment, and the next plan replaces the old one', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession()
    const brain = e.brain()

    const first = e.call(brain, 'propose_plan', { workers: [apiWorker] })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId) !== undefined)
    const oldPlan = e.rig.deps.plansRepo.latest(sessionId)
    e.rig.service.decidePlan(sessionId, oldPlan?.id ?? '', 'ask-changes')
    expect(e.rig.of('session:plan').at(-1)?.plan).toMatchObject({
      status: 'proposed',
      changesRequested: true
    })

    const sentBefore = brain.sent.length
    await e.rig.service.sendMessage(sessionId, 'Also cover the web app')
    const result = await first
    expect(result.value).toEqual({
      planId: oldPlan?.id,
      decision: 'changes_requested',
      comment: 'Also cover the web app'
    })
    // The comment is the tool result, not a second user turn.
    await new Promise((r) => setTimeout(r, 50))
    expect(brain.sent.length).toBe(sentBefore)
    expect(
      e.rig.messagesRepo.latest(sessionId, 20).some((m) => m.content === 'Also cover the web app')
    ).toBe(true)

    const second = e.call(brain, 'propose_plan', { workers: [apiWorker, webWorker] })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId)?.id !== oldPlan?.id)
    const newPlan = e.rig.deps.plansRepo.latest(sessionId)
    expect(e.rig.deps.plansRepo.get(oldPlan?.id ?? '')).toMatchObject({
      status: 'replaced',
      replacedById: newPlan?.id
    })
    e.rig.service.decidePlan(sessionId, newPlan?.id ?? '', 'reject')
    expect((await second).value).toEqual({ planId: newPlan?.id, decision: 'rejected' })
    expect(e.rig.deps.plansRepo.get(newPlan?.id ?? '')?.status).toBe('rejected')
    expect(e.rig.deps.workersRepo.listBySession(sessionId)).toHaveLength(0)
  })

  it('tells the brain in a message when its call is gone by the time the user decides', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession()
    const brain = e.brain()
    const pending = e.call(brain, 'propose_plan', { workers: [apiWorker] })
    await until(() => e?.rig.deps.plansRepo.latest(sessionId) !== undefined)
    e.bridge.revokeAgent(brain.agentId)
    expect((await pending).isError).toBe(true)

    const plan = e.rig.deps.plansRepo.latest(sessionId)
    expect(plan?.status).toBe('proposed')
    const before = brain.sent.length
    e.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve')
    await until(() => (e?.brain().sent.length ?? 0) > before)
    expect(brain.sent.at(-1)).toContain('[Arc] The user approved your plan')
  })

  it('refuses a plan that names a project outside the session', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession()
    const result = await e.call(e.brain(), 'propose_plan', {
      workers: [{ ...apiWorker, repos: ['ghost'] }]
    })
    expect(result.value['error']).toBe('unknown_repo')
    expect(e.rig.deps.plansRepo.latest(sessionId)).toBeUndefined()
  })
})

describe('starting a worker', () => {
  it('creates detached worktrees at the session branch tip and starts the worker with its own config', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    // Move the session branch past `dev` so "at the tip" is distinguishable.
    git(e.api.path, 'commit', '--allow-empty', '-m', 'Session work')
    const tip = gitIn(e.api.path, 'rev-parse', 'HEAD')
    const branchesBefore = gitIn(e.api.path, 'branch', '--format=%(refname:short)')

    const started = await e.call(e.brain(), 'spawn_worker', {
      name: 'API retry',
      task: 'Add retry',
      repos: ['api', 'web'],
      model: 'haiku'
    })
    expect(started.value['status']).toBe('started')
    const workerId = String(started.value['workerId'])

    const row = e.rig.deps.workersRepo.get(workerId)
    expect(row).toMatchObject({ number: 1, slug: 'api-retry', model: 'haiku', status: 'starting' })
    expect(row?.planId).toBeNull()
    const trees = e.rig.deps.worktreesRepo.listByWorker(workerId)
    expect(trees.map((t) => t.path)).toEqual([
      join(dir(), 'userData', 'worktrees', sessionId, workerId, 'api'),
      join(dir(), 'userData', 'worktrees', sessionId, workerId, 'web')
    ])
    const apiTree = trees[0]
    expect(apiTree?.baseSha).toBe(tip)
    expect(apiTree?.headSha).toBe(tip)
    for (const t of trees) expect(existsSync(t.path)).toBe(true)

    // Detached: HEAD is not a branch, and no branch was added to the user's repository.
    expect(gitFails(apiTree?.path ?? '', 'symbolic-ref', '-q', 'HEAD')).toBe(true)
    expect(gitIn(apiTree?.path ?? '', 'rev-parse', 'HEAD')).toBe(tip)
    expect(gitIn(e.api.path, 'branch', '--format=%(refname:short)')).toBe(branchesBefore)

    const start = e.rig.adapter.starts.find((s) => s.agentId === `worker-${workerId}`)
    expect(start).toMatchObject({ role: 'worker', cwd: apiTree?.path, model: 'haiku' })
    expect(start?.addDirs).toContain(trees[1]?.path)
    expect(start?.addDirs).toContain(
      join(dir(), 'userData', 'groups'.concat('/', e.rig.groupId), 'knowledge')
    )
    expect(start?.addDirs).toContain(join(dir(), 'repo-a'))
    expect(start?.addDirs).not.toContain(e.api.path)
    expect(start?.readOnlyDirs).toContain(join(dir(), 'repo-a'))
    expect(start?.bridgeTools).toEqual(['report_progress', 'report_done', 'ask_brain'])
    expect(start?.claude.permissionPromptTool).toBe('mcp__arc__request_permission')
    expect(start?.instructions).toContain('[arc-role:worker]')
    expect(start?.instructions).toContain('[arc-worker:api-retry]')
    expect(e.workerHandle().sent).toEqual(['Add retry'])
    expect(e.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)).toContain(
      'started W1 api-retry · Claude · Haiku'
    )
  })

  it('names the session from the request when the brain calls a tool before its first reply ends', async () => {
    e = await makeEngineRig(dir())
    const created = await e.rig.service.create(
      e.rig.groupId,
      'Retry work on the client',
      'autonomous',
      3
    )
    if (!('sessionId' in created)) throw new Error('expected a session id')
    await until(() => e?.rig.adapter.handles.length === 1)
    // No Title line and no turn-result yet: the branch would wait for a name that waits for this call.
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(started.value['status']).toBe('started')
    expect(e.rig.sessionsRepo.getById(created.sessionId)?.name).toBe('Retry Work On The Client')
    expect(gitIn(e.api.path, 'branch', '--format=%(refname:short)')).toContain(
      'arc/retry-work-on-the-client'
    )
  })

  it('removes nothing and fails the call cleanly when the worktree cannot be created', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    // A file where the worker's folder must go.
    const blocker = join(dir(), 'userData', 'worktrees')
    writeFileSync(blocker, 'in the way')
    const result = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(result).toMatchObject({ isError: true, value: { error: 'worktree_failed' } })
    const rows = e.rig.deps.workersRepo.listBySession(sessionId)
    expect(rows[0]).toMatchObject({ status: 'failed' })
    expect(e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(0)
  })
})

describe('worker lifecycle', () => {
  it('goes Starting, Working, Done and tells the brain; stores the summary, the commit and the head sha', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    e.rig.pushed.length = 0
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const workerId = String(started.value['workerId'])
    const worker = e.workerHandle()
    const tree = e.rig.deps.worktreesRepo.listByWorker(workerId)[0]
    const brainSentBefore = e.brain().sent.length

    worker.emit({
      type: 'session',
      providerSessionId: 'worker-claude-1',
      model: 'claude-sonnet-5-5',
      mcpServers: [{ name: 'arc', status: 'connected' }]
    })
    await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
    expect(e.rig.deps.workersRepo.get(workerId)?.providerSessionId).toBe('worker-claude-1')

    const progress = await e.call(worker, 'report_progress', {
      note: 'Reading the client',
      filesChanged: ['client.ts']
    })
    expect(progress.value).toEqual({ ok: true })
    expect(e.rig.deps.workersRepo.get(workerId)?.activity).toBe('Reading the client')

    writeFileSync(join(tree?.path ?? '', 'retry.txt'), 'retry\n')
    git(tree?.path ?? '', 'add', 'retry.txt')
    git(tree?.path ?? '', 'commit', '-m', 'Add retry')
    const head = gitIn(tree?.path ?? '', 'rev-parse', 'HEAD')

    const done = await e.call(worker, 'report_done', { summary: 'Added retry to the API client' })
    expect(done.value).toEqual({ ok: true })
    expect(e.rig.deps.workersRepo.get(workerId)?.summary).toBe('Added retry to the API client')
    expect(e.rig.deps.worktreesRepo.listByWorker(workerId)[0]?.headSha).toBe(head)
    expect(e.rig.deps.commitsRepo.listByWorker(workerId).map((c) => [c.sha, c.subject])).toEqual([
      [head, 'Add retry']
    ])

    // The turn ends: Arc closes the worker's input and the process exits cleanly.
    worker.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'done')
    expect(worker.stopped).toBe(true)

    await until(() => (e?.brain().sent.length ?? 0) > brainSentBefore)
    expect(e.brain().sent.at(-1)).toBe('[Arc] W1 api-retry finished: Added retry to the API client')
    const texts = e.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)
    expect(texts).toContain('started W1 api-retry · Claude · Sonnet')
    expect(texts).toContain('W1 api-retry finished')
    // The working copy stays until the work is merged.
    expect(existsSync(tree?.path ?? '')).toBe(true)
    // The token is revoked and the config file is gone.
    expect(existsSync(join(dir(), 'userData', 'mcp', worker.agentId + '.json'))).toBe(false)
    await expect(e.call(worker, 'report_progress', { note: 'late' })).rejects.toThrow()

    await until(
      () => e?.rig.of('session:worker-changed').some((p) => p.worker.status === 'done') ?? false
    )
    const statuses = e.rig.of('session:worker-changed').map((p) => p.worker.status)
    expect(statuses[0]).toBe('starting')
    // 'working' is asserted from the database above; the 250 ms latest-wins push may skip it.
    expect(statuses.at(-1)).toBe('done')
  })

  it('pushes a worker at most once per 250 ms while it keeps reporting', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const worker = e.workerHandle()
    await new Promise((r) => setTimeout(r, 300))
    e.rig.pushed.length = 0
    const startedAt = Date.now()
    for (let i = 0; i < 25; i++) {
      await e.call(worker, 'report_progress', { note: `step ${i}` })
    }
    const elapsed = Date.now() - startedAt
    await new Promise((r) => setTimeout(r, 400))
    const pushes = e.rig.of('session:worker-changed')
    expect(pushes.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 2)
    expect(pushes.length).toBeGreaterThanOrEqual(1)
    // The last state always goes out.
    expect(pushes.at(-1)?.worker.activity).toBe('step 24')
  })

  it('marks a crashed worker Failed with a reason and tells the brain', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const workerId = String(started.value['workerId'])
    const worker = e.workerHandle()
    const brainSentBefore = e.brain().sent.length

    worker.emit({
      type: 'exit',
      code: 1,
      signal: null,
      expected: false,
      stderrTail: 'fatal: boom\n'
    })
    worker.queue.close()
    await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'failed')
    const row = e.rig.deps.workersRepo.get(workerId)
    expect(row?.failureReason).toBe('The worker exited with code 1. fatal: boom')
    expect(row?.stoppedBy).toBeNull()

    await until(() => (e?.brain().sent.length ?? 0) > brainSentBefore)
    expect(e.brain().sent.at(-1)).toBe(
      '[Arc] Worker W1 failed: The worker exited with code 1. fatal: boom. Decide how to continue and tell the user.'
    )
    expect(e.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)).toContain(
      'W1 api-retry failed: The worker exited with code 1. fatal: boom'
    )
    // A failed worker keeps its working copy so nothing is lost.
    expect(existsSync(e.rig.deps.worktreesRepo.listByWorker(workerId)[0]?.path ?? '')).toBe(true)
  })

  it('stops a worker for the user: Stopped, stopped_by user, "Stopped by you", brain not told', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const workerId = String(started.value['workerId'])
    const worker = e.workerHandle()
    worker.emit({
      type: 'session',
      providerSessionId: 'w',
      model: 'claude-sonnet-5-5',
      mcpServers: []
    })
    await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
    const brainSentBefore = e.brain().sent.length

    await e.rig.service.stopWorker(workerId)
    const row = e.rig.deps.workersRepo.get(workerId)
    expect(row).toMatchObject({ status: 'stopped', stoppedBy: 'user' })
    expect(worker.stopped).toBe(true)
    const stopEvent = e.rig.eventsRepo
      .latest(sessionId, 50)
      .find((x) => x.kind === 'worker-stopped')
    expect(stopEvent).toMatchObject({ text: 'Stopped by you; working copy removed', workerId })
    await new Promise((r) => setTimeout(r, 80))
    expect(e.brain().sent.length).toBe(brainSentBefore)
  })

  it('nudges a worker that ends its turn without report_done, then fails it', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const workerId = String(started.value['workerId'])
    const worker = e.workerHandle()
    worker.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => worker.sent.length === 2)
    expect(worker.sent[1]).toContain('report_done')
    worker.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'failed')
    expect(e.rig.deps.workersRepo.get(workerId)?.failureReason).toContain(
      'without calling report_done'
    )
  })

  it('message_worker reaches the running worker and get_worker_status reports it', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const workerId = String(started.value['workerId'])
    const worker = e.workerHandle()

    const sent = await e.call(e.brain(), 'message_worker', { workerId: 'W1', text: 'Use backoff' })
    expect(sent.value).toEqual({ delivered: true })
    expect(worker.sent.at(-1)).toBe('[Arc] Message from the brain: Use backoff')
    const missing = await e.call(e.brain(), 'message_worker', { workerId: 'W9', text: 'hi' })
    expect(missing.value['error']).toBe('unknown_worker')

    await e.call(worker, 'report_progress', { note: 'Halfway', filesChanged: ['a.ts'] })
    const status = await e.call(e.brain(), 'get_worker_status', { workerId })
    expect(status.isError).toBe(false)
    const entries = status.value as unknown as Record<string, unknown>[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: workerId,
      number: 1,
      name: 'api-retry',
      status: 'starting',
      note: 'Halfway',
      files: ['a.ts'],
      lastReport: 'Halfway'
    })
    const all = await e.call(e.brain(), 'get_worker_status', {})
    expect((all.value as unknown as unknown[]).length).toBe(1)
  })

  it('removes the working copies when the session is deleted, and keeps the branches', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    const path =
      e.rig.deps.worktreesRepo.listByWorker(String(started.value['workerId']))[0]?.path ?? ''
    expect(existsSync(path)).toBe(true)
    await e.rig.service.delete(sessionId)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId))).toBe(false)
    expect(gitIn(e.api.path, 'branch', '--format=%(refname:short)')).toContain('arc/retry-work')
    expect(gitIn(e.api.path, 'worktree', 'list')).not.toContain('worktrees')
  })
})

describe('effective model', () => {
  it('uses the plan card choice over the brain proposal', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('plan_first')
    await planAndApprove(e, sessionId, [apiWorker], {
      'api-retry': { provider: 'claude', model: 'opus' }
    })
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(e.rig.deps.workersRepo.get(String(started.value['workerId']))?.model).toBe('opus')
  })

  it('lets the session model from the header override everything', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('plan_first')
    e.rig.sessionsRepo.setWorkersPref(sessionId, {
      mode: 'model',
      model: { provider: 'claude', model: 'haiku' }
    })
    await planAndApprove(e, sessionId, [apiWorker], {
      'api-retry': { provider: 'claude', model: 'opus' }
    })
    const started = await e.call(e.brain(), 'spawn_worker', spawnArgs(apiWorker))
    expect(e.rig.deps.workersRepo.get(String(started.value['workerId']))?.model).toBe('haiku')
  })

  it('accepts a full model name the CLI reported, and falls back to sonnet with a note for an unknown one', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    // The brain's init event reported claude-sonnet-5-5.
    e.brain().emit({
      type: 'session',
      providerSessionId: 'b',
      model: 'claude-opus-5-1',
      mcpServers: []
    })
    await new Promise((r) => setTimeout(r, 30))
    const known = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs(apiWorker),
      model: 'claude-opus-5-1'
    })
    expect(e.rig.deps.workersRepo.get(String(known.value['workerId']))?.model).toBe(
      'claude-opus-5-1'
    )

    const unknown = await e.call(e.brain(), 'spawn_worker', {
      ...spawnArgs(webWorker),
      model: 'gpt-9'
    })
    const id = String(unknown.value['workerId'])
    expect(e.rig.deps.workersRepo.get(id)?.model).toBe('sonnet')
    expect(e.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)).toContain(
      'Unknown model "gpt-9" (brain); used sonnet instead.'
    )
  })
})

describe('brain launch', () => {
  it('starts the brain with the bridge config, the exact tool names and a long tool timeout', async () => {
    e = await makeEngineRig(dir())
    await e.startSession()
    const start = e.rig.adapter.starts[0]
    expect(start?.claude.mcpConfigPath).toBe(
      join(dir(), 'userData', 'mcp', start?.agentId + '.json')
    )
    expect(start?.bridgeTools).toEqual([
      'propose_plan',
      'spawn_worker',
      'message_worker',
      'get_worker_status',
      'merge_worker',
      'sync_worker',
      'resolve_request',
      'escalate_to_user',
      'ask_user'
    ])
    expect(start?.extraEnv?.['MCP_TOOL_TIMEOUT']).toBe('43200000')
    expect(start?.instructions).toContain('propose_plan')
  })
})
