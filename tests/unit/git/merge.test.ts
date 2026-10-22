import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitError, assertGitAllowed, createGit } from '../../../src/main/git/git'
import { PENDING_REF_PREFIX, createMergeGit } from '../../../src/main/git/merge'
import { MergeQueue } from '../../../src/main/git/merge-queue'
import { createSessionGit } from '../../../src/main/git/session-git'
import { sweepWorktrees } from '../../../src/main/git/worktree-sweep'
import { createWorktreeGit } from '../../../src/main/git/worktrees'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'

let fixture: GitFixture | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const runner = createGit({ env: gitFixtureEnv })
const mergeGit = createMergeGit(runner, createSessionGit(runner))
const worktrees = createWorktreeGit(runner)
const BRANCH = 'arc/work'

/** A repo on `arc/work` (as after session start) plus a worker working copy with one commit. */
async function setup(): Promise<{ repo: string; root: string; worker: string; head: string }> {
  fixture = createGitFixture()
  const repo = fixture.path
  git(repo, 'checkout', '-b', BRANCH)
  const root = join(repo, '..', 'wt')
  mkdirSync(root)
  const worker = join(root, 'worker')
  await worktrees.addDetached(repo, worker, BRANCH)
  writeFileSync(join(worker, 'retry.txt'), 'retry\n')
  git(worker, 'add', 'retry.txt')
  git(worker, 'commit', '-m', 'Add retry')
  return { repo, root, worker, head: git(worker, 'rev-parse', 'HEAD').trim() }
}

async function mergeIn(repo: string, root: string, head: string): Promise<string> {
  const tip = await mergeGit.sessionTip(repo, BRANCH)
  const path = join(root, 'merge')
  await mergeGit.addDetached(repo, path, tip.effectiveTip)
  const attempt = await mergeGit.mergeNoFf(path, head, 'Merge W1 api-retry')
  expect(attempt.status).toBe('clean')
  return mergeGit.headSha(path)
}

describe('git allowlist for merging', () => {
  it('allows the merge forms Arc uses', () => {
    for (const args of [
      ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', 'Merge W1 x', 'abc123'],
      ['merge', '--ff-only', 'abc123'],
      ['merge', '--no-edit', 'abc123'],
      ['merge', '--abort'],
      ['merge-base', '--is-ancestor', 'a', 'b'],
      ['update-ref', 'refs/arc/pending/x', 'abc123']
    ]) {
      expect(() => assertGitAllowed(args)).not.toThrow()
    }
  })

  it('still refuses push, fetch, pull, reset and unlisted merge options', () => {
    for (const args of [
      ['push'],
      ['fetch'],
      ['pull'],
      ['reset', '--hard'],
      ['merge', '--squash', 'x'],
      ['merge', '-X', 'theirs', 'x'],
      ['merge', '--strategy=ours', 'x'],
      ['merge', '--allow-unrelated-histories', 'x']
    ]) {
      expect(() => assertGitAllowed(args)).toThrow(GitError)
    }
  })
})

describe('MergeGit.publish', () => {
  it('fast-forwards a clean checkout that is on the session branch (ref and files move together)', async () => {
    const { repo, root, head } = await setup()
    const tip = await mergeGit.sessionTip(repo, BRANCH)
    const merged = await mergeIn(repo, root, head)

    expect(await mergeGit.publish(repo, BRANCH, tip.branchTip, merged)).toBe('fast-forwarded')
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(merged)
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(merged)
    expect(readFileSync(join(repo, 'retry.txt'), 'utf8')).toBe('retry\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('leaves a dirty checkout alone and keeps the merge as a pending fast-forward', async () => {
    const { repo, root, head } = await setup()
    const before = git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()
    writeFileSync(join(repo, 'README.md'), 'hello\nmy unsaved edit\n')
    const merged = await mergeIn(repo, root, head)

    expect(await mergeGit.publish(repo, BRANCH, before, merged)).toBe('pending')
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(before)
    expect(git(repo, 'rev-parse', `${PENDING_REF_PREFIX}work`).trim()).toBe(merged)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello\nmy unsaved edit\n')
    expect(existsSync(join(repo, 'retry.txt'))).toBe(false)

    // The next merge builds on the pending tip.
    const tip = await mergeGit.sessionTip(repo, BRANCH)
    expect(tip).toMatchObject({ branchTip: before, pendingTip: merged, effectiveTip: merged })
    expect(tip.diverged).toBe(false)
  })

  it('applies the pending fast-forward once the checkout is clean, and drops the pending ref', async () => {
    const { repo, root, head } = await setup()
    const before = git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()
    writeFileSync(join(repo, 'README.md'), 'hello\nedit\n')
    const merged = await mergeIn(repo, root, head)
    await mergeGit.publish(repo, BRANCH, before, merged)

    expect(await mergeGit.retryPending(repo, BRANCH)).toBe('pending')
    git(repo, 'checkout', 'README.md')
    expect(await mergeGit.retryPending(repo, BRANCH)).toBe('fast-forwarded')
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(merged)
    expect(readFileSync(join(repo, 'retry.txt'), 'utf8')).toBe('retry\n')
    expect(() => git(repo, 'rev-parse', '--verify', '-q', `${PENDING_REF_PREFIX}work`)).toThrow()
    expect(await mergeGit.retryPending(repo, BRANCH)).toBe('none')
  })

  it('moves only the ref when the user switched to another branch', async () => {
    const { repo, root, head } = await setup()
    const before = git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()
    git(repo, 'checkout', 'dev')
    const merged = await mergeIn(repo, root, head)

    expect(await mergeGit.publish(repo, BRANCH, before, merged)).toBe('ref-updated')
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(merged)
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('dev')
    expect(existsSync(join(repo, 'retry.txt'))).toBe(false)
  })

  it('reports moved when the branch is no longer where the merge started', async () => {
    const { repo, root, head } = await setup()
    const before = git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()
    const merged = await mergeIn(repo, root, head)
    writeFileSync(join(repo, 'mine.txt'), 'mine\n')
    git(repo, 'add', 'mine.txt')
    git(repo, 'commit', '-m', 'My own commit')
    const mine = git(repo, 'rev-parse', 'HEAD').trim()

    expect(await mergeGit.publish(repo, BRANCH, before, merged)).toBe('moved')
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(mine)
    git(repo, 'checkout', 'dev')
    expect(await mergeGit.publish(repo, BRANCH, before, merged)).toBe('moved')
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(mine)
  })

  it('flags a branch that moved on while a merge was pending', async () => {
    const { repo, root, head } = await setup()
    const before = git(repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()
    writeFileSync(join(repo, 'README.md'), 'hello\nedit\n')
    const merged = await mergeIn(repo, root, head)
    await mergeGit.publish(repo, BRANCH, before, merged)
    // The user commits their edit on the branch themselves.
    git(repo, 'commit', '-am', 'My commit')

    const tip = await mergeGit.sessionTip(repo, BRANCH)
    expect(tip.diverged).toBe(true)
    expect(await mergeGit.retryPending(repo, BRANCH)).toBe('diverged')
  })
})

describe('MergeGit merging', () => {
  it('reports conflicting files and leaves the merge to be aborted', async () => {
    const { repo, root, worker } = await setup()
    writeFileSync(join(worker, 'README.md'), 'hello\nfrom worker\n')
    git(worker, 'commit', '-am', 'Worker readme')
    const head = git(worker, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(repo, 'README.md'), 'hello\nfrom user\n')
    git(repo, 'commit', '-am', 'User readme')

    const tip = await mergeGit.sessionTip(repo, BRANCH)
    const path = join(root, 'merge')
    await mergeGit.addDetached(repo, path, tip.effectiveTip)
    const attempt = await mergeGit.mergeNoFf(path, head, 'Merge W1')
    expect(attempt).toEqual({ status: 'conflict', files: ['README.md'] })
    expect(await mergeGit.mergeInProgress(path)).toBe(true)
    await mergeGit.abortMerge(path)
    expect(await mergeGit.mergeInProgress(path)).toBe(false)
    expect(await mergeGit.headSha(path)).toBe(tip.effectiveTip)
  })

  it('lists the commits of the session branch and the files a merge changed', async () => {
    const { repo, root, head } = await setup()
    const tip = await mergeGit.sessionTip(repo, BRANCH)
    const merged = await mergeIn(repo, root, head)
    await mergeGit.publish(repo, BRANCH, tip.branchTip, merged)
    expect(await mergeGit.changedFiles(repo, tip.branchTip, merged)).toEqual(['retry.txt'])
    const commits = await mergeGit.commitsOnBranch(repo, 'dev', merged)
    expect(commits.map((c) => c.subject)).toEqual(['Merge W1 api-retry', 'Add retry'])
    // A base that does not exist falls back to the newest commits.
    expect((await mergeGit.commitsOnBranch(repo, 'gone', merged)).length).toBe(3)
  })
})

describe('MergeQueue', () => {
  it('runs the jobs of one key one at a time, in order, and keeps going after a failure', async () => {
    const queue = new MergeQueue()
    const order: string[] = []
    const job =
      (name: string, ms: number, fail = false) =>
      async (): Promise<string> => {
        order.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`${name}:end`)
        if (fail) throw new Error(name)
        return name
      }
    const a = queue.run('repo', job('a', 30, true))
    const b = queue.run('repo', job('b', 5))
    const other = queue.run('other', job('o', 5))
    await expect(a).rejects.toThrow('a')
    expect(await b).toBe('b')
    expect(await other).toBe('o')
    expect(order.indexOf('a:end')).toBeLessThan(order.indexOf('b:start'))
    expect(order.indexOf('o:start')).toBeLessThan(order.indexOf('a:end'))
    await new Promise((r) => setTimeout(r, 0))
    expect(queue.isBusy('repo')).toBe(false)
  })
})

describe('launch sweep', () => {
  it('removes leftover _merge folders, prunes git, and leaves worker working copies alone', async () => {
    const { repo, root, worker } = await setup()
    const sessionRoot = join(root, 'S1')
    const leftover = join(sessionRoot, '_merge', 'repo')
    mkdirSync(join(sessionRoot, '_merge'), { recursive: true })
    await worktrees.addDetached(repo, leftover, BRANCH)
    expect(git(repo, 'worktree', 'list')).toContain(leftover)

    const result = await sweepWorktrees({
      worktreesRoot: root,
      repoPaths: [repo, join(root, 'missing')],
      worktreeGit: worktrees,
      log: { warn: () => undefined }
    })
    expect(result.removedMergeDirs).toEqual([join(sessionRoot, '_merge')])
    expect(result.pruned).toEqual([repo])
    expect(existsSync(leftover)).toBe(false)
    expect(git(repo, 'worktree', 'list')).not.toContain(leftover)
    expect(git(repo, 'worktree', 'list')).toContain(worker)
    expect(existsSync(worker)).toBe(true)
  })
})
