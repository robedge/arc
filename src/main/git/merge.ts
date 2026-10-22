import { GitError, LONG_GIT_TIMEOUT_MS } from './git'
import type { GitRunner } from './git'
import { SESSION_BRANCH_PREFIX } from './session-git'
import type { SessionGit } from './session-git'

/**
 * Git operations behind `merge_worker` and `sync_worker` (tech spec 2.7).
 *
 * Moving the session branch. `arc/<slug>` is checked out in the user's own checkout, so moving only
 * its ref (`update-ref`) would make the user's index and files look as if the merge had been undone.
 *  - Checkout on the branch and clean: `merge --ff-only <new>` there moves the ref and the files together.
 *  - Checkout on the branch and dirty: nothing is touched. The merge commit is kept under
 *    `refs/arc/pending/<slug>` ("pending fast-forward"); the next merge builds on it, and the
 *    fast-forward is retried on the next merge, when the session opens and when the session ends.
 *  - Checkout elsewhere (the user switched away): the branch is checked out nowhere, so
 *    `update-ref refs/heads/arc/<slug> <new> <old>` is safe; the old-value check catches a moved branch.
 */

export const PENDING_REF_PREFIX = 'refs/arc/pending/'
/** Folder under `userData/worktrees/<sessionId>/` that holds the temporary merge worktrees. */
export const MERGE_DIR = '_merge'

export interface SessionTip {
  /** `refs/heads/arc/<slug>`. */
  branchTip: string
  /** The merge commit waiting for a fast-forward, if any. */
  pendingTip: string | null
  /** The commit new merges build on: the pending tip when there is one, else the branch tip. */
  effectiveTip: string
  /** The branch moved on (the user committed on it) while a pending merge waited. */
  diverged: boolean
}

export type PublishOutcome = 'fast-forwarded' | 'ref-updated' | 'pending' | 'moved'

export type MergeAttempt =
  { status: 'clean'; head: string; changed: boolean } | { status: 'conflict'; files: string[] }

export interface CommitLine {
  sha: string
  subject: string
}

export interface MergeGit {
  sessionTip(repo: string, branch: string): Promise<SessionTip>
  /** `worktree add --detach <path> <sha>`. */
  addDetached(repo: string, path: string, sha: string): Promise<void>
  headSha(worktree: string): Promise<string>
  /** `merge --no-ff --no-edit -m <message> <sha>`; conflicts leave the merge in progress. */
  mergeNoFf(worktree: string, sha: string, message: string): Promise<MergeAttempt>
  /** `merge --no-edit <sha>` (may fast-forward); used to share changes into a worker's working copy. */
  mergeInto(worktree: string, sha: string): Promise<MergeAttempt>
  unmergedFiles(worktree: string): Promise<string[]>
  mergeInProgress(worktree: string): Promise<boolean>
  /** `commit --no-edit` for a merge whose conflicts are all staged. */
  commitMerge(worktree: string): Promise<void>
  abortMerge(worktree: string): Promise<void>
  isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean>
  /** Moves the session branch to `newSha` (see the module comment). `expectedBranchTip` is the old value. */
  publish(
    repo: string,
    branch: string,
    expectedBranchTip: string,
    newSha: string
  ): Promise<PublishOutcome>
  /** Retries a pending fast-forward. */
  retryPending(repo: string, branch: string): Promise<'none' | 'diverged' | PublishOutcome>
  changedFiles(repo: string, from: string, to: string): Promise<string[]>
  /** `log --oneline <base>..<tip>`, newest first; without a usable base, the last commits of the tip. */
  commitsOnBranch(repo: string, base: string | null, tip: string): Promise<CommitLine[]>
}

export function pendingRef(branch: string): string {
  const name = branch.startsWith(SESSION_BRANCH_PREFIX)
    ? branch.slice(SESSION_BRANCH_PREFIX.length)
    : branch
  return `${PENDING_REF_PREFIX}${name}`
}

export function createMergeGit(git: GitRunner, sessionGit: SessionGit): MergeGit {
  async function tryGit(repo: string, args: string[]): Promise<string | null> {
    try {
      return (await git(repo, args)).trim()
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === 'failed') return null
      throw error
    }
  }

  async function revParse(repo: string, ref: string): Promise<string | null> {
    return tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  }

  async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await tryGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant])) !== null
  }

  async function unmergedFiles(worktree: string): Promise<string[]> {
    const out = await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])
    return out.split('\0').filter((p) => p !== '')
  }

  async function headSha(worktree: string): Promise<string> {
    return (await git(worktree, ['rev-parse', 'HEAD'])).trim()
  }

  async function attempt(worktree: string, args: string[]): Promise<MergeAttempt> {
    const before = await headSha(worktree)
    try {
      await git(worktree, args, { timeoutMs: LONG_GIT_TIMEOUT_MS })
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === 'failed') {
        const files = await unmergedFiles(worktree)
        if (files.length > 0) return { status: 'conflict', files }
      }
      throw error
    }
    const head = await headSha(worktree)
    return { status: 'clean', head, changed: head !== before }
  }

  async function sessionTip(repo: string, branch: string): Promise<SessionTip> {
    const branchTip = await revParse(repo, `refs/heads/${branch}`)
    if (branchTip === null) throw new Error(`The session branch ${branch} no longer exists.`)
    const ref = pendingRef(branch)
    const pendingTip = await revParse(repo, ref)
    if (pendingTip === null || pendingTip === branchTip) {
      if (pendingTip !== null) await git(repo, ['update-ref', '-d', ref])
      return { branchTip, pendingTip: null, effectiveTip: branchTip, diverged: false }
    }
    // The user already brought the branch past the pending merge: it is obsolete.
    if (await isAncestor(repo, pendingTip, branchTip)) {
      await git(repo, ['update-ref', '-d', ref])
      return { branchTip, pendingTip: null, effectiveTip: branchTip, diverged: false }
    }
    const diverged = !(await isAncestor(repo, branchTip, pendingTip))
    return { branchTip, pendingTip, effectiveTip: pendingTip, diverged }
  }

  async function dropPending(repo: string, branch: string): Promise<void> {
    if ((await revParse(repo, pendingRef(branch))) !== null) {
      await git(repo, ['update-ref', '-d', pendingRef(branch)])
    }
  }

  async function publish(
    repo: string,
    branch: string,
    expectedBranchTip: string,
    newSha: string
  ): Promise<PublishOutcome> {
    const tip = await revParse(repo, `refs/heads/${branch}`)
    if (tip !== expectedBranchTip) return 'moved'
    const current = await sessionGit.currentBranch(repo)
    if (current === branch) {
      const status = await sessionGit.checkDirty(repo)
      if (!status.dirty) {
        try {
          await git(repo, ['merge', '--ff-only', newSha], { timeoutMs: LONG_GIT_TIMEOUT_MS })
          await dropPending(repo, branch)
          return 'fast-forwarded'
        } catch (error: unknown) {
          if (!(error instanceof GitError) || error.kind !== 'failed') throw error
          // The branch moved (a commit by the user), or git refused to touch a file: re-read to tell.
          if ((await revParse(repo, `refs/heads/${branch}`)) !== expectedBranchTip) return 'moved'
        }
      }
      await git(repo, ['update-ref', pendingRef(branch), newSha])
      return 'pending'
    }
    // Checked out nowhere: moving the ref cannot disturb anyone's files.
    try {
      await git(repo, ['update-ref', `refs/heads/${branch}`, newSha, expectedBranchTip])
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === 'failed') return 'moved'
      throw error
    }
    await dropPending(repo, branch)
    return 'ref-updated'
  }

  return {
    sessionTip,
    async addDetached(repo, path, sha) {
      await git(repo, ['worktree', 'add', '--detach', path, sha], {
        timeoutMs: LONG_GIT_TIMEOUT_MS
      })
    },
    headSha,
    mergeNoFf: (worktree, sha, message) =>
      attempt(worktree, ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', message, sha]),
    mergeInto: (worktree, sha) => attempt(worktree, ['merge', '--no-edit', '--no-verify', sha]),
    unmergedFiles,
    async mergeInProgress(worktree) {
      return (await tryGit(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== null
    },
    async commitMerge(worktree) {
      await git(worktree, ['commit', '--no-edit', '--no-verify'], {
        timeoutMs: LONG_GIT_TIMEOUT_MS
      })
    },
    async abortMerge(worktree) {
      await git(worktree, ['merge', '--abort'])
    },
    isAncestor,
    publish,
    async retryPending(repo, branch) {
      const tip = await sessionTip(repo, branch)
      if (tip.pendingTip === null) return 'none'
      if (tip.diverged) return 'diverged'
      return publish(repo, branch, tip.branchTip, tip.pendingTip)
    },
    async changedFiles(repo, from, to) {
      const out = await git(repo, ['diff', '--name-only', '-z', from, to])
      return out.split('\0').filter((p) => p !== '')
    },
    async commitsOnBranch(repo, base, tip) {
      const range = base === null ? ['-n', '30', tip] : [`${base}..${tip}`]
      let out: string | null = await tryGit(repo, ['log', '--oneline', '--no-decorate', ...range])
      if (out === null && base !== null) {
        out = await tryGit(repo, ['log', '--oneline', '--no-decorate', '-n', '30', tip])
      }
      return (out ?? '')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((line) => {
          const space = line.indexOf(' ')
          return space === -1
            ? { sha: line, subject: '' }
            : { sha: line.slice(0, space), subject: line.slice(space + 1) }
        })
    }
  }
}
