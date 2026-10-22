import { createGit, GitError } from './git'
import type { GitExecFn, GitRunner } from './git'

/**
 * The one place that builds a git runner able to push (spec 004, tech spec 2.5). Pushing is the user's click
 * in the review: nothing in the MCP bridge or the orchestrator can reach this module, and the runner it makes
 * only accepts `push -u <remote> arc/<slug>` and `remote` on top of the normal read-only allowlist.
 */

/** A push may wait on the network; it runs outside the merge queue so it never stalls merges. */
export const PUSH_TIMEOUT_MS = 120_000

export interface PushGit {
  /**
   * The remote a push of `branch` goes to: the branch's configured remote when it exists, else the only remote,
   * else `origin` when listed, else null (no remote).
   */
  chooseRemote(repo: string, branch: string): Promise<string | null>
  /** `push -u <remote> <branch>`, then the sha the remote now has for the branch. Throws `GitError`. */
  push(repo: string, remote: string, branch: string): Promise<string>
}

export interface CreatePushGitOptions {
  exec?: GitExecFn
  /** Extra environment (tests set the fixture identity and `GIT_CONFIG_GLOBAL`). */
  env?: NodeJS.ProcessEnv
  /** Where `SSH_AUTH_SOCK` is read from; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv
}

/** The environment of the push runner: SSH agent passed through, ssh never prompts, git never prompts. */
export function pushEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const sock = baseEnv.SSH_AUTH_SOCK
  if (sock !== undefined && sock !== '') env.SSH_AUTH_SOCK = sock
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return { ...env, ...extra }
}

export function createPushGit(options: CreatePushGitOptions = {}): PushGit {
  const git: GitRunner = createGit({
    allowPush: true,
    env: pushEnv(options.baseEnv, options.env),
    ...(options.exec ? { exec: options.exec } : {})
  })

  async function listRemotes(repo: string): Promise<string[]> {
    const out = await git(repo, ['remote'])
    return out.split('\n').filter((r) => r !== '')
  }

  /** git exits 1 when the key is unset. */
  async function configuredRemote(repo: string, branch: string): Promise<string | null> {
    try {
      const out = await git(repo, ['config', '--get', `branch.${branch}.remote`])
      return out.trim() || null
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === 'failed') return null
      throw error
    }
  }

  async function revParse(repo: string, ref: string): Promise<string | null> {
    try {
      return (await git(repo, ['rev-parse', '--verify', '-q', ref])).trim() || null
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === 'failed') return null
      throw error
    }
  }

  return {
    async chooseRemote(repo, branch) {
      const remotes = await listRemotes(repo)
      if (remotes.length === 0) return null
      const configured = await configuredRemote(repo, branch)
      // "." (the repository itself) is never a remote to push to; only listed remotes qualify.
      if (configured !== null && remotes.includes(configured)) return configured
      if (remotes.length === 1) return remotes[0] as string
      return remotes.includes('origin') ? 'origin' : null
    },
    async push(repo, remote, branch) {
      await git(repo, ['push', '-u', remote, branch], { timeoutMs: PUSH_TIMEOUT_MS })
      const pushed = await revParse(repo, `refs/remotes/${remote}/${branch}`)
      if (pushed !== null) return pushed
      const local = await revParse(repo, `refs/heads/${branch}`)
      if (local === null) throw new Error(`${branch} no longer exists`)
      return local
    }
  }
}
