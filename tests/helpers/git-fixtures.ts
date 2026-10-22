import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fixed identity and dates so commit hashes are reproducible. */
const FIXED_DATE = '2026-01-01T00:00:00Z'

export const gitFixtureEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Arc Test',
  GIT_AUTHOR_EMAIL: 'arc-test@example.com',
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_NAME: 'Arc Test',
  GIT_COMMITTER_EMAIL: 'arc-test@example.com',
  GIT_COMMITTER_DATE: FIXED_DATE
}

export type GitFixtureKind = 'clean' | 'dirty' | 'no-dev' | 'plain'

export interface GitFixtureOptions {
  /** clean: repo on `dev` with one commit. dirty: clean plus a modified tracked file and an untracked file.
   *  no-dev: repo on `main` with one commit. plain: an ordinary folder, not a git repo. */
  kind?: GitFixtureKind
}

export interface GitFixture {
  /** Absolute path of the repo (or plain folder). */
  path: string
  /** Removes the whole temp directory. Safe to call twice. */
  cleanup: () => void
}

export const trackedFile = 'README.md'
export const untrackedFile = 'untracked.txt'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitFixtureEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export function createGitFixture(options: GitFixtureOptions = {}): GitFixture {
  const kind = options.kind ?? 'clean'
  const root = mkdtempSync(join(tmpdir(), 'arc-git-'))
  const path = join(root, 'repo')
  mkdirSync(path)
  const cleanup = (): void => rmSync(root, { recursive: true, force: true })

  if (kind === 'plain') {
    writeFileSync(join(path, 'note.txt'), 'not a repo\n')
    return { path, cleanup }
  }

  try {
    git(path, 'init', '-b', kind === 'no-dev' ? 'main' : 'dev')
    writeFileSync(join(path, trackedFile), 'hello\n')
    git(path, 'add', trackedFile)
    git(path, 'commit', '-m', 'Initial commit')
    if (kind === 'dirty') {
      writeFileSync(join(path, trackedFile), 'hello\nchanged\n')
      writeFileSync(join(path, untrackedFile), 'new\n')
    }
  } catch (error: unknown) {
    cleanup()
    throw error
  }
  return { path, cleanup }
}

export interface RemoteFixture {
  /** A bare repository standing in for the remote. */
  remote: string
  /** A working clone on `dev` with one commit, `origin` pointing at `remote`, and `dev` already pushed. */
  path: string
  /** Removes the whole temp directory. Safe to call twice. */
  cleanup: () => void
}

/** A bare remote plus a working clone with `dev` pushed. Pushes in tests go only to this temp remote. */
export function createRemoteFixture(): RemoteFixture {
  const root = mkdtempSync(join(tmpdir(), 'arc-remote-'))
  const remote = join(root, 'remote.git')
  const path = join(root, 'repo')
  const cleanup = (): void => rmSync(root, { recursive: true, force: true })
  try {
    mkdirSync(remote)
    git(remote, 'init', '--bare', '-b', 'dev')
    mkdirSync(path)
    git(path, 'init', '-b', 'dev')
    writeFileSync(join(path, trackedFile), 'hello\n')
    git(path, 'add', trackedFile)
    git(path, 'commit', '-m', 'Initial commit')
    git(path, 'remote', 'add', 'origin', remote)
    git(path, 'push', '-u', 'origin', 'dev')
  } catch (error: unknown) {
    cleanup()
    throw error
  }
  return { remote, path, cleanup }
}
