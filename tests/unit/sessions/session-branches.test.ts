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
  if (!('sessionId' in created)) throw new Error('expected a session id')
  await until(() => r.adapter.handles.length > 0 && r.adapter.last.sent.length > 0)
  await reply(title)
  return created.sessionId
}

function headerOf(sessionId: string): SessionHeader {
  return (rig as Rig).service.snapshot(sessionId).header
}

describe('session branch flow', () => {
  it('creates arc/<slug> from dev after the title and records the rows', async () => {
    const fx = await setup({ api: 'clean', web: 'no-dev', docs: 'plain' })
    const sessionId = await startClean('Fix order sync')
    await until(() => headerOf(sessionId).branches.some((b) => b.branchName !== null))

    expect(branchOf((fx['api'] as GitFixture).path)).toBe('arc/fix-order-sync')
    expect(branchOf((fx['web'] as GitFixture).path)).toBe('arc/fix-order-sync')
    const rows = new SessionProjectsRepo((rig as Rig).opened.db).listBySession(sessionId)
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r]))
    expect(byId['api']).toMatchObject({
      branchName: 'arc/fix-order-sync',
      baseBranch: 'dev',
      previousBranch: 'dev',
      readOnly: false
    })
    expect(byId['web']).toMatchObject({ baseBranch: 'main', readOnly: false })
    expect(byId['docs']).toMatchObject({ branchName: null, readOnly: true })
    // The branch point is recorded for review: dev's tip when the session started.
    const devTip = (repo: string): string => git(repo, 'rev-parse', 'refs/heads/dev').trim()
    expect(byId['api']?.baseSha).toBe(devTip((fx['api'] as GitFixture).path))
    expect(byId['web']?.baseSha).toBe(
      git((fx['web'] as GitFixture).path, 'rev-parse', 'refs/heads/main').trim()
    )
    expect(byId['docs']?.baseSha).toBeNull()
    expect((rig as Rig).sessionsRepo.getById(sessionId)?.slug).toBe('fix-order-sync')

    const pushed = (rig as Rig).of('session:header').at(-1)
    expect(pushed?.sessionId).toBe(sessionId)
    expect(pushed?.header.branches.find((b) => b.projectId === 'api')).toMatchObject({
      branchName: 'arc/fix-order-sync',
      baseBranch: 'dev'
    })
  })

  it('marks a non-git project read only right when the session starts', async () => {
    await setup({ docs: 'plain' })
    const r = rig as Rig
    const created = await r.service.create(r.groupId, 'Look around', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    expect(headerOf(created.sessionId).branches).toContainEqual({
      projectId: 'docs',
      projectName: 'docs',
      branchName: null,
      baseBranch: null,
      readOnly: true
    })
  })

  it('asks before creating anything when a repository is dirty, with the changed files', async () => {
    const fx = await setup({ api: 'dirty' })
    const r = rig as Rig
    const result = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
    if (!('needsDirtyChoice' in result)) throw new Error('expected a question')
    expect(result.needsDirtyChoice.repos).toEqual([
      expect.objectContaining({ projectId: 'api', name: 'api', fileCount: 2 })
    ])
    expect(result.needsDirtyChoice.repos[0]?.files).toContain(trackedFile)
    expect(r.sessionsRepo.listByGroup(r.groupId)).toHaveLength(0)
    expect(r.adapter.handles).toHaveLength(0)
    expect(branchOf((fx['api'] as GitFixture).path)).toBe('dev')
  })

  it('Cancel creates nothing and leaves the repository untouched', async () => {
    const fx = await setup({ api: 'dirty' })
    const r = rig as Rig
    const result = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
    if (!('needsDirtyChoice' in result)) throw new Error('expected a question')
    const resolved = await r.service.resolveDirty(result.needsDirtyChoice.token, { api: 'cancel' })
    expect(resolved).toEqual({ status: 'cancelled' })
    expect(r.sessionsRepo.listByGroup(r.groupId)).toHaveLength(0)
    expect(r.adapter.handles).toHaveLength(0)
    const repo = (fx['api'] as GitFixture).path
    expect(branchOf(repo)).toBe('dev')
    expect(git(repo, 'status', '--porcelain')).toContain(trackedFile)
    // The token is spent.
    await expect(
      r.service.resolveDirty(result.needsDirtyChoice.token, { api: 'stash' })
    ).rejects.toThrow()
  })

  it('Set aside creates the session now and the stash with the branch after the title', async () => {
    const fx = await setup({ api: 'dirty' })
    const r = rig as Rig
    const result = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
    if (!('needsDirtyChoice' in result)) throw new Error('expected a question')
    const resolved = await r.service.resolveDirty(result.needsDirtyChoice.token, { api: 'stash' })
    if (resolved.status !== 'ready') throw new Error('expected ready')
    const repo = (fx['api'] as GitFixture).path
    await until(() => r.adapter.handles.length > 0 && r.adapter.last.sent.length > 0)
    await reply('Fix order sync')
    await until(() => headerOf(resolved.sessionId).branches.some((b) => b.branchName !== null))
    expect(branchOf(repo)).toBe('arc/fix-order-sync')
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'stash', 'list')).toContain('arc:Fix order sync')
    const row = new SessionProjectsRepo(r.opened.db)
      .listBySession(resolved.sessionId)
      .find((x) => x.projectId === 'api')
    expect(row).toMatchObject({ dirtyHandling: 'stashed' })
    expect(row?.stashRef).toMatch(/^[0-9a-f]{40}$/)
  })

  it('explains an aborted branch start in a system message and leaves the repository alone', async () => {
    const fx = await setup({ api: 'clean' })
    const r = rig as Rig
    const created = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const repo = (fx['api'] as GitFixture).path
    // The repository becomes dirty before the title arrives: no choice was made for it.
    writeFileSync(join(repo, trackedFile), 'changed meanwhile\n')
    await until(() => r.adapter.handles.length > 0 && r.adapter.last.sent.length > 0)
    await reply('Fix order sync')
    await until(() =>
      r.service.snapshot(created.sessionId).messages.some((m) => m.role === 'system')
    )
    const note = r.service.snapshot(created.sessionId).messages.find((m) => m.role === 'system')
    expect(note?.content).toContain('no branch was created')
    expect(branchOf(repo)).toBe('dev')
    expect(r.sessionsRepo.getById(created.sessionId)?.slug).toBeNull()
  })
})

describe('reopening a session', () => {
  async function started(kinds: Record<string, GitFixtureKind>): Promise<{
    sessionId: string
    fx: Record<string, GitFixture>
  }> {
    const fx = await setup(kinds)
    const sessionId = await startClean('Fix order sync')
    await until(() => headerOf(sessionId).branches.some((b) => b.branchName !== null))
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
