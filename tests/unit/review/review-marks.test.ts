import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { ReviewMarksRepo } from '../../../src/main/db/repositories/review-marks-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { projects } from '../../../src/main/db/schema'
import { createGit } from '../../../src/main/git/git'
import { createMergeGit } from '../../../src/main/git/merge'
import { createReviewGit } from '../../../src/main/git/review-git'
import { createSessionGit } from '../../../src/main/git/session-git'
import type { Attribution } from '../../../src/main/review/attribution'
import { ReviewService } from '../../../src/main/review/review-service'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const BRANCH = 'arc/work'
const noAttribution: Attribution = { attribute: async () => new Map(), version: () => '' }
const runner = createGit({ env: gitFixtureEnv })
const mergeGit = createMergeGit(runner, createSessionGit(runner))
const reviewGit = createReviewGit(runner)

const dir = useTempDir()
let opened: OpenedDatabase
let fixture: GitFixture
let repo: string

function commit(files: Record<string, string>, message = 'work'): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', message)
}

function newService(): ReviewService {
  return new ReviewService({
    sessionProjectsRepo: new SessionProjectsRepo(opened.db),
    mergeGit,
    pushGit: { chooseRemote: () => Promise.resolve(null) },
    reviewGit,
    attribution: noAttribution,
    marksRepo: new ReviewMarksRepo(opened.db),
    log: { warn: vi.fn() }
  })
}

async function fileOf(svc: ReviewService, path: string) {
  const snapshot = await svc.getReview('s1')
  const file = snapshot.repos[0]?.files.find((f) => f.path === path)
  if (!file) throw new Error(`${path} is not in the review`)
  return file
}

beforeEach(() => {
  fixture = createGitFixture()
  repo = fixture.path
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'b.txt'), 'x\ny\nz\nw\nv\nu\n')
  writeFileSync(join(repo, 'keep.txt'), 'keep\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'Seed')
  const base = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', '-b', BRANCH)

  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  new GroupsRepo(opened.db).insert({
    id: 'g1',
    name: 'g',
    nameKey: 'g',
    createdAt: 1,
    updatedAt: 1
  })
  new SessionsRepo(opened.db).create({
    id: 's1',
    groupId: 'g1',
    name: 's1',
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
  opened.db
    .insert(projects)
    .values({ id: 'api', path: repo, displayName: 'api', createdAt: 1 })
    .run()
  const spRepo = new SessionProjectsRepo(opened.db)
  const [sp] = spRepo.insertMany([
    {
      sessionId: 's1',
      projectId: 'api',
      readOnly: false,
      projectPath: repo,
      projectName: 'api'
    }
  ])
  if (!sp) throw new Error('session project')
  spRepo.setBranch('s1', 'api', BRANCH, 'dev', 'dev')
  spRepo.setBaseSha(sp.id, base)
})

afterEach(() => {
  opened.sqlite.close()
  fixture.cleanup()
})

describe('review:set-reviewed', () => {
  it('starts unreviewed, ticking marks reviewed and unticking clears it', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    const svc = newService()
    expect(await fileOf(svc, 'a.txt')).toMatchObject({
      reviewed: false,
      changedSinceReviewed: false
    })

    await svc.setReviewed('s1', 'api', 'a.txt', true)
    expect(await fileOf(svc, 'a.txt')).toMatchObject({
      reviewed: true,
      changedSinceReviewed: false
    })

    await svc.setReviewed('s1', 'api', 'a.txt', false)
    expect(await fileOf(svc, 'a.txt')).toMatchObject({
      reviewed: false,
      changedSinceReviewed: false
    })
  })

  it('does not leak the fingerprint into the review files', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    expect(Object.keys(await fileOf(newService(), 'a.txt'))).not.toContain('fingerprint')
  })

  it('a later change to the file sets changedSinceReviewed and clears reviewed', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    const svc = newService()
    await svc.setReviewed('s1', 'api', 'a.txt', true)

    commit({ 'a.txt': 'one\ntwo\nthree\n' }, 'more')
    expect(await fileOf(svc, 'a.txt')).toMatchObject({
      reviewed: false,
      changedSinceReviewed: true
    })

    // Ticking again records the new fingerprint.
    await svc.setReviewed('s1', 'api', 'a.txt', true)
    expect(await fileOf(svc, 'a.txt')).toMatchObject({
      reviewed: true,
      changedSinceReviewed: false
    })
  })

  it('a later change to another file leaves the file reviewed', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    const svc = newService()
    await svc.setReviewed('s1', 'api', 'a.txt', true)

    commit({ 'keep.txt': 'keep\nmore\n' }, 'other')
    expect(await fileOf(svc, 'a.txt')).toMatchObject({
      reviewed: true,
      changedSinceReviewed: false
    })
    expect(await fileOf(svc, 'keep.txt')).toMatchObject({ reviewed: false })
  })

  it('rejects a path that is not a changed session file', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    const svc = newService()
    await expect(svc.setReviewed('s1', 'api', 'keep.txt', true)).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
    await expect(svc.setReviewed('s1', 'other', 'a.txt', true)).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
  })

  it('rejects an uncommitted file', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    writeFileSync(join(repo, 'wip.txt'), 'not committed\n')
    await expect(newService().setReviewed('s1', 'api', 'wip.txt', true)).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
  })

  it('fingerprints a rename by blobs, status and old path', async () => {
    git(repo, 'mv', 'b.txt', 'b2.txt')
    git(repo, 'commit', '-am', 'rename')
    const svc = newService()
    const renamed = await fileOf(svc, 'b2.txt')
    expect(renamed).toMatchObject({ status: 'R', oldPath: 'b.txt' })
    await svc.setReviewed('s1', 'api', 'b2.txt', true)
    expect(await fileOf(svc, 'b2.txt')).toMatchObject({ reviewed: true })

    // Editing the renamed file changes its tip blob, so the mark goes stale.
    commit({ 'b2.txt': 'x\ny\nz\nw\nv\nu\nt\n' }, 'edit renamed')
    expect(await fileOf(svc, 'b2.txt')).toMatchObject({
      reviewed: false,
      changedSinceReviewed: true
    })
  })

  it('keeps marks across a fresh ReviewService on the same database', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    await newService().setReviewed('s1', 'api', 'a.txt', true)
    expect(await fileOf(newService(), 'a.txt')).toMatchObject({
      reviewed: true,
      changedSinceReviewed: false
    })
  })

  it('ignores a mark for a file that left the list, without deleting it', async () => {
    commit({ 'a.txt': 'one\ntwo\n' })
    const svc = newService()
    await svc.setReviewed('s1', 'api', 'a.txt', true)
    commit({ 'a.txt': 'one\n' }, 'revert a')
    const snapshot = await svc.getReview('s1')
    expect(snapshot.repos[0]?.files.map((f) => f.path)).toEqual([])
    expect(new ReviewMarksRepo(opened.db).listBySession('s1')).toHaveLength(1)
  })
})
