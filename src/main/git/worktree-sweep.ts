import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MERGE_DIR } from './merge'
import type { WorktreeGit } from './worktrees'

export interface SweepLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface SweepResult {
  /** Leftover `_merge` folders that were removed. */
  removedMergeDirs: string[]
  /** Repositories `git worktree prune` ran in. */
  pruned: string[]
}

/**
 * Launch sweep (tech spec 2.7): a crash can leave a temporary merge working copy behind. Removes every
 * `<worktreesRoot>/<sessionId>/_merge` folder, then runs `git worktree prune` in each repository so git
 * forgets the removed ones. Worker working copies are never touched: they hold unmerged work.
 */
export async function sweepWorktrees(options: {
  worktreesRoot: string
  repoPaths: readonly string[]
  worktreeGit: WorktreeGit
  log: SweepLog
}): Promise<SweepResult> {
  const result: SweepResult = { removedMergeDirs: [], pruned: [] }
  let sessions: string[] = []
  try {
    sessions = readdirSync(options.worktreesRoot)
  } catch {
    // No working copies yet.
  }
  for (const session of sessions) {
    const dir = join(options.worktreesRoot, session, MERGE_DIR)
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      result.removedMergeDirs.push(dir)
    } catch (error: unknown) {
      options.log.warn(`could not remove the leftover merge working copy ${dir}`, error)
    }
  }
  for (const repo of options.repoPaths) {
    if (!existsSync(repo)) continue
    try {
      await options.worktreeGit.prune(repo)
      result.pruned.push(repo)
    } catch (error: unknown) {
      options.log.warn(`could not prune the working copies of ${repo}`, error)
    }
  }
  return result
}
