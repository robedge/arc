import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionProjectRow } from '../../../src/main/db/repositories/session-projects-repo'
import { createGit } from '../../../src/main/git/git'
import { createMergeGit } from '../../../src/main/git/merge'
import { createReviewGit } from '../../../src/main/git/review-git'
import { createSessionGit } from '../../../src/main/git/session-git'
import type { Attribution } from '../../../src/main/review/attribution'
import { ReviewService } from '../../../src/main/review/review-service'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { ReviewUncommitted } from '../../../src/shared/types/review'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'

const noAttribution: Attribution = { attribute: async () => new Map(), version: () => '' }
const runner = createGit({ env: gitFixtureEnv })
const mergeGit = createMergeGit(runner, createSessionGit(runner))
const reviewGit = createReviewGit(runner)
const BRANCH = 'arc/work'

let fixture: GitFixture | undefined
const extraDirs: string[] = []
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repo with `files` committed on dev, `arc/work` checked out, and a service over it. */
function session(
  files: Record<string, string | Buffer> = {},
  review: ReturnType<typeof createReviewGit> = reviewGit
) {
  fixture = createGitFixture()
  const repo = fixture.path
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '--allow-empty', '-m', 'Seed')
  const base = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', '-b', BRANCH)
  const row: SessionProjectRow = {
    id: 1,
    sessionId: 's1',
    projectId: 'api',
    branchName: BRANCH,
    baseBranch: 'dev',
    previousBranch: 'dev',
    readOnly: false,
    dirtyHandling: 'none',
    stashRef: null,
    baseSha: base,
    pushedRemote: null,
    pushedBranch: null,
    pushedSha: null,
    pushedAt: null,
    projectPath: repo,
    projectName: 'api',
    membership: 'active'
  }
  const svc = new ReviewService({
    sessionProjectsRepo: { listBySession: () => [row], setBaseSha: vi.fn(() => true) },
    mergeGit,
    pushGit: { chooseRemote: () => Promise.resolve(null) },
    reviewGit: review,
    attribution: noAttribution,
    marksRepo: { listByProject: () => [], mark: vi.fn(), unmark: vi.fn() },
    log: { warn: vi.fn() }
  })
  return { repo, svc }
}

async function uncommitted(svc: ReviewService): Promise<ReviewUncommitted> {
  const snap = await svc.getReview('s1')
  return (snap.repos[0] as NonNullable<(typeof snap.repos)[0]>).uncommitted
}

async function okFiles(svc: ReviewService) {
  const u = await uncommitted(svc)
  if (u.state !== 'ok') throw new Error('expected ok')
  return u.files
}

describe('review uncommitted section', () => {
  it('reports a tracked modification against HEAD (staged and unstaged together)', async () => {
    const { repo, svc } = session({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'x\n' })
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
    git(repo, 'add', 'a.txt')
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    expect(await okFiles(svc)).toEqual([
      { path: 'a.txt', status: 'M', added: 2, removed: 1, binary: false, large: false }
    ])
  })

  it('reports a staged added file as A', async () => {
    const { repo, svc } = session()
    writeFileSync(join(repo, 'new.txt'), 'a\nb\n')
    git(repo, 'add', 'new.txt')
    expect(await okFiles(svc)).toEqual([
      { path: 'new.txt', status: 'A', added: 2, removed: 0, binary: false, large: false }
    ])
  })

  it('reports a deleted file as D', async () => {
    const { repo, svc } = session({ 'gone.txt': 'a\nb\nc\n' })
    unlinkSync(join(repo, 'gone.txt'))
    expect(await okFiles(svc)).toEqual([
      { path: 'gone.txt', status: 'D', added: 0, removed: 3, binary: false, large: false }
    ])
  })

  it('counts lines of an untracked text file, including inside new directories', async () => {
    const { repo, svc } = session()
    mkdirSync(join(repo, 'dir'))
    writeFileSync(join(repo, 'dir', 'u.txt'), 'a\nb\nc')
    expect(await okFiles(svc)).toEqual([
      { path: 'dir/u.txt', status: 'A', added: 3, removed: 0, binary: false, large: false }
    ])
  })

  it('marks an untracked file with a NUL byte as binary', async () => {
    const { repo, svc } = session()
    writeFileSync(join(repo, 'img.bin'), Buffer.from([1, 2, 0, 3]))
    expect(await okFiles(svc)).toEqual([
      { path: 'img.bin', status: 'A', added: 0, removed: 0, binary: true, large: false }
    ])
    await expect(svc.getFile('s1', 'api', 'img.bin', false, 'uncommitted')).resolves.toEqual({
      kind: 'binary'
    })
  })

  it('marks an untracked file over 1 MB as large without reading it', async () => {
    const { repo, svc } = session()
    writeFileSync(join(repo, 'big.txt'), 'x\n'.repeat(600_000))
    expect(await okFiles(svc)).toEqual([
      { path: 'big.txt', status: 'A', added: 0, removed: 0, binary: false, large: true }
    ])
    await expect(svc.getFile('s1', 'api', 'big.txt', true, 'uncommitted')).resolves.toEqual({
      kind: 'tooLarge',
      changedLines: 0
    })
  })

  it('degrades to other-branch with the branch name when the checkout is elsewhere', async () => {
    const { repo, svc } = session({ 'a.txt': 'a\n' })
    git(repo, 'checkout', 'dev')
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    expect(await uncommitted(svc)).toEqual({ state: 'other-branch', current: 'dev' })
    await expect(svc.getFile('s1', 'api', 'a.txt', false, 'uncommitted')).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
  })

  it('degrades to other-branch with null when HEAD is detached', async () => {
    const { repo, svc } = session()
    git(repo, 'checkout', '--detach')
    expect(await uncommitted(svc)).toEqual({ state: 'other-branch', current: null })
  })

  it('keeps the repository and its committed files when reading the checkout fails', async () => {
    const failing = {
      ...reviewGit,
      uncommittedChanges: async () => {
        throw new Error('status blew up')
      }
    }
    const { repo, svc } = session({}, failing)
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'work')
    const snap = await svc.getReview('s1')
    expect(snap.repos).toHaveLength(1)
    expect(snap.repos[0]?.files.map((f) => f.path)).toEqual(['c.txt'])
    expect(snap.repos[0]?.uncommitted).toEqual({ state: 'unavailable' })
  })

  it('recomputes on every call', async () => {
    const { repo, svc } = session()
    expect(await okFiles(svc)).toEqual([])
    writeFileSync(join(repo, 'late.txt'), 'x\n')
    expect((await okFiles(svc)).map((f) => f.path)).toEqual(['late.txt'])
  })
})

describe('review:file with source uncommitted', () => {
  it('gives hunks for a tracked file against HEAD', async () => {
    const { repo, svc } = session({ 'a.txt': 'one\ntwo\nthree\n' })
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
    const diff = await svc.getFile('s1', 'api', 'a.txt', false, 'uncommitted')
    expect(diff.kind).toBe('text')
    if (diff.kind !== 'text') return
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'one' },
      { kind: 'del', oldNo: 2, text: 'two' },
      { kind: 'add', newNo: 2, text: 'TWO' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'three' }
    ])
  })

  it('builds all-add hunks for an untracked file', async () => {
    const { repo, svc } = session()
    writeFileSync(join(repo, 'u.txt'), 'a\nb')
    const diff = await svc.getFile('s1', 'api', 'u.txt', false, 'uncommitted')
    expect(diff).toEqual({
      kind: 'text',
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          header: '@@ -0,0 +1,2 @@',
          lines: [
            { kind: 'add', newNo: 1, text: 'a' },
            { kind: 'add', newNo: 2, text: 'b', noNewline: true }
          ]
        }
      ]
    })
  })

  it('rejects a path that is not in the uncommitted list', async () => {
    const { repo, svc } = session({ 'clean.txt': 'a\n' })
    writeFileSync(join(repo, 'dirty.txt'), 'x\n')
    await expect(svc.getFile('s1', 'api', 'clean.txt', false, 'uncommitted')).rejects.toMatchObject(
      { code: 'REVIEW_FILE_NOT_FOUND' }
    )
    await expect(
      svc.getFile('s1', 'api', '../outside.txt', false, 'uncommitted')
    ).rejects.toMatchObject({ code: 'REVIEW_FILE_NOT_FOUND' })
    await expect(
      svc.getFile('s1', 'api', 'dirty.txt', false, 'uncommitted')
    ).resolves.toMatchObject({ kind: 'text' })
  })

  it('leaves out and rejects a symlink pointing outside the repository', async () => {
    const { repo, svc } = session()
    const outside = join(tmpdir(), `arc-outside-${Date.now()}`)
    extraDirs.push(outside)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'))
    writeFileSync(join(repo, 'real.txt'), 'ok\n')
    expect((await okFiles(svc)).map((f) => f.path)).toEqual(['real.txt'])
    await expect(svc.getFile('s1', 'api', 'link.txt', false, 'uncommitted')).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
  })

  it('accepts source in the contract and refuses other values', () => {
    const schema = channelSchemas['review:file']
    const base = { sessionId: 's', projectId: 'p', path: 'a' }
    expect(schema.safeParse({ ...base, source: 'uncommitted' }).success).toBe(true)
    expect(schema.safeParse({ ...base, source: 'nope' }).success).toBe(false)
  })
})
