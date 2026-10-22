import { execFile } from 'node:child_process'

/**
 * Typed wrapper over the system `git`. Only an allowlist of subcommands can run; `fetch`, `pull` and `reset`
 * do not exist here, and a handful of destructive flags are refused even on allowed subcommands. Arc never
 * merges into the user's branches (tech spec 2.7). Pushes happen only from the user's click in the review
 * (spec 004, tech spec 2.5): `push` and `remote` exist solely on a runner made with the `allowPush` option, which
 * only `push.ts` builds, and even there only the exact forms in `isPushAllowed` run.
 */

export const DEFAULT_GIT_TIMEOUT_MS = 15_000
/** Used for commands that touch many files (add, commit, stash, merge, worktree). */
export const LONG_GIT_TIMEOUT_MS = 60_000

const MAX_BUFFER = 32 * 1024 * 1024

const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'branch',
  'checkout',
  'switch',
  'worktree',
  'merge',
  'stash',
  'commit',
  'add',
  'rev-parse',
  'symbolic-ref',
  'update-ref',
  'diff',
  'log',
  'rev-list',
  'config',
  'show-ref',
  'merge-base'
])

/** The only `git merge` options Arc uses (tech spec 2.7): merges in the temporary merge worktree, fast-forwards, aborts. */
const ALLOWED_MERGE_FLAGS: ReadonlySet<string> = new Set([
  '--no-ff',
  '--ff-only',
  '--no-edit',
  '--abort',
  '--no-verify'
])

export type GitErrorKind = 'not-allowed' | 'failed' | 'timeout'

export class GitError extends Error {
  readonly kind: GitErrorKind
  readonly args: readonly string[]
  readonly stderr: string
  readonly exitCode: number | null

  constructor(
    kind: GitErrorKind,
    args: readonly string[],
    message: string,
    stderr = '',
    exitCode: number | null = null
  ) {
    super(message)
    this.name = 'GitError'
    this.kind = kind
    this.args = args
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export interface GitExecOptions {
  timeout: number
  env: NodeJS.ProcessEnv
  maxBuffer: number
}

/** Injectable process runner (same idea as `ExecFn` in project-service). Rejects on non-zero exit. */
export type GitExecFn = (
  file: string,
  args: string[],
  options: GitExecOptions
) => Promise<{ stdout: string; stderr: string }>

export interface GitRunOptions {
  timeoutMs?: number
}

/** Runs `git -C <repo> <args>` and resolves with stdout (not trimmed). Throws `GitError`. */
export type GitRunner = (
  repo: string,
  args: readonly string[],
  options?: GitRunOptions
) => Promise<string>

export interface CreateGitOptions {
  exec?: GitExecFn
  /** Extra environment (tests set GIT_CONFIG_GLOBAL, author identity). `GIT_TERMINAL_PROMPT=0` always wins. */
  env?: NodeJS.ProcessEnv
  /**
   * Accept `push -u <remote> arc/<slug>` and `remote` (see `assertGitAllowed`). Default false. Only
   * `src/main/git/push.ts` sets it (a unit test scans the sources for that).
   */
  allowPush?: boolean
}

const defaultExec: GitExecFn = (file, args, options) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(
          Object.assign(new Error(error.message), {
            code: error.code,
            killed: error.killed,
            stdout,
            stderr
          })
        )
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR']

export function minimalGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH_ENV) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function refuse(args: readonly string[], why: string): never {
  throw new GitError('not-allowed', args, `git ${args.join(' ')} is not allowed: ${why}`)
}

/** `<40 lowercase hex sha> -- <path>...` with at least one path and no other option. */
function isRestoreFromCommit(rest: readonly string[]): boolean {
  const [sha, separator, ...paths] = rest
  return (
    sha !== undefined &&
    /^[0-9a-f]{40}$/.test(sha) &&
    separator === '--' &&
    paths.length > 0 &&
    paths.every((p) => p !== '' && p !== '--')
  )
}

const PUSH_REMOTE = /^[\w.-]+$/
const PUSH_BRANCH = /^arc\/[a-z0-9-]+$/

/**
 * The only invocations `allowPush` adds: exactly `push -u <remote> <branch>` (remote of word characters, dots
 * and dashes that does not start with a dash; branch `arc/<slug>`), and `remote` with no arguments. No
 * refspec (`:`), `+`, force, delete, mirror, tags or any other flag or argument fits these shapes.
 */
function isPushAllowed(args: readonly string[]): boolean {
  if (args.length === 1) return args[0] === 'remote'
  if (args.length !== 4 || args[0] !== 'push' || args[1] !== '-u') return false
  const remote = args[2] as string
  const branch = args[3] as string
  return PUSH_REMOTE.test(remote) && !remote.startsWith('-') && PUSH_BRANCH.test(branch)
}

/** Throws a `not-allowed` GitError unless the argument list is a permitted git invocation. */
export function assertGitAllowed(
  args: readonly string[],
  options: { allowPush?: boolean } = {}
): void {
  if (options.allowPush === true && (args[0] === 'push' || args[0] === 'remote')) {
    if (isPushAllowed(args)) return
    refuse(args, 'only "push -u <remote> arc/<branch>" and "remote" are allowed')
  }
  const sub = args[0]
  if (sub === undefined || !ALLOWED_SUBCOMMANDS.has(sub)) {
    refuse(args, `subcommand "${sub ?? ''}" is not on the allowlist`)
  }
  const rest = args.slice(1)
  if (rest.includes('--hard')) refuse(args, 'hard resets are never run')
  if (sub === 'config' && rest[0] !== '--get') refuse(args, 'config is read-only (--get)')
  if (sub === 'worktree') {
    // Arc only creates detached worktrees (no branch of their own), lists, prunes and removes them.
    const action = rest[0]
    if (action === 'add') {
      if (!rest.includes('--detach')) refuse(args, 'worktrees are always created detached')
    } else if (action !== 'list' && action !== 'prune' && action !== 'remove') {
      refuse(args, 'only worktree add --detach, list, prune and remove are allowed')
    }
  }
  if (sub === 'merge') {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string
      if (arg === '-m') {
        i += 1 // the message
      } else if (arg.startsWith('-') && !ALLOWED_MERGE_FLAGS.has(arg)) {
        refuse(
          args,
          'only merge --no-ff, --ff-only, --no-edit, --no-verify, -m and --abort are allowed'
        )
      }
    }
  }
  if (sub === 'stash') {
    const action = rest[0]
    if (action !== 'push' && action !== 'list' && action !== 'show') {
      refuse(args, 'only stash push, list and show are allowed')
    }
  }
  if (sub === 'branch') {
    const deletes = rest.some((a) => /^(-d|-D|--delete|-m|-M|--move|-f|--force)$/.test(a))
    if (deletes) refuse(args, 'branches are never deleted, moved or forced')
  }
  if (sub === 'checkout' || sub === 'switch') {
    // The one exception: restoring paths from a commit in Arc's own temporary merge worktree (Undo changes).
    if (sub === 'checkout' && isRestoreFromCommit(rest)) return
    if (
      rest.some((a) => a === '--' || a === '-f' || a === '--force' || a === '--discard-changes')
    ) {
      refuse(args, 'discarding working-tree changes is never done')
    }
  }
}

export function createGit(options: CreateGitOptions = {}): GitRunner {
  const exec = options.exec ?? defaultExec
  const allowPush = options.allowPush === true
  const env: NodeJS.ProcessEnv = {
    ...minimalGitEnv(),
    ...options.env,
    GIT_TERMINAL_PROMPT: '0',
    // `status` and `diff` refresh the index and hold index.lock while they do. Arc reads the user's checkout
    // in the background (the review's counts) while a fast-forward merge may need that same lock; with the
    // lock taken, the merge fails and is left "waiting for your checkout" although the checkout is clean.
    // Commands that really write (merge, commit, add) still take the lock.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '',
    GIT_EDITOR: ':',
    GIT_MERGE_AUTOEDIT: 'no'
  }
  return async (repo, args, runOptions) => {
    assertGitAllowed(args, { allowPush })
    const full = ['-C', repo, ...args]
    try {
      const { stdout } = await exec('git', full, {
        timeout: runOptions?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        env,
        maxBuffer: MAX_BUFFER
      })
      return stdout
    } catch (error: unknown) {
      throw toGitError(args, error)
    }
  }
}

function toGitError(args: readonly string[], error: unknown): GitError {
  if (error instanceof GitError) return error
  const e = (error ?? {}) as {
    stderr?: unknown
    code?: unknown
    killed?: unknown
    message?: unknown
  }
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : ''
  const exitCode = typeof e.code === 'number' ? e.code : null
  const label = `git ${args.join(' ')}`
  if (e.killed === true) {
    return new GitError('timeout', args, `${label} timed out`, stderr, exitCode)
  }
  const detail = stderr || (typeof e.message === 'string' ? e.message : String(error))
  return new GitError('failed', args, `${label} failed: ${detail}`, stderr, exitCode)
}
