import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { MERGE_DIR } from '../git/merge'
import type { MergeGit } from '../git/merge'
import type { WorktreeGit } from '../git/worktrees'
import { safeDirName } from './worker-manager'
import { pruneEmptyFolders } from './working-copy'

/**
 * The temporary detached working copy that merges, syncs and Undo build their commits in
 * (`userData/worktrees/<sessionId>/_merge/<repo>`). Only one job per repository uses it at a time:
 * they all run inside the `MergeQueue`.
 */

export interface MergeWorktreeDeps {
  mergeGit: Pick<MergeGit, 'addDetached'>
  worktreeGit: Pick<WorktreeGit, 'remove' | 'prune'>
  /** `userData/worktrees`. */
  getWorktreesRoot: () => string
  log: { warn: (message: string, ...rest: unknown[]) => void }
}

export function mergeWorktreePath(
  deps: Pick<MergeWorktreeDeps, 'getWorktreesRoot'>,
  sessionId: string,
  projectName: string
): string {
  return join(deps.getWorktreesRoot(), sessionId, MERGE_DIR, safeDirName(projectName))
}

/** Removes the temporary merge working copy (forced: it is Arc's own and may hold a half-done merge). */
export async function dropMergeWorktree(
  deps: MergeWorktreeDeps,
  repo: string,
  path: string
): Promise<void> {
  try {
    await deps.worktreeGit.remove(repo, path, { force: true })
  } catch {
    // Not registered, or already gone.
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error: unknown) {
    deps.log.warn(`could not remove ${path}`, error)
  }
  await deps.worktreeGit.prune(repo).catch(() => undefined)
  pruneEmptyFolders(deps.getWorktreesRoot(), path)
}

/** A clean detached working copy at `sha`, replacing any leftover one. */
export async function freshMergeWorktree(
  deps: MergeWorktreeDeps,
  repo: string,
  path: string,
  sha: string
): Promise<void> {
  await dropMergeWorktree(deps, repo, path)
  await deps.mergeGit.addDetached(repo, path, sha)
}
