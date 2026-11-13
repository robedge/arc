// @spec: 013-session-branches-on-demand
// @regression
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import type { SessionHeader, SessionSnapshot } from '../../../src/shared/types/session'
import { createGitFixture, git, trackedFile } from '../../helpers/git-fixtures'
import type { GitFixture, GitFixtureKind } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-branches-')
let rig: Rig | undefined
const fixtures: GitFixture[] = []

afterEach(async () => {
  await rig?.service.shutdown()
  rig?.close()
  rig = undefined
  while (fixtures.length) fixtures.pop()?.cleanup()
})

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}

async function setup(kinds: Record<string, GitFixtureKind>): Promise<Record<string, GitFixture>> {
  rig = await makeRig(dir())
  const projects = new ProjectsRepo(rig.opened.db)
  const out: Record<string, GitFixture> = {}
  let order = 1
  for (const [name, kind] of Object.entries(kinds)) {
    const fx = createGitFixture({ kind })
    fixtures.push(fx)
    out[name] = fx
    projects.insert({
      id: name,
      path: fx.path,
      displayName: name,
      isGit: kind !== 'plain',
      createdAt: 1
    })
    projects.addMembership(rig.groupId, name, order++, 1)
  }
  return out
}

const branchOf = (repo: string): string => git(repo, 'symbolic-ref', '--short', 'HEAD').trim()

function snapshotOf(result: SessionSnapshot | { needsDirtyChoice: unknown }): SessionSnapshot {
  if ('needsDirtyChoice' in result) throw new Error('expected a snapshot')
  return result
}

/** Plays the brain's first reply, which carries the title that names the branch. */
async function reply(title: string): Promise<void> {
  const brain = (rig as Rig).adapter.last
  brain.emit({ type: 'assistant-message', messageId: 'm0', text: `Title: ${title}\n\nOk.` })
  brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
}

async function startClean(title: string): Promise<string> {
  const r = rig as Rig
  const created = await r.service.create(r.groupId, 'Fix the order sync', 'plan_first', 3)
  await until(() => r.adapter.handles.length > 0 && r.adapter.last.sent.length > 0)
  await reply(title)
  return created.sessionId
}

function headerOf(sessionId: string): SessionHeader {
  return (rig as Rig).service.snapshot(sessionId).header
}

/** The branches named arc/ in a repository. */
const arcBranches = (repo: string): string =>
  git(repo, 'branch', '--list', 'arc/*', '--format=%(refname:short)').trim()

describe('naming a session', () => {
  it('sets the name and touches no repository', async () => {
    const fx = await setup({ api: 'clean', web: 'no-dev', docs: 'plain' })
    const before = {
      api: git((fx['api'] as GitFixture).path, 'for-each-ref', '--format=%(refname) %(objectname)'),
      web: git((fx['web'] as GitFixture).path, 'for-each-ref', '--format=%(refname) %(objectname)')
    }
    const sessionId = await startClean('Fix order sync')
    await until(() => (rig as Rig).sessionsRepo.getById(sessionId)?.slug === 'fix-order-sync')

    expect(branchOf((fx['api'] as GitFixture).path)).toBe('dev')
    expect(branchOf((fx['web'] as GitFixture).path)).toBe('main')
    expect(arcBranches((fx['api'] as GitFixture).path)).toBe('')
    expect(arcBranches((fx['web'] as GitFixture).path)).toBe('')
    expect(
      git((fx['api'] as GitFixture).path, 'for-each-ref', '--format=%(refname) %(objectname)')
    ).toBe(before.api)
    expect(
      git((fx['web'] as GitFixture).path, 'for-each-ref', '--format=%(refname) %(objectname)')
    ).toBe(before.web)
    const rows = new SessionProjectsRepo((rig as Rig).opened.db).listBySession(sessionId)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.every((x) => x.branchName === null)).toBe(true)
    expect(headerOf(sessionId).branches.every((b) => b.branchName === null)).toBe(true)
  })

  it('avoids a branch an older session left in any repository', async () => {
    const fx = await setup({ api: 'clean', web: 'clean' })
    git((fx['web'] as GitFixture).path, 'branch', 'arc/fix-order-sync')
    const sessionId = await startClean('Fix order sync')
    await until(() => (rig as Rig).sessionsRepo.getById(sessionId)?.slug !== null)
    expect((rig as Rig).sessionsRepo.getById(sessionId)?.slug).toBe('fix-order-sync-2')
    expect(arcBranches((fx['api'] as GitFixture).path)).toBe('')
  })

  it('starts with no question and leaves unsaved changes in place', async () => {
    const fx = await setup({ api: 'dirty' })
    const r = rig as Rig
    const created = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
    expect(created).toEqual({ sessionId: expect.any(String) })
    await until(() => r.adapter.handles.length > 0 && r.adapter.last.sent.length > 0)
    await reply('Fix order sync')
    await until(() => r.sessionsRepo.getById(created.sessionId)?.slug === 'fix-order-sync')
    const repo = (fx['api'] as GitFixture).path
    expect(branchOf(repo)).toBe('dev')
    expect(git(repo, 'status', '--porcelain')).toContain(trackedFile)
    expect(arcBranches(repo)).toBe('')
  })

  it('names a session that was left without a name when it is opened', async () => {
    await setup({ api: 'clean' })
    const r = rig as Rig
    const created = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
    expect(r.sessionsRepo.getById(created.sessionId)?.slug).toBeNull()
    r.sessionsRepo.rename(created.sessionId, 'Fix order sync')
    await r.service.open(created.sessionId)
    await until(() => r.sessionsRepo.getById(created.sessionId)?.slug === 'fix-order-sync')
  })

  it('marks a non-git project read only right when the session starts', async () => {
    await setup({ docs: 'plain' })
    const r = rig as Rig
    const created = await r.service.create(r.groupId, 'Look around', 'plan_first', 3)
    expect(headerOf(created.sessionId).branches).toContainEqual({
      projectId: 'docs',
      projectName: 'docs',
      branchName: null,
      baseBranch: null,
      readOnly: true
    })
  })
})

describe('reopening a session', () => {
  /** A session whose api repository already has its session branch (made the way a first worker does). */
  async function started(kinds: Record<string, GitFixtureKind>): Promise<{
    sessionId: string
    fx: Record<string, GitFixture>
  }> {
    const fx = await setup(kinds)
    const sessionId = await startClean('Fix order sync')
    await until(() => (rig as Rig).sessionsRepo.getById(sessionId)?.slug === 'fix-order-sync')
    const repo = (fx['api'] as GitFixture).path
    git(repo, 'checkout', '-b', 'arc/fix-order-sync')
    new SessionProjectsRepo((rig as Rig).opened.db).setBranch(
      sessionId,
      'api',
      'arc/fix-order-sync',
      'dev',
      'dev'
    )
    return { sessionId, fx }
  }

  it('switches a repository back to the session branch when the user moved away', async () => {
    const { sessionId, fx } = await started({ api: 'clean' })
    const repo = (fx['api'] as GitFixture).path
    git(repo, 'checkout', 'dev')
    const result = await (rig as Rig).service.open(sessionId)
    expect(snapshotOf(result).header.branches.find((b) => b.projectId === 'api')?.branchName).toBe(
      'arc/fix-order-sync'
    )
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
  })

  it('asks first when the repository is dirty and switches nothing', async () => {
    const { sessionId, fx } = await started({ api: 'clean' })
    const repo = (fx['api'] as GitFixture).path
    git(repo, 'checkout', 'dev')
    writeFileSync(join(repo, trackedFile), 'dirty again\n')
    const r = rig as Rig
    const result = await r.service.open(sessionId)
    if (!('needsDirtyChoice' in result)) throw new Error('expected a question')
    expect(result.needsDirtyChoice.repos[0]).toMatchObject({
      projectId: 'api',
      files: [trackedFile]
    })
    expect(branchOf(repo)).toBe('dev')

    const resolved = await r.service.resolveDirty(result.needsDirtyChoice.token, { api: 'stash' })
    expect(resolved).toEqual({ status: 'ready', sessionId })
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('Cancel on reopen leaves the dirty repository where it is', async () => {
    const { sessionId, fx } = await started({ api: 'clean' })
    const repo = (fx['api'] as GitFixture).path
    git(repo, 'checkout', 'dev')
    writeFileSync(join(repo, trackedFile), 'dirty again\n')
    const r = rig as Rig
    const result = await r.service.open(sessionId)
    if (!('needsDirtyChoice' in result)) throw new Error('expected a question')
    expect(await r.service.resolveDirty(result.needsDirtyChoice.token, { api: 'cancel' })).toEqual({
      status: 'cancelled'
    })
    expect(branchOf(repo)).toBe('dev')
    expect(git(repo, 'status', '--porcelain')).toContain(trackedFile)
  })

  it('keeps every arc branch when the session is deleted', async () => {
    const { sessionId, fx } = await started({ api: 'clean' })
    const repo = (fx['api'] as GitFixture).path
    await (rig as Rig).service.delete(sessionId)
    expect(git(repo, 'branch', '--list', 'arc/*')).toContain('arc/fix-order-sync')
  })
})
