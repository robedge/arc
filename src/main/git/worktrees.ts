import { LONG_GIT_TIMEOUT_MS } from './git'
import type { GitRunner } from './git'
import { pendingRef } from './merge'

/**
 * Worker worktrees (tech spec 2.7). A worktree is always detached: it has no branch of its own and
 * starts at the session-branch tip, because `arc/<slug>` is already checked out in the user's own
 * checkout. Arc records the HEAD sha after every worker commit so nothing is lost with the worktree.
 */

export interface WorktreeCommit {
  sha: string
  subject: string
  /** Epoch milliseconds. */
  committedAt: number
}

export interface WorktreeGit {
  /** `git worktree add --detach <path> <ref>` and returns the sha it starts at. */
  addDetached(repo: string, path: string, ref: string): Promise<{ baseSha: string }>
  headSha(worktree: string): Promise<string>
  /** Commits in `baseSha..HEAD` of the worktree, oldest first. */
  commitsSince(worktree: string, baseSha: string): Promise<WorktreeCommit[]>
  /**
   * Paths changed since `baseSha`: committed or not (`git diff --name-only <base>` compares the
   * working tree to the base) plus untracked files. Each path once, sorted.
   */
  changedFiles(worktree: string, baseSha: string): Promise<string[]>
  /**
   * One line per file changed since `baseSha` (`git diff --stat <base>` compares the working tree to
   * the base, so uncommitted edits count) plus one per untracked file: "src/a.ts | 4 ++--",
   * "notes.md | untracked". Without git's summary line. Empty when nothing changed.
   */
  diffStatSince(worktree: string, baseSha: string): Promise<string[]>
  /**
   * Commits reachable from `headSha` but not from the session branch (nor from its waiting merge,
   * when one exists): `git rev-list --count <branch>..<headSha>`. 0 when git cannot tell.
   */
  countUnmerged(repo: string, branch: string, headSha: string): Promise<number>
  /** `git worktree remove` without `--force` unless `force` is set (session delete, a user Stop and Remove do that). */
  remove(repo: string, path: string, options?: { force?: boolean }): Promise<void>
  prune(repo: string): Promise<void>
}

export function createWorktreeGit(git: GitRunner): WorktreeGit {
  async function headSha(worktree: string): Promise<string> {
    return (await git(worktree, ['rev-parse', 'HEAD'])).trim()
  }
  return {
    async addDetached(repo, path, ref) {
      await git(repo, ['worktree', 'add', '--detach', path, ref], {
        timeoutMs: LONG_GIT_TIMEOUT_MS
      })
      return { baseSha: await headSha(path) }
    },
    headSha,
    async commitsSince(worktree, baseSha) {
      const out = await git(worktree, [
        'log',
        '--reverse',
        '--format=%H%x1f%ct%x1f%s',
        `${baseSha}..HEAD`
      ])
      const commits: WorktreeCommit[] = []
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue
        const [sha = '', ct = '0', ...subject] = line.split('\x1f')
        commits.push({ sha, subject: subject.join('\x1f'), committedAt: Number(ct) * 1000 })
      }
      return commits
    },
    async changedFiles(worktree, baseSha) {
      const [diff, status] = await Promise.all([
        git(worktree, ['diff', '--name-only', '-z', baseSha]),
        git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all'])
      ])
      const paths = new Set(diff.split('\0').filter((p) => p !== ''))
      const entries = status.split('\0')
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] ?? ''
        if (entry.startsWith('?? ')) paths.add(entry.slice(3))
        // A rename lists the old path as the next entry.
        else if (entry.startsWith('R') || entry.startsWith('C')) i += 1
      }
      return [...paths].sort()
    },
    async diffStatSince(worktree, baseSha) {
      const [stat, status] = await Promise.all([
        git(worktree, ['diff', '--stat=200,120', '--no-color', baseSha]),
        git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all'])
      ])
      const lines = stat
        .split('\n')
        // git pads the names to a common width; one space is enough.
        .map((l) => l.trim().replace(/\s+\|/, ' |'))
        // The last line is git's own "N files changed, ..." summary.
        .filter((l) => l !== '' && l.includes('|'))
      const entries = status.split('\0')
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] ?? ''
        if (entry.startsWith('?? ')) lines.push(`${entry.slice(3)} | untracked`)
        else if (entry.startsWith('R') || entry.startsWith('C')) i += 1
      }
      return lines
    },
    async countUnmerged(repo, branch, headSha) {
      try {
        const not = [`refs/heads/${branch}`]
        try {
          not.push((await git(repo, ['rev-parse', '--verify', '-q', pendingRef(branch)])).trim())
        } catch {
          // No merge is waiting for a fast-forward.
        }
        const out = await git(repo, ['rev-list', '--count', headSha, '--not', ...not])
        return Number.parseInt(out.trim(), 10) || 0
      } catch {
        return 0
      }
    },
    async remove(repo, path, options) {
      const args = ['worktree', 'remove', ...(options?.force ? ['--force'] : []), path]
      await git(repo, args, { timeoutMs: LONG_GIT_TIMEOUT_MS })
    },
    async prune(repo) {
      await git(repo, ['worktree', 'prune'])
    }
  }
}
