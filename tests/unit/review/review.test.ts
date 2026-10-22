import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionProjectRow } from '../../../src/main/db/repositories/session-projects-repo'
import { createGit } from '../../../src/main/git/git'
import { createMergeGit, pendingRef } from '../../../src/main/git/merge'
import { createReviewGit, parseRawNumstat } from '../../../src/main/git/review-git'
import { createSessionGit } from '../../../src/main/git/session-git'
import type { Attribution } from '../../../src/main/review/attribution'
import { ReviewService } from '../../../src/main/review/review-service'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'

const noAttribution: Attribution = { attribute: async () => new Map(), version: () => '' }
const runner = createGit({ env: gitFixtureEnv })
const mergeGit = createMergeGit(runner, createSessionGit(runner))
const reviewGit = createReviewGit(runner)
const BRANCH = 'arc/work'

let fixture: GitFixture | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function commitFile(repo: string, name: string, content: string | Buffer, message = name): void {
  writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', message)
}

function rev(repo: string, ref: string): string {
  return git(repo, 'rev-parse', ref).trim()
}

/** A repo with a few files committed on dev, then `arc/work` checked out; returns the branch point. */
function startSession(files: Record<string, string | Buffer> = {}): { repo: string; base: string } {
  fixture = createGitFixture()
  const repo = fixture.path
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '--allow-empty', '-m', 'Seed')
  const base = rev(repo, 'HEAD')
  git(repo, 'checkout', '-b', BRANCH)
  return { repo, base }
}

function row(repo: string, baseSha: string | null, overrides: Partial<SessionProjectRow> = {}) {
  return {
    id: 1,
    sessionId: 's1',
    projectId: 'api',
    branchName: BRANCH,
    baseBranch: 'dev',
    previousBranch: 'dev',
    readOnly: false,
    dirtyHandling: 'none',
    stashRef: null,
    baseSha,
    pushedRemote: null,
    pushedBranch: null,
    pushedSha: null,
    pushedAt: null,
    projectPath: repo,
    projectName: 'api',
    membership: 'active',
    ...overrides
  } satisfies SessionProjectRow
}

function service(rows: SessionProjectRow[]) {
  const setBaseSha = vi.fn((id: number, sha: string) => {
    const r = rows.find((x) => x.id === id)
    if (r && r.baseSha === null) {
      r.baseSha = sha
      return true
    }
    return false
  })
  const log = { warn: vi.fn() }
  const svc = new ReviewService({
    sessionProjectsRepo: { listBySession: () => rows, setBaseSha },
    mergeGit,
    pushGit: { chooseRemote: () => Promise.resolve(null) },
    reviewGit,
    attribution: noAttribution,
    marksRepo: { listByProject: () => [], mark: vi.fn(), unmark: vi.fn() },
    log
  })
  return { svc, setBaseSha, log }
}

describe('parseRawNumstat', () => {
  it('reads a rename with old and new path and its counts', () => {
    const out = ':100644 100644 aaa bbb R090\0old.txt\0new.txt\0' + '1\t2\t\0old.txt\0new.txt\0'
    expect(parseRawNumstat(out)).toEqual([
      {
        path: 'new.txt',
        oldPath: 'old.txt',
        fingerprint: expect.any(String),
        status: 'R',
        added: 1,
        removed: 2,
        binary: false,
        large: false
      }
    ])
  })
})

describe('review-git listChanges', () => {
  it('reports added, modified, deleted, renamed, binary and large files', async () => {
    const { repo, base } = startSession({
      'mod.txt': 'one\ntwo\n',
      'gone.txt': 'bye\n',
      'old-name.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n'
    })
    writeFileSync(join(repo, 'added.txt'), 'x\ny\n')
    writeFileSync(join(repo, 'mod.txt'), 'one\nTWO\nthree\n')
    git(repo, 'rm', '-q', 'gone.txt')
    git(repo, 'mv', 'old-name.txt', 'new-name.txt')
    writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255, 0]))
    writeFileSync(
      join(repo, 'big.txt'),
      Array.from({ length: 2001 }, (_, i) => `line ${i}`).join('\n') + '\n'
    )
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'work')

    const files = await reviewGit.listChanges(repo, base, rev(repo, 'HEAD'))
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))

    expect(byPath['added.txt']).toEqual({
      path: 'added.txt',
      fingerprint: expect.any(String),
      status: 'A',
      added: 2,
      removed: 0,
      binary: false,
      large: false
    })
    expect(byPath['mod.txt']).toMatchObject({ status: 'M', added: 2, removed: 1 })
    expect(byPath['gone.txt']).toMatchObject({ status: 'D', added: 0, removed: 1 })
    expect(byPath['new-name.txt']).toEqual({
      path: 'new-name.txt',
      oldPath: 'old-name.txt',
      fingerprint: expect.any(String),
      status: 'R',
      added: 0,
      removed: 0,
      binary: false,
      large: false
    })
    expect(byPath['old-name.txt']).toBeUndefined()
    expect(byPath['pic.bin']).toMatchObject({ status: 'A', binary: true, added: 0, removed: 0 })
    expect(byPath['big.txt']).toMatchObject({ status: 'A', added: 2001, large: true })
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort())
  })

  it('does not call a 2,000-line file large', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'edge.txt', Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n') + '\n')
    const [file] = await reviewGit.listChanges(repo, base, rev(repo, 'HEAD'))
    expect(file).toMatchObject({ added: 2000, large: false })
  })

  it('skips rename detection above 2,000 changed files', async () => {
    const { repo, base } = startSession({ 'moved.txt': 'same\ncontent\nhere\n' })
    git(repo, 'mv', 'moved.txt', 'moved2.txt')
    for (let i = 0; i < 2001; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'many')
    const files = await reviewGit.listChanges(repo, base, rev(repo, 'HEAD'))
    expect(files).toHaveLength(2003)
    expect(files.find((f) => f.path === 'moved2.txt')).toMatchObject({ status: 'A' })
    expect(files.find((f) => f.path === 'moved.txt')).toMatchObject({ status: 'D' })
  })
})

describe('ReviewService', () => {
  it('lists the files of each git project and skips read-only ones', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'a.txt', 'a\n')
    const { svc } = service([
      row(repo, base),
      row(repo, null, { id: 2, projectId: 'docs', readOnly: true, branchName: null })
    ])
    const review = await svc.getReview('s1')
    expect(review.repos).toHaveLength(1)
    expect(review.repos[0]).toMatchObject({
      projectId: 'api',
      projectName: 'api',
      branch: BRANCH,
      files: [expect.objectContaining({ path: 'a.txt', status: 'A', added: 1 })]
    })
    expect(await svc.changedFileCount('s1')).toBe(1)
  })

  it('counts files across repositories', async () => {
    const a = startSession()
    const aFixture = fixture
    commitFile(a.repo, 'one.txt', '1\n')
    commitFile(a.repo, 'two.txt', '2\n')
    const b = startSession()
    commitFile(b.repo, 'three.txt', '3\n')
    const { svc } = service([
      row(a.repo, a.base),
      row(b.repo, b.base, { id: 2, projectId: 'web', projectName: 'web' })
    ])
    expect(await svc.changedFileCount('s1')).toBe(3)
    aFixture?.cleanup()
  })

  it('reviews the pending tip instead of the branch while a merge waits', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'landed.txt', 'landed\n')
    const branchTip = rev(repo, 'HEAD')
    // A commit that only exists on the pending ref.
    git(repo, 'checkout', '--detach', '-q')
    commitFile(repo, 'waiting.txt', 'waiting\n')
    git(repo, 'update-ref', pendingRef(BRANCH), rev(repo, 'HEAD'))
    git(repo, 'checkout', '-q', BRANCH)
    expect(rev(repo, BRANCH)).toBe(branchTip)

    const { svc } = service([row(repo, base)])
    const paths = (await svc.getReview('s1')).repos[0]?.files.map((f) => f.path)
    expect(paths).toEqual(['landed.txt', 'waiting.txt'])
  })

  it('does not show commits that reach dev after the session started', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'mine.txt', 'mine\n')
    git(repo, 'checkout', '-q', 'dev')
    commitFile(repo, 'someone-elses.txt', 'theirs\n')
    git(repo, 'checkout', '-q', BRANCH)

    const { svc } = service([row(repo, base)])
    const paths = (await svc.getReview('s1')).repos[0]?.files.map((f) => f.path)
    expect(paths).toEqual(['mine.txt'])
  })

  it('backfills a missing base with merge-base and stores it once', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'mine.txt', 'mine\n')
    git(repo, 'checkout', '-q', 'dev')
    commitFile(repo, 'later.txt', 'later\n')
    git(repo, 'checkout', '-q', BRANCH)

    const rows = [row(repo, null)]
    const { svc, setBaseSha } = service(rows)
    const paths = (await svc.getReview('s1')).repos[0]?.files.map((f) => f.path)
    expect(paths).toEqual(['mine.txt'])
    expect(setBaseSha).toHaveBeenCalledWith(1, base)
    expect(rows[0]?.baseSha).toBe(base)
  })

  it('re-derives a base that is no longer an ancestor, warns, and keeps the stored value', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'mine.txt', 'mine\n')
    // A sha from a history that was rewritten away.
    git(repo, 'checkout', '--orphan', 'other')
    commitFile(repo, 'stray.txt', 's\n')
    const stray = rev(repo, 'HEAD')
    git(repo, 'checkout', '-q', '-f', BRANCH)

    const rows = [row(repo, stray)]
    const { svc, setBaseSha, log } = service(rows)
    const paths = (await svc.getReview('s1')).repos[0]?.files.map((f) => f.path)
    expect(paths).toEqual(['mine.txt'])
    expect(base).toBeTruthy()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(setBaseSha).not.toHaveBeenCalled()
    expect(rows[0]?.baseSha).toBe(stray)
    await svc.getReview('s1')
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('caches by repo, base and tip and refreshes when the tip moves', async () => {
    const { repo, base } = startSession()
    commitFile(repo, 'a.txt', 'a\n')
    const spy = vi.spyOn(reviewGit, 'listChanges')
    const { svc } = service([row(repo, base)])
    await svc.getReview('s1')
    await svc.getReview('s1')
    expect(spy).toHaveBeenCalledTimes(1)
    commitFile(repo, 'b.txt', 'b\n')
    const again = await svc.getReview('s1')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(again.repos[0]?.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    spy.mockRestore()
  })
})
