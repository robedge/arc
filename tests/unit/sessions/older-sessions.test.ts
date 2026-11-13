// @spec: 013-session-branches-on-demand
// @regression
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { doneWorker, eventTexts } from './merge-rig'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-older-sessions-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const current = (path: string): string => gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD')
const arcBranches = (path: string): string => gitIn(path, 'branch', '--list', 'arc/*')

/**
 * Leaves the state the old code made when a session started: `arc/<slug>` created from `dev` in
 * every git project, the checkout switched to it, and the rows recording it.
 */
function seedBranchEverywhere(rig: EngineRig, sessionId: string): string {
  const slug = rig.rig.deps.sessionsRepo.getById(sessionId)?.slug
  if (!slug) throw new Error('the session has no name')
  const branch = `arc/${slug}`
  for (const [projectId, fixture] of [
    ['p-api', rig.api],
    ['p-web', rig.web]
  ] as const) {
    gitIn(fixture.path, 'checkout', '-b', branch)
    rig.rig.deps.sessionProjectsRepo.setBranch(sessionId, projectId, branch, 'dev', 'dev')
  }
  return branch
}

function sent(rig: EngineRig, prefix: string): string {
  return rig.brain().sent.find((t) => t.startsWith(prefix)) ?? ''
}

describe('a session started before branches were made on demand', () => {
  // @spec: 013-session-branches-on-demand
  it('opens, starts a worker, merges, reviews and summarises with a branch in every project', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const branch = seedBranchEverywhere(e, sessionId)

    // Open: the user moved both repositories away, and both are switched back as before.
    gitIn(e.api.path, 'checkout', 'dev')
    gitIn(e.web.path, 'checkout', 'dev')
    const opened = await e.rig.service.open(sessionId)
    if ('needsDirtyChoice' in opened) throw new Error('expected a snapshot')
    expect(
      opened.header.branches
        .filter((b) => b.projectName === 'api' || b.projectName === 'web')
        .map((b) => b.branchName)
    ).toEqual([branch, branch])
    expect(current(e.api.path)).toBe(branch)
    expect(current(e.web.path)).toBe(branch)

    // A new worker: the branch is already there, so nothing is created and no event says so.
    const worker = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    expect(eventTexts(e, sessionId).some((t) => t.startsWith('Created '))).toBe(false)
    expect(e.rig.deps.worktreesRepo.listByWorker(worker.workerId)).toHaveLength(1)
    expect(arcBranches(e.api.path)).toContain(branch)

    // Merge: the commit lands on the session branch in api only.
    await e.call(e.brain(), 'merge_worker', { workerId: worker.workerId })
    expect(readFileSync(join(e.api.path, 'retry.txt'), 'utf8')).toBe('retry\n')
    expect(existsSync(join(e.web.path, 'retry.txt'))).toBe(false)
    expect(gitIn(e.api.path, 'log', '--format=%s', `dev..${branch}`)).toContain(
      'api-retry: retry.txt'
    )
    // Review: every repository with a branch is listed, and only api has changed files.
    const review = await e.rig.deps.reviewService.getReview(sessionId)
    expect(review.repos.map((r) => [r.projectId, r.files.map((f) => f.path)])).toEqual([
      ['p-api', ['retry.txt']],
      ['p-web', []]
    ])

    // Summary: names only the repository with commits.
    await until(() => sent(e as EngineRig, '[Arc] All workers finished') !== '')
    const summary = sent(e, '[Arc] All workers finished')
    expect(summary).toContain(`api (${branch}, base dev):`)
    expect(summary).not.toContain('web (')
    expect(summary).not.toContain('(no commits)')
  })

  // @spec: 013-session-branches-on-demand
  it('names a session left with no name and no branches, and a worker creates the branch only where it starts', async () => {
    e = await makeEngineRig(dir())
    // An aborted start under the old design: the session exists, was never named, has no branches.
    const created = await e.rig.service.create(
      e.rig.groupId,
      'Retry work on the client',
      'autonomous',
      3
    )
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const sessionId = created.sessionId
    await until(() => (e as EngineRig).rig.adapter.handles.length > 0)
    expect(e.rig.deps.sessionsRepo.getById(sessionId)?.slug).toBeNull()
    e.rig.deps.sessionsRepo.rename(sessionId, 'Retry work')

    await e.rig.service.open(sessionId)
    await until(
      () => (e as EngineRig).rig.deps.sessionsRepo.getById(sessionId)?.slug === 'retry-work'
    )
    expect(arcBranches(e.api.path)).toBe('')
    expect(arcBranches(e.web.path)).toBe('')
    expect(
      e.rig.deps.sessionProjectsRepo.listBySession(sessionId).every((r) => r.branchName === null)
    ).toBe(true)

    const result = await e.call(e.brain(), 'spawn_worker', {
      name: 'api-fix',
      task: 'Do api-fix',
      repos: ['api'],
      model: 'sonnet'
    })
    expect(result).toMatchObject({ isError: false, value: { status: 'started' } })
    expect(current(e.api.path)).toBe('arc/retry-work')
    expect(current(e.web.path)).toBe('dev')
    expect(arcBranches(e.web.path)).toBe('')
    expect(eventTexts(e, sessionId)).toContain('Created arc/retry-work in api (from dev)')
  })

  // A project an older session left out (`left_out`) is already covered, in full, by
  // group-changes.test.ts "a project that an older session left out": still read as kept out,
  // absent from the header, `spawn_worker` there refused, and no branch made.
})
