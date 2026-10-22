import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { git } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { gitFails, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { fakeAdapter, records } from './fake-cli'

const dir = useTempDir('arc-engine-int-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

describe('session service with the real bridge and the fake CLI', () => {
  it('runs propose_plan, approve, two workers and their completion', async () => {
    const logPath = join(dir(), 'fake.log')
    e = await makeEngineRig(dir(), { adapter: fakeAdapter('plan-first', logPath) })
    const { rig } = e
    const created = await rig.service.create(rig.groupId, 'Add retries and docs', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created

    // The brain proposes; nothing runs until the user approves.
    await until(() => rig.deps.plansRepo.latest(sessionId)?.status === 'proposed', 15000)
    const plan = rig.deps.plansRepo.latest(sessionId)
    expect(rig.deps.workersRepo.listBySession(sessionId)).toHaveLength(0)
    expect(rig.service.snapshot(sessionId).plan?.workers.map((w) => w.name)).toEqual([
      'api-retry',
      'docs-update'
    ])

    // The brain is blocked on the user, not thinking.
    expect(rig.service.snapshot(sessionId).brainState).toBe('waiting')

    // Approve; the user changes one worker's model.
    rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve', {
      'docs-update': { provider: 'claude', model: 'haiku' }
    })
    expect(rig.service.snapshot(sessionId).brainState).toBe('thinking')
    await until(
      () =>
        rig.deps.workersRepo.listBySession(sessionId).filter((w) => w.status === 'done').length ===
        2,
      20000
    )
    const workers = rig.deps.workersRepo.listBySession(sessionId)
    expect(workers.map((w) => [w.number, w.slug, w.model, w.status])).toEqual([
      [1, 'api-retry', 'sonnet', 'done'],
      [2, 'docs-update', 'haiku', 'done']
    ])
    expect(workers.map((w) => w.summary)).toEqual([
      'Added retry to the API client',
      'Documented the retry option'
    ])

    // Each worker committed in its own detached working copy, and the head shas were recorded.
    for (const worker of workers) {
      const tree = rig.deps.worktreesRepo.listByWorker(worker.id)[0]
      expect(tree?.path).toContain(join('worktrees', sessionId, worker.id))
      expect(gitFails(tree?.path ?? '', 'symbolic-ref', '-q', 'HEAD')).toBe(true)
      const head = git(tree?.path ?? '', 'rev-parse', 'HEAD').trim()
      expect(tree?.headSha).toBe(head)
      expect(tree?.headSha).not.toBe(tree?.baseSha)
      expect(rig.deps.commitsRepo.listByWorker(worker.id).map((c) => c.sha)).toEqual([head])
    }

    // The brain was told about each worker and answered both.
    await until(
      () =>
        rig.messagesRepo.latest(sessionId, 50).some((m) => m.content === 'Both workers finished.'),
      15000
    )
    const log = records(logPath)
    const brainStdin = log
      .map((r) => JSON.stringify(r.stdin ?? ''))
      .filter((l) => l.includes('[Arc]'))
    expect(brainStdin.some((l) => l.includes('W1 api-retry finished: Added retry'))).toBe(true)
    expect(brainStdin.some((l) => l.includes('W2 docs-update finished: Documented'))).toBe(true)

    // The gate refused the early spawn; the approved ones went through.
    const results = log.flatMap((r) => (r.mcpResult ? [r.mcpResult] : []))
    const spawns = results.filter((r) => r.tool === 'spawn_worker')
    expect(spawns[0]?.isError).toBe(true)
    expect(spawns[0]?.text).toContain('plan_not_approved')
    expect(spawns.slice(1).map((r) => r.isError)).toEqual([false, false])
    expect(results.find((r) => r.tool === 'propose_plan')?.text).toContain('"decision":"approved"')

    // Launch arguments.
    const argvs = log.flatMap((r) => (r.argv && r.argv[0] === '-p' ? [r] : []))
    const brainArgs =
      argvs.find((r) => r.argv?.some((a) => a.includes('arc-role:brain')))?.argv ?? []
    expect(brainArgs.some((a) => a.startsWith('--mcp-config=') && a.endsWith('.json'))).toBe(true)
    expect(brainArgs).toContain('--strict-mcp-config')
    expect(brainArgs[brainArgs.indexOf('--allowedTools') + 1]).toBe(
      'Read Grep Glob WebFetch WebSearch ToolSearch mcp__arc__propose_plan mcp__arc__spawn_worker mcp__arc__message_worker mcp__arc__get_worker_status mcp__arc__merge_worker mcp__arc__sync_worker mcp__arc__resolve_request mcp__arc__escalate_to_user mcp__arc__ask_user'
    )
    const workerRuns = argvs.filter((r) => r.argv?.some((a) => a.includes('arc-role:worker')))
    expect(workerRuns).toHaveLength(2)
    for (const run of workerRuns) {
      expect(run.argv).toContain('acceptEdits')
      expect(run.argv?.[(run.argv?.indexOf('--permission-prompt-tool') ?? -2) + 1]).toBe(
        'mcp__arc__request_permission'
      )
      expect(run.argv?.some((a) => a.startsWith('--mcp-config='))).toBe(true)
    }
    expect(workerRuns.map((r) => r.argv?.[(r.argv?.indexOf('--model') ?? 0) + 1]).sort()).toEqual([
      'haiku',
      'sonnet'
    ])

    // Tokens are revoked and the config files are gone once the agents ended.
    await until(() => !existsSync(join(dir(), 'userData', 'mcp', `worker-${workers[0]?.id}.json`)))
    const texts = rig.eventsRepo.latest(sessionId, 100).map((x) => x.text)
    expect(texts).toContain('Plan approved')
    expect(texts).toContain('started W1 api-retry · Claude · Sonnet')
    expect(texts).toContain('started W2 docs-update · Claude · Haiku')
    expect(texts).toContain('W1 api-retry finished')
  }, 60000)

  it('shows a crashing worker as Failed with a reason and lets the brain post its next step', async () => {
    const logPath = join(dir(), 'fake-crash.log')
    e = await makeEngineRig(dir(), { adapter: fakeAdapter('crash', logPath) })
    const { rig } = e
    const created = await rig.service.create(
      rig.groupId,
      'Start a worker that crashes',
      'autonomous',
      2
    )
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created

    await until(
      () => rig.deps.workersRepo.listBySession(sessionId).some((w) => w.status === 'failed'),
      20000
    )
    const worker = rig.deps.workersRepo.listBySession(sessionId)[0]
    expect(worker?.failureReason).toContain('The worker exited with code 1.')
    expect(worker?.failureReason).toContain('fatal: the fake worker crashed')

    await until(
      () =>
        rig.messagesRepo
          .latest(sessionId, 50)
          .some((m) => m.content.startsWith('The worker failed.')),
      15000
    )
    const told = records(logPath).some((r) =>
      JSON.stringify(r.stdin ?? '').includes('[Arc] Worker W1 failed')
    )
    expect(told).toBe(true)
  }, 60000)

  it('runs an autonomous session with limit 2: three spawns without a plan, one queued until a worker finishes', async () => {
    const logPath = join(dir(), 'fake-auto.log')
    e = await makeEngineRig(dir(), { adapter: fakeAdapter('autonomous', logPath) })
    const { rig } = e
    const created = await rig.service.create(rig.groupId, 'Three parallel jobs', 'autonomous', 2)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created

    // All three spawn_worker calls return before any worker is done; the third waits.
    await until(() => rig.deps.workersRepo.listBySession(sessionId).length === 3, 20000)
    const early = rig.deps.workersRepo.listBySession(sessionId)
    expect(early.map((w) => w.status === 'queued')).toEqual([false, false, true])
    expect(rig.deps.worktreesRepo.listByWorker(early[2]?.id ?? '')).toHaveLength(0)

    await until(
      () => rig.deps.workersRepo.listBySession(sessionId).every((w) => w.status === 'done'),
      30000
    )
    await until(
      () =>
        rig.messagesRepo.latest(sessionId, 50).some((m) => m.content === 'All workers finished.'),
      15000
    )

    const results = records(logPath).flatMap((r) => (r.mcpResult ? [r.mcpResult] : []))
    const spawns = results.filter((r) => r.tool === 'spawn_worker')
    expect(spawns.map((r) => r.isError)).toEqual([false, false, false])
    expect(spawns.map((r) => JSON.parse(r.text).status)).toEqual(['started', 'started', 'queued'])
    expect(results.some((r) => r.tool === 'propose_plan')).toBe(false)

    const texts = rig.eventsRepo.latest(sessionId, 100).map((x) => x.text)
    expect(texts).toContain('W3 job-three queued (limit 2)')
    expect(texts).toContain('started W3 job-three · Claude · Sonnet')
    // The queued worker started only after another one had finished.
    expect(texts.indexOf('started W3 job-three · Claude · Sonnet')).toBeGreaterThan(
      Math.min(texts.indexOf('W1 job-one finished'), texts.indexOf('W2 job-two finished'))
    )
  }, 90000)
})
