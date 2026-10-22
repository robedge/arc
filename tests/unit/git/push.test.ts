import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGitAllowed, createGit } from '../../../src/main/git/git'
import type { GitExecFn } from '../../../src/main/git/git'
import { createPushGit, PUSH_TIMEOUT_MS, pushEnv } from '../../../src/main/git/push'
import {
  createGitFixture,
  createRemoteFixture,
  git,
  gitFixtureEnv
} from '../../helpers/git-fixtures'
import type { GitFixture, RemoteFixture } from '../../helpers/git-fixtures'

const accepted: string[][] = [
  ['push', '-u', 'origin', 'arc/fix-order-sync'],
  ['push', '-u', 'my.remote_2-x', 'arc/a1'],
  ['remote']
]

const refused: Array<[string, string[]]> = [
  ['force', ['push', '--force', '-u', 'origin', 'arc/x']],
  ['force after the branch', ['push', '-u', 'origin', 'arc/x', '--force']],
  ['force-with-lease', ['push', '--force-with-lease', '-u', 'origin', 'arc/x']],
  ['plus refspec', ['push', '-u', 'origin', '+arc/x']],
  ['a:b refspec', ['push', '-u', 'origin', 'arc/x:main']],
  ['push to dev', ['push', '-u', 'origin', 'dev']],
  ['delete flag', ['push', '--delete', 'origin', 'arc/x']],
  ['-d', ['push', '-d', 'origin', 'arc/x']],
  ['delete refspec', ['push', '-u', 'origin', ':arc/x']],
  ['mirror', ['push', '--mirror', 'origin']],
  ['all', ['push', '--all', 'origin']],
  ['tags', ['push', '--tags', 'origin']],
  ['tags after', ['push', '-u', 'origin', 'arc/x', '--tags']],
  ['other branch', ['push', '-u', 'origin', 'feature/x']],
  ['uppercase slug', ['push', '-u', 'origin', 'arc/Fix']],
  ['nested slug', ['push', '-u', 'origin', 'arc/a/b']],
  ['leading-dash remote', ['push', '-u', '--receive-pack=evil', 'arc/x']],
  ['leading-dash remote, plain', ['push', '-u', '-x', 'arc/x']],
  ['url remote', ['push', '-u', 'https://example.com/r.git', 'arc/x']],
  ['path remote', ['push', '-u', '/tmp/r', 'arc/x']],
  ['no -u', ['push', 'origin', 'arc/x']],
  ['no branch', ['push', '-u', 'origin']],
  ['extra arg', ['push', '-u', 'origin', 'arc/x', 'arc/y']],
  ['--set-upstream long form', ['push', '--set-upstream', 'origin', 'arc/x']],
  ['bare push', ['push']],
  ['remote add', ['remote', 'add', 'x', 'y']],
  ['remote -v', ['remote', '-v']],
  ['remote remove', ['remote', 'remove', 'origin']],
  ['fetch', ['fetch']]
]

describe('allowPush allowlist', () => {
  it.each(accepted)('accepts %s', (...args) => {
    expect(() => assertGitAllowed(args, { allowPush: true })).not.toThrow()
  })

  it.each(refused)('refuses %s even with allowPush', (_label, args) => {
    expect(() => assertGitAllowed(args, { allowPush: true })).toThrowError(
      expect.objectContaining({ kind: 'not-allowed' })
    )
  })

  it.each([...accepted.filter((a) => a[0] === 'push'), ['remote']])(
    'refuses %s without allowPush, without spawning git',
    async (...args) => {
      let spawned = false
      const exec: GitExecFn = () => {
        spawned = true
        return Promise.resolve({ stdout: '', stderr: '' })
      }
      await expect(createGit({ exec })('/nowhere', args)).rejects.toMatchObject({
        kind: 'not-allowed'
      })
      await expect(createGit({ exec, allowPush: false })('/nowhere', args)).rejects.toMatchObject({
        kind: 'not-allowed'
      })
      expect(spawned).toBe(false)
    }
  )

  it('keeps the read-only allowlist on a push runner', () => {
    expect(() =>
      assertGitAllowed(['config', '--get', 'branch.arc/x.remote'], { allowPush: true })
    ).not.toThrow()
    expect(() => assertGitAllowed(['config', 'user.name', 'x'], { allowPush: true })).toThrow()
    expect(() => assertGitAllowed(['reset', '--hard'], { allowPush: true })).toThrow()
  })
})

describe('push runner environment', () => {
  it('passes SSH_AUTH_SOCK when set, never prompts, and times out at 120 s', async () => {
    const seen: Array<{ args: string[]; timeout: number; env: NodeJS.ProcessEnv }> = []
    const exec: GitExecFn = (_file, args, options) => {
      seen.push({ args, timeout: options.timeout, env: options.env })
      const out = args.includes('rev-parse') ? 'abc\n' : args.includes('remote') ? 'origin\n' : ''
      return Promise.resolve({ stdout: out, stderr: '' })
    }
    const pushGit = createPushGit({ exec, baseEnv: { SSH_AUTH_SOCK: '/tmp/agent.sock' } })
    await pushGit.push('/repo', 'origin', 'arc/x')
    const push = seen.find((s) => s.args.includes('push'))
    expect(push?.args).toEqual(['-C', '/repo', 'push', '-u', 'origin', 'arc/x'])
    expect(push?.timeout).toBe(PUSH_TIMEOUT_MS)
    expect(PUSH_TIMEOUT_MS).toBe(120_000)
    expect(push?.env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock')
    expect(push?.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
    expect(push?.env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('leaves SSH_AUTH_SOCK out when unset', () => {
    expect(pushEnv({}).SSH_AUTH_SOCK).toBeUndefined()
    expect(pushEnv({ SSH_AUTH_SOCK: '' }).SSH_AUTH_SOCK).toBeUndefined()
    expect(pushEnv({}).GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
  })
})

describe('push against a bare remote', () => {
  const fixtures: Array<GitFixture | RemoteFixture> = []
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.cleanup()
  })
  const pushGit = createPushGit({ env: gitFixtureEnv })

  function sessionBranch(repo: string, branch = 'arc/work'): void {
    git(repo, 'checkout', '-b', branch)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'work')
  }

  it('pushes the branch with upstream tracking and returns the remote sha', async () => {
    const fx = createRemoteFixture()
    fixtures.push(fx)
    sessionBranch(fx.path)
    const sha = await pushGit.push(fx.path, 'origin', 'arc/work')
    expect(sha).toBe(git(fx.path, 'rev-parse', 'HEAD').trim())
    expect(git(fx.remote, 'rev-parse', 'refs/heads/arc/work').trim()).toBe(sha)
    expect(git(fx.path, 'config', '--get', 'branch.arc/work.remote').trim()).toBe('origin')
  })

  it('fails a non-fast-forward with git stderr', async () => {
    const fx = createRemoteFixture()
    fixtures.push(fx)
    sessionBranch(fx.path)
    await pushGit.push(fx.path, 'origin', 'arc/work')
    // Someone else moves the remote branch: a second clone commits on top and pushes.
    const other = createGitFixture({ kind: 'plain' })
    fixtures.push(other)
    git(other.path, 'init', '-b', 'dev')
    git(other.path, 'remote', 'add', 'origin', fx.remote)
    git(other.path, 'fetch', 'origin')
    git(other.path, 'checkout', '-b', 'arc/work', 'origin/arc/work')
    writeFileSync(join(other.path, 'b.txt'), 'b\n')
    git(other.path, 'add', '-A')
    git(other.path, 'commit', '-m', 'theirs')
    git(other.path, 'push', 'origin', 'arc/work')
    // Diverge locally and push again.
    writeFileSync(join(fx.path, 'c.txt'), 'c\n')
    git(fx.path, 'add', '-A')
    git(fx.path, 'commit', '-m', 'mine')
    const error = await pushGit.push(fx.path, 'origin', 'arc/work').catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'failed' })
    expect((error as { stderr: string }).stderr).toMatch(/rejected/)
    expect((error as { stderr: string }).stderr).toMatch(/fetch first|non-fast-forward/)
  })

  describe('remote selection', () => {
    it('uses the branch configured remote when it is listed', async () => {
      const fx = createRemoteFixture()
      fixtures.push(fx)
      git(fx.path, 'remote', 'add', 'upstream', fx.remote)
      git(fx.path, 'config', 'branch.arc/work.remote', 'upstream')
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBe('upstream')
    })

    it('ignores a configured "." and an unlisted remote', async () => {
      const fx = createRemoteFixture()
      fixtures.push(fx)
      git(fx.path, 'config', 'branch.arc/work.remote', '.')
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBe('origin')
      git(fx.path, 'config', 'branch.arc/work.remote', 'gone')
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBe('origin')
    })

    it('uses the only remote, whatever its name', async () => {
      const fx = createRemoteFixture()
      fixtures.push(fx)
      git(fx.path, 'remote', 'rename', 'origin', 'mine')
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBe('mine')
    })

    it('prefers origin among several remotes', async () => {
      const fx = createRemoteFixture()
      fixtures.push(fx)
      git(fx.path, 'remote', 'add', 'upstream', fx.remote)
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBe('origin')
    })

    it('has no answer among several remotes without origin', async () => {
      const fx = createRemoteFixture()
      fixtures.push(fx)
      git(fx.path, 'remote', 'rename', 'origin', 'a')
      git(fx.path, 'remote', 'add', 'b', fx.remote)
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBeNull()
    })

    it('is null without remotes', async () => {
      const fx = createGitFixture()
      fixtures.push(fx)
      expect(await pushGit.chooseRemote(fx.path, 'arc/work')).toBeNull()
    })
  })
})
