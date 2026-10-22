import { afterEach, describe, expect, it } from 'vitest'
import { createGit, GitError } from '../../../src/main/git/git'
import type { GitExecFn } from '../../../src/main/git/git'
import { createGitFixture, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'

const fixtures: GitFixture[] = []
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup()
})

describe('git wrapper allowlist', () => {
  const git = createGit({ env: gitFixtureEnv })

  it.each([
    ['push', ['push', 'origin', 'dev']],
    ['fetch', ['fetch']],
    ['pull', ['pull']],
    ['remote', ['remote', 'add', 'x', 'y']],
    ['reset --hard', ['reset', '--hard', 'HEAD~1']],
    ['stash drop', ['stash', 'drop']],
    ['branch -D', ['branch', '-D', 'dev']],
    ['checkout -- .', ['checkout', '--', '.']],
    ['config write', ['config', 'user.name', 'x']]
  ])('rejects %s without spawning git', async (_label, args) => {
    let spawned = false
    const exec: GitExecFn = () => {
      spawned = true
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const guarded = createGit({ exec })
    await expect(guarded('/nowhere', args)).rejects.toMatchObject({ kind: 'not-allowed' })
    expect(spawned).toBe(false)
  })

  it('runs allowed commands with -C, a timeout and a non-interactive env', async () => {
    let seen: { args: string[]; timeout: number; env: NodeJS.ProcessEnv } | null = null
    const exec: GitExecFn = (_file, args, options) => {
      seen = { args, timeout: options.timeout, env: options.env }
      return Promise.resolve({ stdout: 'ok', stderr: '' })
    }
    const out = await createGit({ exec })('/some/repo', ['status', '--porcelain=v1'])
    expect(out).toBe('ok')
    expect(seen).toMatchObject({ args: ['-C', '/some/repo', 'status', '--porcelain=v1'] })
    expect(seen!.timeout).toBeGreaterThan(0)
    expect(seen!.env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('never lets a read take index.lock, so it cannot make a fast-forward merge fail', async () => {
    let env: NodeJS.ProcessEnv = {}
    const exec: GitExecFn = (_file, _args, options) => {
      env = options.env
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    await createGit({ exec, env: { GIT_OPTIONAL_LOCKS: '1' } })('/some/repo', ['status'])
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
  })

  it('throws a GitError carrying stderr when git fails', async () => {
    const fx = createGitFixture({ kind: 'plain' })
    fixtures.push(fx)
    const error = await git(fx.path, ['status']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).kind).toBe('failed')
    expect((error as GitError).stderr).toMatch(/not a git repository/i)
  })
})
