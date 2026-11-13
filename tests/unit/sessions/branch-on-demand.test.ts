// @spec: 013-session-branches-on-demand
// @regression
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchQuestionsRepo } from '../../../src/main/db/repositories/branch-questions-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { BranchOnDemand } from '../../../src/main/sessions/branch-on-demand'
import { createGitFixture, git, trackedFile, untrackedFile } from '../../helpers/git-fixtures'
import type { GitFixture, GitFixtureKind } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-on-demand-')
let rig: Rig | undefined
const fixtures: GitFixture[] = []

afterEach(() => {
  rig?.close()
  rig = undefined
  while (fixtures.length) fixtures.pop()?.cleanup()
})

interface Events {
  kind: string
  text: string
  data: unknown
}

interface Setup {
  unit: BranchOnDemand
  repos: Record<string, string>
  events: Events[]
  headers: string[]
  questions: BranchQuestionsRepo
  drain: ReturnType<typeof vi.fn>
  changed: ReturnType<typeof vi.fn>
  /** What the brain was told, and the workers whose cards were pushed again. */
  notes: string[]
  workersChanged: string[][]
  /** Stores a queued worker that needs these projects. */
  queue: (id: string, projectIds: string[]) => void
  rows: () => ReturnType<SessionProjectsRepo['listBySession']>
  workersOf: () => ReturnType<Rig['deps']['workersRepo']['listBySession']>
  setStatus: (workerId: string, status: 'stopped' | 'starting') => void
  setMembership: (projectId: string, membership: 'removed') => void
}

const SESSION = 'S-ondemand'

/** A session named "fix-order-sync" with one project per entry, none with a branch yet. */
async function setup(kinds: Record<string, GitFixtureKind | 'empty'>): Promise<Setup> {
  const r = await makeRig(dir())
  rig = r
  const repos: Record<string, string> = {}
  const projectRows = []
  for (const [name, kind] of Object.entries(kinds)) {
    let path: string
    if (kind === 'empty') {
      // A repository with no commit: creating a branch off a base branch fails.
      path = mkdtempSync(join(tmpdir(), 'arc-empty-'))
      git(path, 'init', '-b', 'dev')
    } else {
      const fx = createGitFixture({ kind })
      fixtures.push(fx)
      path = fx.path
    }
    repos[name] = path
    new ProjectsRepo(r.opened.db).insert({
      id: name,
      path,
      displayName: name,
      isGit: kind !== 'plain',
      createdAt: 1
    })
    projectRows.push({
      sessionId: SESSION,
      projectId: name,
      readOnly: kind === 'plain',
      projectPath: path,
      projectName: name
    })
  }
  r.sessionsRepo.create({
    id: SESSION,
    groupId: r.groupId,
    name: 'Fix order sync',
    slug: 'fix-order-sync',
    mode: 'autonomous',
    workerLimit: 3,
    model: 'auto',
    workersPrefJson: JSON.stringify({ mode: 'auto' }),
    brainProvider: 'claude',
    brainModel: 'sonnet',
    status: 'active',
    brainPromptVersion: 8,
    createdAt: 1,
    lastActiveAt: 1
  })
  const repo = new SessionProjectsRepo(r.opened.db)
  repo.insertMany(projectRows)
  const events: Events[] = []
  const headers: string[] = []
  const questions = new BranchQuestionsRepo(r.opened.db)
  const drain = vi.fn()
  const changed = vi.fn()
  const notes: string[] = []
  const workersChanged: string[][] = []
  const unit = new BranchOnDemand({
    sessionsRepo: r.sessionsRepo,
    sessionProjectsRepo: repo,
    workersRepo: r.deps.workersRepo,
    branchQuestionsRepo: questions,
    sessionGit: r.deps.sessionGit,
    logEvent: (_id, kind, text, data) => events.push({ kind, text, data }),
    pushHeader: (id) => headers.push(id),
    drain,
    onWorkersChanged: (_id, ids) => workersChanged.push([...ids]),
    notifyBrain: (_id, text) => notes.push(text),
    onQuestionsChanged: changed,
    now: () => 100,
    log: { warn: vi.fn() }
  })
  let number = 0
  const queue = (id: string, projectIds: string[]): void => {
    number += 1
    r.deps.workersRepo.insert({
      id,
      sessionId: SESSION,
      number,
      slug: id.toLowerCase(),
      task: 'Do it',
      command: null,
      attachmentsJson: null,
      projectIdsJson: JSON.stringify(projectIds),
      provider: 'claude',
      model: 'sonnet',
      status: 'queued',
      activity: 'Queued',
      failureReason: null,
      summary: null,
      providerSessionId: null,
      planId: null,
      dependsOnJson: '[]',
      stoppedBy: null,
      createdAt: 1,
      updatedAt: 1
    })
  }
  return {
    unit,
    repos,
    events,
    headers,
    questions,
    drain,
    changed,
    notes,
    workersChanged,
    queue,
    rows: () => repo.listBySession(SESSION),
    workersOf: () => r.deps.workersRepo.listBySession(SESSION),
    setStatus: (workerId, status) => r.deps.workersRepo.setStatus(workerId, status, 5),
    setMembership: (projectId, membership) => {
      const row = repo.listBySession(SESSION).find((p) => p.projectId === projectId)
      if (row) repo.setMembership(row.id, membership)
    }
  }
}

const branchOf = (repo: string): string => git(repo, 'symbolic-ref', '--short', 'HEAD').trim()
const arcBranches = (repo: string): string =>
  git(repo, 'branch', '--list', 'arc/*', '--format=%(refname:short)').trim()

describe('BranchOnDemand.ensure', () => {
  it('creates the branch on first use, records it and says so', async () => {
    const s = await setup({ api: 'clean', web: 'clean' })

    const result = await s.unit.ensure(SESSION, ['api'], 'W1')

    expect(result).toEqual({ status: 'ready' })
    expect(branchOf(s.repos['api'] as string)).toBe('arc/fix-order-sync')
    // The other repository is not touched.
    expect(branchOf(s.repos['web'] as string)).toBe('dev')
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    const api = s.rows().find((r) => r.projectId === 'api')
    expect(api).toMatchObject({
      branchName: 'arc/fix-order-sync',
      baseBranch: 'dev',
      previousBranch: 'dev'
    })
    expect(api?.baseSha).toBe(git(s.repos['api'] as string, 'rev-parse', 'HEAD').trim())
    expect(s.rows().find((r) => r.projectId === 'web')?.branchName).toBeNull()
    expect(s.events.map((e) => e.text)).toEqual(['Created arc/fix-order-sync in api (from dev)'])
    expect(s.events[0]?.kind).toBe('branch')
    expect(s.headers).toEqual([SESSION])
  })

  it('gives a second project the same name and leaves the first alone', async () => {
    const s = await setup({ api: 'clean', web: 'clean' })
    await s.unit.ensure(SESSION, ['api'], 'W1')
    const apiHead = git(s.repos['api'] as string, 'rev-parse', 'HEAD')

    const result = await s.unit.ensure(SESSION, ['api', 'web'], 'W2')

    expect(result).toEqual({ status: 'ready' })
    expect(branchOf(s.repos['web'] as string)).toBe('arc/fix-order-sync')
    expect(git(s.repos['api'] as string, 'rev-parse', 'HEAD')).toBe(apiHead)
    // api already had its branch, so only web is announced the second time.
    expect(s.events.map((e) => e.text)).toEqual([
      'Created arc/fix-order-sync in api (from dev)',
      'Created arc/fix-order-sync in web (from dev)'
    ])
  })

  it('gives every project of one worker its branch', async () => {
    const s = await setup({ api: 'clean', web: 'clean', infra: 'clean', docs: 'plain' })

    const result = await s.unit.ensure(SESSION, ['api', 'web', 'docs'], 'W1')

    expect(result).toEqual({ status: 'ready' })
    expect(branchOf(s.repos['api'] as string)).toBe('arc/fix-order-sync')
    expect(branchOf(s.repos['web'] as string)).toBe('arc/fix-order-sync')
    expect(arcBranches(s.repos['infra'] as string)).toBe('')
    expect(s.rows().find((r) => r.projectId === 'docs')?.branchName).toBeNull()
    expect(s.headers).toEqual([SESSION])
  })

  it('starts the branch from the main branch when there is no dev branch', async () => {
    const s = await setup({ web: 'no-dev' })

    await s.unit.ensure(SESSION, ['web'], 'W1')

    expect(s.rows()[0]).toMatchObject({ baseBranch: 'main', previousBranch: 'main' })
    expect(s.events[0]?.text).toBe('Created arc/fix-order-sync in web (from main)')
  })

  it('creates the branch once when two calls ask for one project at the same time', async () => {
    const s = await setup({ api: 'clean' })

    const [a, b] = await Promise.all([
      s.unit.ensure(SESSION, ['api'], 'W1'),
      s.unit.ensure(SESSION, ['api'], 'W2')
    ])

    expect(a).toEqual({ status: 'ready' })
    expect(b).toEqual({ status: 'ready' })
    expect(arcBranches(s.repos['api'] as string)).toBe('arc/fix-order-sync')
    expect(s.events).toHaveLength(1)
  })

  it('uses the next free name in a repository where the name was taken meanwhile', async () => {
    const s = await setup({ api: 'clean', web: 'clean' })
    git(s.repos['web'] as string, 'branch', 'arc/fix-order-sync')

    const result = await s.unit.ensure(SESSION, ['api', 'web'], 'W1')

    expect(result).toEqual({ status: 'ready' })
    expect(branchOf(s.repos['api'] as string)).toBe('arc/fix-order-sync')
    expect(branchOf(s.repos['web'] as string)).toBe('arc/fix-order-sync-2')
    expect(s.rows().find((r) => r.projectId === 'web')?.branchName).toBe('arc/fix-order-sync-2')
    expect(s.events.map((e) => e.text)).toContain(
      'Created arc/fix-order-sync-2 in web (from dev); the usual name was already taken there'
    )
  })

  it('takes over a branch that was made but never recorded', async () => {
    const s = await setup({ api: 'clean' })
    // What a crash between creating the branch and recording it leaves behind.
    git(s.repos['api'] as string, 'checkout', '-b', 'arc/fix-order-sync', 'dev')
    const tip = git(s.repos['api'] as string, 'rev-parse', 'HEAD').trim()

    const result = await s.unit.ensure(SESSION, ['api'], 'W1')

    expect(result).toEqual({ status: 'ready' })
    expect(arcBranches(s.repos['api'] as string)).toBe('arc/fix-order-sync')
    expect(s.rows()[0]).toMatchObject({
      branchName: 'arc/fix-order-sync',
      baseBranch: 'dev',
      baseSha: tip
    })
  })

  it('does not take over a branch that has commits of its own, and uses the next name', async () => {
    const s = await setup({ api: 'clean' })
    const repo = s.repos['api'] as string
    git(repo, 'checkout', '-b', 'arc/fix-order-sync', 'dev')
    writeFileSync(join(repo, 'more.txt'), 'x\n')
    git(repo, 'add', 'more.txt')
    git(repo, 'commit', '-m', 'Work from somewhere else')

    const result = await s.unit.ensure(SESSION, ['api'], 'W1')

    expect(result).toEqual({ status: 'ready' })
    expect(s.rows()[0]?.branchName).toBe('arc/fix-order-sync-2')
    expect(branchOf(repo)).toBe('arc/fix-order-sync-2')
  })

  it('takes back the branches made in this call when git fails on a later project', async () => {
    const s = await setup({ api: 'clean', broken: 'empty' })
    const before = git(s.repos['api'] as string, 'rev-parse', 'HEAD')

    const result = await s.unit.ensure(SESSION, ['api', 'broken'], 'W1')

    expect(result.status).toBe('failed')
    expect(branchOf(s.repos['api'] as string)).toBe('dev')
    expect(arcBranches(s.repos['api'] as string)).toBe('')
    expect(git(s.repos['api'] as string, 'rev-parse', 'HEAD')).toBe(before)
    expect(s.rows().every((r) => r.branchName === null)).toBe(true)
    expect(s.events).toEqual([])
    expect(s.headers).toEqual([])
  })

  it('fails when the session has no name yet', async () => {
    const s = await setup({ api: 'clean' })
    ;(rig as Rig).sessionsRepo.setSlug(SESSION, null)

    const result = await s.unit.ensure(SESSION, ['api'], 'W1')

    expect(result.status).toBe('failed')
    expect(arcBranches(s.repos['api'] as string)).toBe('')
  })

  it('is reached through the session service', async () => {
    await setup({ api: 'clean' })
    expect((rig as Rig).service.branchOnDemand).toBeInstanceOf(BranchOnDemand)
  })
})

const pendingOf = (s: Setup): { id: string; sessionProjectId: number }[] =>
  s.questions.listPending(SESSION)
const questionFor = (s: Setup, name: string): { id: string } => {
  const id = rowOf(s, name)?.id
  return pendingOf(s).find((q) => q.sessionProjectId === id) as { id: string }
}
const rowOf = (s: Setup, name: string) => s.rows().find((r) => r.projectId === name)
const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')

describe('BranchOnDemand.ensure with unsaved changes', () => {
  it('waits and opens one question for a dirty project, changing nothing', async () => {
    const s = await setup({ web: 'dirty' })

    const result = await s.unit.ensure(SESSION, ['web'], 'W1')

    expect(result).toEqual({ status: 'waiting', projectNames: ['web'] })
    const open = pendingOf(s)
    expect(open).toHaveLength(1)
    expect(open[0]?.sessionProjectId).toBe(rowOf(s, 'web')?.id)
    expect(branchOf(s.repos['web'] as string)).toBe('dev')
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    expect(read(s.repos['web'] as string, trackedFile)).toBe('hello\nchanged\n')
    expect(s.rows()[0]?.branchName).toBeNull()
    expect(s.events).toEqual([])
    expect(s.changed).toHaveBeenCalledWith(SESSION)
  })

  it('creates nothing for a clean project of the same worker until the dirty one is answered', async () => {
    const s = await setup({ api: 'clean', web: 'dirty' })

    const result = await s.unit.ensure(SESSION, ['api', 'web'], 'W1')

    expect(result).toEqual({ status: 'waiting', projectNames: ['web'] })
    expect(branchOf(s.repos['api'] as string)).toBe('dev')
    expect(arcBranches(s.repos['api'] as string)).toBe('')
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    expect(s.rows().every((r) => r.branchName === null)).toBe(true)
    expect(s.events).toEqual([])
    expect(s.headers).toEqual([])
    // Only the dirty project is asked about.
    expect(pendingOf(s).map((q) => q.sessionProjectId)).toEqual([rowOf(s, 'web')?.id])
  })

  it('opens a question for every dirty project of one worker', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })

    const result = await s.unit.ensure(SESSION, ['api', 'web'], 'W1')

    expect(result).toEqual({ status: 'waiting', projectNames: ['api', 'web'] })
    expect(pendingOf(s)).toHaveLength(2)
  })

  it('shares one question between two spawns for the same project', async () => {
    const s = await setup({ web: 'dirty' })

    const [a, b] = await Promise.all([
      s.unit.ensure(SESSION, ['web'], 'W1'),
      s.unit.ensure(SESSION, ['web'], 'W2')
    ])

    expect(a.status).toBe('waiting')
    expect(b.status).toBe('waiting')
    expect(pendingOf(s)).toHaveLength(1)
    // The card is announced once, when it opens.
    expect(s.changed).toHaveBeenCalledTimes(1)
    // A later spawn finds the same question instead of making another.
    const id = pendingOf(s)[0]?.id
    await s.unit.ensure(SESSION, ['web'], 'W3')
    expect(pendingOf(s).map((q) => q.id)).toEqual([id])
    expect(s.changed).toHaveBeenCalledTimes(1)
  })

  it('closes a question whose project became clean before a worker asked again', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    await s.unit.ensure(SESSION, ['web'], 'W1')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'Saved by the user')
    s.changed.mockClear()

    const result = await s.unit.ensure(SESSION, ['web'], 'W1')

    expect(result).toEqual({ status: 'ready' })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(pendingOf(s)).toEqual([])
    expect(s.changed).toHaveBeenCalledWith(SESSION)
  })
})

describe('BranchOnDemand.answer', () => {
  it('Set aside stashes the changes, switches to the session branch and starts the worker', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }
    s.changed.mockClear()

    const result = await s.unit.answer(question.id, 'stash')

    expect(result).toEqual({ status: 'ok' })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
    // The changes are in the stash, and the recorded reference is that stash.
    expect(git(repo, 'stash', 'list')).toContain('arc:Fix order sync')
    expect(git(repo, 'stash', 'show', '-p', '--include-untracked', 'stash@{0}')).toContain(
      'changed'
    )
    const row = rowOf(s, 'web')
    expect(row).toMatchObject({ branchName: 'arc/fix-order-sync', dirtyHandling: 'stashed' })
    expect(row?.stashRef).toBe(git(repo, 'rev-parse', 'stash@{0}').trim())
    expect(s.questions.getById(question.id)).toMatchObject({ status: 'answered', choice: 'stash' })
    expect(s.drain).toHaveBeenCalledWith(SESSION)
    expect(s.changed).toHaveBeenCalledWith(SESSION)
    expect(s.events.map((e) => e.text)).toEqual(['Created arc/fix-order-sync in web (from dev)'])
  })

  it('Commit them first saves the changes as a commit on the branch the user was on', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }

    const result = await s.unit.answer(question.id, 'commit')

    expect(result).toEqual({ status: 'ok' })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
    expect(git(repo, 'log', 'dev', '-1', '--format=%s')).toContain('WIP before Arc session')
    expect(git(repo, 'show', `dev:${trackedFile}`)).toBe('hello\nchanged\n')
    expect(git(repo, 'show', `dev:${untrackedFile}`)).toBe('new\n')
    expect(rowOf(s, 'web')).toMatchObject({ dirtyHandling: 'committed', stashRef: null })
    expect(s.drain).toHaveBeenCalledWith(SESSION)
  })

  it('Bring them along keeps the changes in the working tree on the session branch', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }

    const result = await s.unit.answer(question.id, 'carry')

    expect(result).toEqual({ status: 'ok' })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(read(repo, trackedFile)).toBe('hello\nchanged\n')
    expect(existsSync(join(repo, untrackedFile))).toBe(true)
    expect(git(repo, 'stash', 'list').trim()).toBe('')
    expect(rowOf(s, 'web')).toMatchObject({ dirtyHandling: 'carried', stashRef: null })
  })

  it('gives a waiting worker its clean projects too, once the dirty one is answered', async () => {
    const s = await setup({ api: 'clean', web: 'dirty', infra: 'clean' })
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }

    await s.unit.answer(question.id, 'stash')

    expect(branchOf(s.repos['api'] as string)).toBe('arc/fix-order-sync')
    expect(branchOf(s.repos['web'] as string)).toBe('arc/fix-order-sync')
    expect(arcBranches(s.repos['infra'] as string)).toBe('')
    expect(s.events.map((e) => e.text).sort()).toEqual([
      'Created arc/fix-order-sync in api (from dev)',
      'Created arc/fix-order-sync in web (from dev)'
    ])
    expect(s.drain).toHaveBeenCalledTimes(1)
  })

  it('creates nothing until every question of a worker is answered, then uses each choice', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    const first = questionFor(s, 'api')
    const second = questionFor(s, 'web')

    const early = await s.unit.answer(first.id, 'stash')

    expect(early).toEqual({ status: 'ok' })
    expect(arcBranches(s.repos['api'] as string)).toBe('')
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    expect(s.rows().every((r) => r.branchName === null)).toBe(true)
    // The first answer is kept, and its changes are still in place.
    expect(read(s.repos['api'] as string, trackedFile)).toBe('hello\nchanged\n')

    await s.unit.answer(second.id, 'carry')

    expect(rowOf(s, 'api')).toMatchObject({
      branchName: 'arc/fix-order-sync',
      dirtyHandling: 'stashed'
    })
    expect(rowOf(s, 'web')).toMatchObject({
      branchName: 'arc/fix-order-sync',
      dirtyHandling: 'carried'
    })
    expect(read(s.repos['web'] as string, trackedFile)).toBe('hello\nchanged\n')
    expect(git(s.repos['api'] as string, 'stash', 'list')).toContain('arc:')
  })

  it('uses an answer that is not applied yet for a second worker instead of asking again', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    // W1 still waits on web, so the answer for api is kept and nothing is made yet.
    await s.unit.answer(questionFor(s, 'api').id, 'stash')
    expect(rowOf(s, 'api')?.branchName).toBeNull()

    s.queue('W2', ['api'])
    const result = await s.unit.ensure(SESSION, ['api'], 'W2')

    expect(result).toEqual({ status: 'ready' })
    expect(rowOf(s, 'api')).toMatchObject({
      branchName: 'arc/fix-order-sync',
      dirtyHandling: 'stashed'
    })
    // No second question for api; web is still open for W1.
    expect(pendingOf(s).map((q) => q.sessionProjectId)).toEqual([rowOf(s, 'web')?.id])
  })

  it('starts every worker that waited on the project, and leaves workers of other projects alone', async () => {
    const s = await setup({ web: 'dirty', api: 'clean' })
    s.queue('W1', ['web'])
    s.queue('W2', ['web'])
    s.queue('W3', ['api'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    await s.unit.ensure(SESSION, ['web'], 'W2')
    const question = pendingOf(s)[0] as { id: string }

    await s.unit.answer(question.id, 'commit')

    expect(rowOf(s, 'web')?.branchName).toBe('arc/fix-order-sync')
    // W3 is queued for a reason of its own (a limit, say), so api is not touched here.
    expect(arcBranches(s.repos['api'] as string)).toBe('')
    // One branch only, even though two workers waited.
    expect(s.events).toHaveLength(1)
  })

  it('uses the repository as it is now: changes saved by the user meanwhile are not stashed', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'Saved by the user')

    const result = await s.unit.answer(question.id, 'stash')

    expect(result).toEqual({ status: 'ok' })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(git(repo, 'stash', 'list').trim()).toBe('')
    expect(rowOf(s, 'web')).toMatchObject({ dirtyHandling: 'none', stashRef: null })
    // The user's commit is still on the branch they were on.
    expect(git(repo, 'show', `dev:${trackedFile}`)).toBe('hello\nchanged\n')
  })

  it('sets aside everything that is changed now, including files added after the question', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }
    writeFileSync(join(repo, 'later.txt'), 'later\n')

    await s.unit.answer(question.id, 'stash')

    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
    const stashed = git(repo, 'ls-tree', '-r', '--name-only', 'stash@{0}^3')
    expect(stashed).toContain('later.txt')
    expect(stashed).toContain(untrackedFile)
  })

  it('asks again when a project became dirty after another answer cleared the rest', async () => {
    const s = await setup({ api: 'clean', web: 'dirty' })
    const api = s.repos['api'] as string
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }
    writeFileSync(join(api, trackedFile), 'edited since\n')

    const result = await s.unit.answer(question.id, 'stash')

    expect(result).toEqual({ status: 'ok' })
    // api got dirty with nobody having decided about it: nothing is created, and api is asked about.
    expect(arcBranches(api)).toBe('')
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    expect(pendingOf(s).map((q) => q.sessionProjectId)).toEqual([rowOf(s, 'api')?.id])
    expect(read(api, trackedFile)).toBe('edited since\n')
  })

  it('leaves the question open and the changes in place when bringing them along does not work', async () => {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    // The checked-out branch has a change to the tracked file that dev does not, so carrying clashes.
    git(repo, 'checkout', '-b', 'side', 'dev')
    writeFileSync(join(repo, trackedFile), 'side\n')
    git(repo, 'commit', '-am', 'Side change')
    writeFileSync(join(repo, trackedFile), 'side\nmore\n')
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }

    const result = await s.unit.answer(question.id, 'carry')

    expect(result.status).toBe('failed')
    expect(branchOf(repo)).toBe('side')
    expect(read(repo, trackedFile)).toBe('side\nmore\n')
    expect(arcBranches(repo)).toBe('')
    expect(rowOf(s, 'web')?.branchName).toBeNull()
    const again = s.questions.getById(question.id)
    expect(again?.status).toBe('pending')
    expect(again?.message).toBeTruthy()
  })

  it('refuses a question that is not open', async () => {
    const s = await setup({ web: 'dirty' })
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }
    await s.unit.answer(question.id, 'carry')

    expect(await s.unit.answer(question.id, 'stash')).toEqual({ status: 'not-open' })
    expect(await s.unit.answer('nope', 'stash')).toEqual({ status: 'not-open' })
  })

  it('answers a question nobody waits on without creating a branch', async () => {
    const s = await setup({ web: 'dirty' })
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const question = pendingOf(s)[0] as { id: string }

    const result = await s.unit.answer(question.id, 'stash')

    expect(result).toEqual({ status: 'ok' })
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    expect(read(s.repos['web'] as string, trackedFile)).toBe('hello\nchanged\n')
    expect(s.questions.getById(question.id)?.status).toBe('answered')
  })
})

const failureOf = (s: Setup, id: string): { status: string; reason: string | null } => {
  const row = s.workersOf().find((w) => w.id === id)
  return { status: row?.status ?? 'missing', reason: row?.failureReason ?? null }
}

describe("BranchOnDemand.answer with Don't start", () => {
  it('fails every worker waiting on the project, changes nothing and tells the brain once', async () => {
    const s = await setup({ web: 'dirty', api: 'clean' })
    const repo = s.repos['web'] as string
    s.queue('W1', ['web'])
    s.queue('W2', ['web'])
    s.queue('W3', ['api'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    await s.unit.ensure(SESSION, ['web'], 'W2')
    const question = pendingOf(s)[0] as { id: string }

    const result = await s.unit.answer(question.id, 'skip')

    expect(result).toEqual({ status: 'ok' })
    const reason = 'Not started: you chose to leave web as it is'
    expect(failureOf(s, 'W1')).toEqual({ status: 'failed', reason })
    expect(failureOf(s, 'W2')).toEqual({ status: 'failed', reason })
    // A worker of another project is not touched.
    expect(failureOf(s, 'W3').status).toBe('queued')
    expect(s.notes).toEqual([
      '[Arc] The user chose not to start work in web (unsaved changes). Not started: W1 w1, W2 w2. Nothing was changed in web. Tell the user or change your approach.'
    ])
    expect(s.workersChanged).toEqual([['W1', 'W2']])
    // The repository is exactly as the user left it.
    expect(branchOf(repo)).toBe('dev')
    expect(arcBranches(repo)).toBe('')
    expect(read(repo, trackedFile)).toBe('hello\nchanged\n')
    expect(git(repo, 'stash', 'list').trim()).toBe('')
    expect(rowOf(s, 'web')?.branchName).toBeNull()
    expect(s.events.filter((e) => e.kind === 'branch')).toEqual([])
    expect(s.events.map((e) => e.text)).toContain(`W1 w1 failed: ${reason}`)
    expect(s.questions.getById(question.id)).toMatchObject({ status: 'answered', choice: 'skip' })
    expect(s.drain).toHaveBeenCalledWith(SESSION)
  })

  it('says nothing to the brain when no worker waited', async () => {
    const s = await setup({ web: 'dirty' })
    await s.unit.ensure(SESSION, ['web'], 'W1')

    await s.unit.answer((pendingOf(s)[0] as { id: string }).id, 'skip')

    expect(s.notes).toEqual([])
  })

  it('closes the question of another dirty project once its only worker is gone', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    const api = questionFor(s, 'api')
    const web = questionFor(s, 'web')
    s.changed.mockClear()

    await s.unit.answer(web.id, 'skip')

    expect(failureOf(s, 'W1').reason).toBe('Not started: you chose to leave web as it is')
    expect(s.questions.getById(api.id)?.status).toBe('cancelled')
    expect(pendingOf(s)).toEqual([])
    expect(s.changed).toHaveBeenCalledWith(SESSION)
    expect(s.notes).toHaveLength(1)
    for (const name of ['api', 'web']) {
      expect(branchOf(s.repos[name] as string)).toBe('dev')
      expect(arcBranches(s.repos[name] as string)).toBe('')
      expect(read(s.repos[name] as string, trackedFile)).toBe('hello\nchanged\n')
    }
  })

  it('keeps the question of another dirty project while some other worker still waits on it', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })
    s.queue('W1', ['api', 'web'])
    s.queue('W2', ['api'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    await s.unit.ensure(SESSION, ['api'], 'W2')

    await s.unit.answer(questionFor(s, 'web').id, 'skip')

    expect(failureOf(s, 'W1').status).toBe('failed')
    expect(failureOf(s, 'W2').status).toBe('queued')
    expect(pendingOf(s).map((q) => q.sessionProjectId)).toEqual([rowOf(s, 'api')?.id])
  })

  it('asks again when a later worker needs the same project and it is still dirty', async () => {
    const s = await setup({ web: 'dirty' })
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    await s.unit.answer((pendingOf(s)[0] as { id: string }).id, 'skip')
    expect(pendingOf(s)).toEqual([])

    s.queue('W2', ['web'])
    const again = await s.unit.ensure(SESSION, ['web'], 'W2')

    expect(again).toEqual({ status: 'waiting', projectNames: ['web'] })
    expect(pendingOf(s)).toHaveLength(1)
    expect(arcBranches(s.repos['web'] as string)).toBe('')
    expect(failureOf(s, 'W2').status).toBe('queued')
  })

  it('does not reuse an older answer once the workers that waited are gone', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    await s.unit.answer(questionFor(s, 'api').id, 'stash')
    // api was set aside for W1, which still waits on web; now the user declines web, so W1 fails.
    await s.unit.answer(questionFor(s, 'web').id, 'skip')
    expect(failureOf(s, 'W1').status).toBe('failed')

    s.queue('W2', ['api'])
    const result = await s.unit.ensure(SESSION, ['api'], 'W2')

    expect(result).toEqual({ status: 'waiting', projectNames: ['api'] })
    expect(arcBranches(s.repos['api'] as string)).toBe('')
    expect(read(s.repos['api'] as string, trackedFile)).toBe('hello\nchanged\n')
  })
})

describe('BranchOnDemand.answer when Bring them along clashes', () => {
  /** web is on a branch whose tracked file differs from dev, with more changes on top: carrying clashes. */
  async function clashing(): Promise<{ s: Setup; repo: string; id: string }> {
    const s = await setup({ web: 'dirty' })
    const repo = s.repos['web'] as string
    git(repo, 'checkout', '-b', 'side', 'dev')
    writeFileSync(join(repo, trackedFile), 'side\n')
    git(repo, 'commit', '-am', 'Side change')
    writeFileSync(join(repo, trackedFile), 'side\nmore\n')
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    return { s, repo, id: (pendingOf(s)[0] as { id: string }).id }
  }

  const clashText =
    'The changes in web clash with the branch the session branch starts from, so they cannot come along. Choose another way.'

  it('puts the card back with the reason, keeps the worker waiting and the changes in place', async () => {
    const { s, repo, id } = await clashing()
    s.changed.mockClear()

    const result = await s.unit.answer(id, 'carry')

    expect(result).toEqual({ status: 'failed', reason: clashText })
    expect(s.questions.getById(id)).toMatchObject({
      status: 'pending',
      choice: null,
      message: clashText
    })
    expect(s.changed).toHaveBeenCalledWith(SESSION)
    expect(failureOf(s, 'W1').status).toBe('queued')
    expect(branchOf(repo)).toBe('side')
    expect(read(repo, trackedFile)).toBe('side\nmore\n')
    expect(arcBranches(repo)).toBe('')
    expect(rowOf(s, 'web')?.branchName).toBeNull()
  })

  it('never pushes a moment with no card while the carry is tried, so the dialog stays open', async () => {
    const { s, id } = await clashing()
    const pendingAtPush: number[] = []
    s.changed.mockClear()
    s.changed.mockImplementation(() => {
      pendingAtPush.push(pendingOf(s).length)
    })

    await s.unit.answer(id, 'carry')

    expect(pendingAtPush.length).toBeGreaterThan(0)
    expect(pendingAtPush.every((n) => n === 1)).toBe(true)
  })

  it('lets the user set the changes aside on the same card afterwards', async () => {
    const { s, repo, id } = await clashing()
    await s.unit.answer(id, 'carry')

    const result = await s.unit.answer(id, 'stash')

    expect(result).toEqual({ status: 'ok' })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(git(repo, 'stash', 'list')).toContain('arc:')
    expect(rowOf(s, 'web')).toMatchObject({ dirtyHandling: 'stashed' })
    expect(s.questions.getById(id)?.status).toBe('answered')
  })

  it('lets the user decline on the same card afterwards without touching anything', async () => {
    const { s, repo, id } = await clashing()
    await s.unit.answer(id, 'carry')

    await s.unit.answer(id, 'skip')

    expect(failureOf(s, 'W1').status).toBe('failed')
    expect(branchOf(repo)).toBe('side')
    expect(read(repo, trackedFile)).toBe('side\nmore\n')
    expect(arcBranches(repo)).toBe('')
  })

  it('brings back the card of the project that clashed when another answer triggered it', async () => {
    const s = await setup({ api: 'dirty', web: 'dirty' })
    const web = s.repos['web'] as string
    git(web, 'checkout', '-b', 'side', 'dev')
    writeFileSync(join(web, trackedFile), 'side\n')
    git(web, 'commit', '-am', 'Side change')
    writeFileSync(join(web, trackedFile), 'side\nmore\n')
    s.queue('W1', ['api', 'web'])
    await s.unit.ensure(SESSION, ['api', 'web'], 'W1')
    await s.unit.answer(questionFor(s, 'web').id, 'carry')

    const result = await s.unit.answer(questionFor(s, 'api').id, 'stash')

    expect(result.status).toBe('failed')
    // The card that comes back is web's; api's answer stands and nothing was made anywhere.
    expect(pendingOf(s).map((q) => q.sessionProjectId)).toEqual([rowOf(s, 'web')?.id])
    expect(s.questions.getPendingFor(rowOf(s, 'web')?.id as number)?.message).toBe(clashText)
    expect(arcBranches(s.repos['api'] as string)).toBe('')
    expect(arcBranches(web)).toBe('')
  })
})

describe('BranchOnDemand.cancelOrphans', () => {
  it('closes a question when its last waiting worker is gone', async () => {
    const s = await setup({ web: 'dirty' })
    s.queue('W1', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    const id = (pendingOf(s)[0] as { id: string }).id
    s.setStatus('W1', 'stopped')
    s.changed.mockClear()

    await s.unit.cancelOrphans(SESSION)

    expect(s.questions.getById(id)?.status).toBe('cancelled')
    expect(s.changed).toHaveBeenCalledWith(SESSION)
    expect(arcBranches(s.repos['web'] as string)).toBe('')
  })

  it('keeps a question while another worker still waits on it', async () => {
    const s = await setup({ web: 'dirty' })
    s.queue('W1', ['web'])
    s.queue('W2', ['web'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    s.setStatus('W1', 'stopped')

    await s.unit.cancelOrphans(SESSION)

    expect(pendingOf(s)).toHaveLength(1)
  })

  it('keeps a question for a worker that is still starting and about to wait on it', async () => {
    const s = await setup({ web: 'dirty' })
    s.queue('W1', ['web'])
    s.setStatus('W1', 'starting')
    await s.unit.ensure(SESSION, ['web'], 'W1')

    await s.unit.cancelOrphans(SESSION)

    expect(pendingOf(s)).toHaveLength(1)
  })

  it('closes the card of a project that left the group', async () => {
    const s = await setup({ web: 'dirty', api: 'dirty' })
    s.queue('W1', ['web'])
    s.queue('W2', ['api'])
    await s.unit.ensure(SESSION, ['web'], 'W1')
    await s.unit.ensure(SESSION, ['api'], 'W2')
    const web = questionFor(s, 'web')
    s.setMembership('web', 'removed')

    await s.unit.cancelOrphans(SESSION)

    expect(s.questions.getById(web.id)?.status).toBe('cancelled')
    expect(pendingOf(s).map((q) => q.sessionProjectId)).toEqual([rowOf(s, 'api')?.id])
  })
})
