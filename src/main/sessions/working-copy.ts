import { rmSync, rmdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WorktreesRepo, WorkerWorktreeRow } from '../db/repositories/worktrees-repo'
import type { WorktreeGit } from '../git/worktrees'

/**
 * Removes the empty folders above a removed working copy: its worker (or merge) folder, then the
 * session folder, never `userData/worktrees` itself. A folder with anything left in it stays.
 */
export function pruneEmptyFolders(root: string, path: string): void {
  let folder = dirname(path)
  while (folder !== root && folder.startsWith(root)) {
    try {
      rmdirSync(folder)
    } catch {
      return
    }
    folder = dirname(folder)
  }
}

export interface DiscardDeps {
  worktreeGit: WorktreeGit
  worktreesRepo: WorktreesRepo
  /** `userData/worktrees`. */
  root: string
  now: () => number
  warn: (message: string, ...rest: unknown[]) => void
}

/**
 * Throws a working copy away for good (user Stop, Remove): `git worktree remove --force` through
 * Arc's wrapper, then the folder itself, then `git worktree prune`, then the empty parent folders.
 * Unmerged commits in it are lost. Marks the worktree row removed even when git no longer knows it.
 */
export async function discardWorkingCopy(
  deps: DiscardDeps,
  repoPath: string | null,
  tree: WorkerWorktreeRow
): Promise<void> {
  if (repoPath !== null) {
    await deps.worktreeGit.remove(repoPath, tree.path, { force: true }).catch(() => undefined)
  }
  try {
    rmSync(tree.path, { recursive: true, force: true })
  } catch (error: unknown) {
    deps.warn(`could not remove ${tree.path}`, error)
  }
  if (repoPath !== null) await deps.worktreeGit.prune(repoPath).catch(() => undefined)
  deps.worktreesRepo.markRemoved(tree.id, deps.now())
  pruneEmptyFolders(deps.root, tree.path)
}
