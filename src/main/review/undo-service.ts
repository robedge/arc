import { rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { AppErrorException } from '../../shared/errors'
import type { ReviewUndoPreview } from '../../shared/types/review'
import type { ReviewMarksRepo } from '../db/repositories/review-marks-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import type { WorktreesRepo } from '../db/repositories/worktrees-repo'
import { LONG_GIT_TIMEOUT_MS } from '../git/git'
import type { GitRunner } from '../git/git'
import type { MergeGit, PublishOutcome } from '../git/merge'
import type { MergeQueue } from '../git/merge-queue'
import type { WorktreeGit } from '../git/worktrees'
import {
  dropMergeWorktree,
  freshMergeWorktree,
  mergeWorktreePath
} from '../sessions/merge-worktree'
import { isResolverRow } from '../sessions/worker-label'
import type { LocatedFile, ReviewService } from './review-service'

/** Tries to publish the undo commit this many times when the branch keeps moving (same as a merge). */
const MAX_PUBLISH_ATTEMPTS = 3

/** Workers in these states are finished; anything else is still working (or about to). */
const FINISHED = new Set(['done', 'merged', 'failed', 'stopped'])

export interface UndoLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface UndoServiceDeps {
  reviewService: Pick<ReviewService, 'locateFile'>
  workersRepo: Pick<WorkersRepo, 'listBySession'>
  worktreesRepo: Pick<WorktreesRepo, 'listBySession'>
  worktreeGit: Pick<WorktreeGit, 'changedFiles' | 'remove' | 'prune'>
  mergeGit: Pick<MergeGit, 'sessionTip' | 'addDetached' | 'headSha' | 'publish'>
  /** Runs the restore, add and commit inside the temporary merge worktree. */
  git: GitRunner
  /** The same queue the merges use, so an undo never interleaves with one. */
  queue: MergeQueue
  marksRepo: Pick<ReviewMarksRepo, 'deleteByPath'>
  /** `userData/worktrees`. */
  getWorktreesRoot: () => string
  log: UndoLog
}

/** What a finished undo tells the session (event, brain note, `session:review-changed`). */
export interface UndoResult {
  projectId: string
  /** The repository's display name, e.g. "api". */
  repoName: string
  /** The path in the session branch (the new path of a rename). */
  path: string
  /** Set for renames: the path before the rename. */
  oldPath?: string
  /** The undo commit. */
  commit: string
  /** `pending` when the user's checkout was dirty and the commit waits for it. */
  published: PublishOutcome
}

/** Pathspec that matches the path literally, so `[id].ts` or `a*.txt` never match other files. */
function literal(path: string): string {
  return `:(literal)${path}`
}

/**
 * Undo changes to one file (tech spec 2.4): a new commit on the session branch that puts the file back the
 * way it was when the session started. Built in the temporary `_merge` worktree and published like a merge.
 */
export class UndoService {
  constructor(private readonly deps: UndoServiceDeps) {}

  /** `review:undo-preview`: labels of running workers that changed the file (or its old path) since their base. */
  async preview(sessionId: string, projectId: string, path: string): Promise<ReviewUndoPreview> {
    const { file } = await this.deps.reviewService.locateFile(sessionId, projectId, path)
    const wanted = new Set([file.path, ...(file.oldPath !== undefined ? [file.oldPath] : [])])
    const trees = this.deps.worktreesRepo.listBySession(sessionId)
    const active: string[] = []
    for (const worker of this.deps.workersRepo.listBySession(sessionId)) {
      if (FINISHED.has(worker.status) || isResolverRow(worker)) continue
      const tree = trees.find(
        (t) => t.workerId === worker.id && t.projectId === projectId && t.removedAt === null
      )
      if (!tree) continue
      try {
        const changed = await this.deps.worktreeGit.changedFiles(tree.path, tree.baseSha)
        if (changed.some((p) => wanted.has(p))) active.push(`W${worker.number}`)
      } catch (error: unknown) {
        this.deps.log.warn(`undo: could not read the changes of W${worker.number}`, error)
      }
    }
    return { activeWorkers: active }
  }

  /**
   * `review:undo`. Errors `REVIEW_FILE_NOT_FOUND` (not a currently changed file), `BRANCH_DIVERGED` (the user
   * committed on the session branch while an Arc update waits for the checkout), `IO_FAILED`.
   */
  async undo(sessionId: string, projectId: string, path: string): Promise<UndoResult> {
    const { reviewService } = this.deps
    // The row is needed for the queue key (the repository) before anything can be read inside it.
    const first = await reviewService.locateFile(sessionId, projectId, path)
    const repo = first.row.projectPath
    try {
      return await this.deps.queue.run(repo, () =>
        this.undoInQueue(sessionId, projectId, path, first.row)
      )
    } catch (error: unknown) {
      if (error instanceof AppErrorException) throw error
      this.deps.log.warn(`undo: could not undo ${path}`, error)
      throw new AppErrorException('IO_FAILED')
    }
  }

  private async undoInQueue(
    sessionId: string,
    projectId: string,
    path: string,
    row: LocatedFile['row']
  ): Promise<UndoResult> {
    const { mergeGit, reviewService } = this.deps
    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
      const tip = await mergeGit.sessionTip(row.projectPath, row.branchName)
      if (tip.diverged) throw new AppErrorException('BRANCH_DIVERGED')
      // Read again at the tip this attempt builds on, so the file is judged against what it will be restored over.
      const located = await reviewService.locateFile(sessionId, projectId, path, tip.effectiveTip)
      const treePath = mergeWorktreePath(this.deps, sessionId, row.projectName)
      await freshMergeWorktree(this.deps, row.projectPath, treePath, tip.effectiveTip)
      try {
        await this.restore(treePath, located)
        await this.deps.git(treePath, ['commit', '--no-verify', '-m', messageOf(located)], {
          timeoutMs: LONG_GIT_TIMEOUT_MS
        })
        const commit = await mergeGit.headSha(treePath)
        const published = await mergeGit.publish(
          row.projectPath,
          row.branchName,
          tip.branchTip,
          commit
        )
        if (published === 'moved') continue
        this.deps.marksRepo.deleteByPath(row.id, located.file.path)
        return {
          projectId,
          repoName: row.projectName,
          path: located.file.path,
          ...(located.file.oldPath !== undefined ? { oldPath: located.file.oldPath } : {}),
          commit,
          published
        }
      } finally {
        await dropMergeWorktree(this.deps, row.projectPath, treePath)
      }
    }
    throw new Error(`the session branch kept changing while ${path} was undone`)
  }

  /** Stages the file as it was at the base: changed or deleted comes back, added goes, a rename is reversed. */
  private async restore(treePath: string, located: LocatedFile): Promise<void> {
    const { git } = this.deps
    const { base, file } = located
    const opts = { timeoutMs: LONG_GIT_TIMEOUT_MS }
    switch (file.status) {
      case 'M':
      case 'D':
        await git(treePath, ['checkout', base, '--', literal(file.path)], opts)
        return
      case 'A':
        removeFile(treePath, file.path)
        await git(treePath, ['add', '-A', '--', literal(file.path)], opts)
        return
      case 'R': {
        if (file.oldPath === undefined)
          throw new Error(`${file.path} is a rename without an old path`)
        await git(treePath, ['checkout', base, '--', literal(file.oldPath)], opts)
        removeFile(treePath, file.path)
        await git(treePath, ['add', '-A', '--', literal(file.path)], opts)
        return
      }
      default: {
        const unreachable: never = file.status
        throw new Error(`unknown status ${String(unreachable)}`)
      }
    }
  }
}

function messageOf(located: LocatedFile): string {
  const { file } = located
  const name = file.oldPath !== undefined ? `${file.oldPath} -> ${file.path}` : file.path
  return `Undo session changes to ${name}`
}

/** Deletes a file inside the merge worktree; refuses a path that leaves it. */
function removeFile(treePath: string, path: string): void {
  const target = join(treePath, path)
  const rel = relative(treePath, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${path} is outside the working copy`)
  }
  rmSync(target, { force: true })
}
