import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitError, assertGitAllowed, createGit } from '../../../src/main/git/git'
import { createWorktreeGit } from '../../../src/main/git/worktrees'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'

let fixture: GitFixture | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const runner = createGit({ env: gitFixtureEnv })

describe('worktree allowlist', () => {
  it('allows add --detach, list, prune and remove', () => {
    for (const args of [
      ['worktree', 'add', '--detach', '/x', 'arc/a'],
      ['worktree', 'list'],
      ['worktree', 'prune'],
      ['worktree', 'remove', '/x']
    ]) {
      expect(() => assertGitAllowed(args)).not.toThrow()
    }
  })

  it('refuses a worktree with a branch of its own, and unknown worktree actions', () => {
    for (const args of [
      ['worktree', 'add', '-b', 'new', '/x', 'dev'],
      ['worktree', 'add', '/x', 'dev'],
      ['worktree', 'move', '/a', '/b'],
      ['worktree', 'lock', '/a']
    ]) {
      expect(() => assertGitAllowed(args)).toThrow(GitError)
    }
  })
})

describe('createWorktreeGit', () => {
  it('adds a detached worktree at the ref, with no new branch, and reports its base sha', async () => {
    fixture = createGitFixture()
    git(fixture.path, 'checkout', '-b', 'arc/work')
    git(fixture.path, 'commit', '--allow-empty', '-m', 'Tip')
    const tip = git(fixture.path, 'rev-parse', 'HEAD').trim()
    const branches = git(fixture.path, 'branch', '--format=%(refname:short)')
    const wt = createWorktreeGit(runner)
    const path = join(fixture.path, '..', 'wt', 'repo')

    const { baseSha } = await wt.addDetached(fixture.path, path, 'arc/work')
    expect(baseSha).toBe(tip)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(() => git(path, 'symbolic-ref', '-q', 'HEAD')).toThrow()
    expect(git(fixture.path, 'branch', '--format=%(refname:short)')).toBe(branches)
    expect(await wt.headSha(path)).toBe(tip)
  })

  it('lists the commits made since the base, oldest first', async () => {
    fixture = createGitFixture()
    const wt = createWorktreeGit(runner)
    const path = join(fixture.path, '..', 'wt2', 'repo')
    const { baseSha } = await wt.addDetached(fixture.path, path, 'dev')
    expect(await wt.commitsSince(path, baseSha)).toEqual([])
    writeFileSync(join(path, 'a.txt'), 'a')
    git(path, 'add', 'a.txt')
    git(path, 'commit', '-m', 'First | with pipe')
    writeFileSync(join(path, 'b.txt'), 'b')
    git(path, 'add', 'b.txt')
    git(path, 'commit', '-m', 'Second')
    const commits = await wt.commitsSince(path, baseSha)
    expect(commits.map((c) => c.subject)).toEqual(['First | with pipe', 'Second'])
    expect(commits[1]?.sha).toBe(await wt.headSha(path))
  })

  it('removes a clean worktree but refuses one with changes unless forced', async () => {
    fixture = createGitFixture()
    const wt = createWorktreeGit(runner)
    const path = join(fixture.path, '..', 'wt3', 'repo')
    await wt.addDetached(fixture.path, path, 'dev')
    writeFileSync(join(path, 'dirty.txt'), 'x')
    await expect(wt.remove(fixture.path, path)).rejects.toThrow(GitError)
    expect(existsSync(path)).toBe(true)
    await wt.remove(fixture.path, path, { force: true })
    expect(existsSync(path)).toBe(false)
  })
})

describe('diffStatSince', () => {
  it('lists committed, uncommitted and untracked changes since the base, and nothing when clean', async () => {
    fixture = createGitFixture()
    const wt = createWorktreeGit(runner)
    const base = git(fixture.path, 'rev-parse', 'HEAD').trim()
    expect(await wt.diffStatSince(fixture.path, base)).toEqual([])

    writeFileSync(join(fixture.path, 'committed.txt'), 'one\ntwo\n')
    git(fixture.path, 'add', 'committed.txt')
    git(fixture.path, 'commit', '-m', 'Add committed')
    writeFileSync(join(fixture.path, 'README.md'), 'changed but not committed\n')
    writeFileSync(join(fixture.path, 'fresh.txt'), 'untracked\n')

    const stat = await wt.diffStatSince(fixture.path, base)
    expect(stat).toHaveLength(3)
    expect(stat[0]).toMatch(/^README\.md \|/)
    expect(stat[1]).toMatch(/^committed\.txt \| 2 \+\+$/)
    expect(stat[2]).toBe('fresh.txt | untracked')
    // git's own "N files changed" summary line is not part of the result.
    expect(stat.some((l) => l.includes('changed,'))).toBe(false)
  })
})
