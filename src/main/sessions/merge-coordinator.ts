import { BridgeToolError } from '../bridge/types'
import type {
  MergeResultKind,
  MergeWorkerResult,
  SyncWorkerInput,
  SyncWorkerResult
} from '../bridge/types'
import type { MergesRepo } from '../db/repositories/merges-repo'
import type {
  SessionProjectRow,
  SessionProjectsRepo
} from '../db/repositories/session-projects-repo'
import type { WorkerRow, WorkersRepo } from '../db/repositories/workers-repo'
import type { WorkerWorktreeRow, WorktreesRepo } from '../db/repositories/worktrees-repo'
import type { MergeGit, PublishOutcome, SessionTip } from '../git/merge'
import type { MergeQueue } from '../git/merge-queue'
import type { WorktreeGit } from '../git/worktrees'
import { isResolverRow, workerLabel } from './worker-label'
import { dropMergeWorktree, freshMergeWorktree, mergeWorktreePath } from './merge-worktree'
import { pruneEmptyFolders } from './working-copy'
import type { ResolverRequest, ResolverRun } from './worker-manager'

const MAX_PUBLISH_ATTEMPTS = 3
const SHORT_MAX = 80
const FILES_SHOWN = 8

export interface MergeLog {
  info: (message: string, ...rest: unknown[]) => void
  warn: (message: string, ...rest: unknown[]) => void
  error: (message: string, ...rest: unknown[]) => void
}

export interface MergeCoordinatorDeps {
  sessionId: string
  now: () => number
  newId: () => string
  workersRepo: WorkersRepo
  worktreesRepo: WorktreesRepo
  mergesRepo: MergesRepo
  sessionProjectsRepo: SessionProjectsRepo
  mergeGit: MergeGit
  worktreeGit: WorktreeGit
  queue: MergeQueue
  /** `userData/worktrees`. */
  getWorktreesRoot: () => string
  log: MergeLog
}

export interface MergeHost {
  logEvent: (kind: string, text: string, data?: unknown, workerId?: string | null) => void
  /** A user-turn message to the brain. */
  notifyBrain: (text: string) => void
  /** The final summary request: like `notifyBrain`, and the brain's reply gets the Review changes link. */
  notifySummary: (text: string) => void
  resolveRef: (ref: string) => WorkerRow | undefined
  startResolver: (request: ResolverRequest) => Promise<ResolverRun>
  /** Stores the HEAD sha and commits of a worker's working copies. */
  syncHeads: (workerId: string) => Promise<void>
  markMerged: (workerId: string) => void
  pushWorker: (workerId: string) => void
  isRunning: (workerId: string) => boolean
  /** The user is in control of the worker (stepped in or paused). */
  isControlled: (workerId: string) => boolean
  message: (
    ref: string,
    text: string
  ) => Promise<{ delivered: boolean; queued?: boolean | undefined }>
  /** The worker has a request waiting for the user (its `ask_brain` was passed on). */
  hasUserRequest: (workerId: string) => boolean
  /** Resolves once the session branches exist. */
  branchesReady: () => Promise<void>
  /** A merge was recorded or a waiting one landed; `changedPaths` are repo-relative. */
  reviewChanged: (projectId: string, changedPaths: string[]) => void
}

interface RepoOutcome {
  result: MergeResultKind
  files: string[]
  pending: boolean
}

type BranchProject = SessionProjectRow & { branchName: string }

interface RepoContext {
  row: WorkerRow
  /** "W1 api-retry". */
  label: string
  project: BranchProject
  multi: boolean
  early: Early
}

interface Early {
  fired: boolean
  fire: (result: MergeWorkerResult) => void
}

interface ResolutionInfo {
  label: string
  branch: string
  projectName: string
  files: string[]
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

function parseIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasBranch(project: SessionProjectRow | undefined): project is BranchProject {
  return project !== undefined && project.branchName !== null
}

const RANK: Record<MergeResultKind, number> = { clean: 0, resolved: 1, needs_user: 2 }

/** The resolver's first message. */
export function buildResolverTask(
  sourceLabel: string,
  project: string,
  branch: string,
  files: readonly string[]
): string {
  return (
    `Resolve the merge conflicts in "${project}" while merging ${sourceLabel} into ${branch}. ` +
    `Conflicted files: ${files.join(', ')}. ` +
    'Keep the intent of both changes, then git add the files and run git commit --no-edit. ' +
    'If you are not confident, call ask_brain with a question that names the file and what each side changed.'
  )
}

/**
 * Merging, sharing and the final summary for one session (tech spec 2.7, functional spec 2.8).
 * Every git step that touches a repository runs in that repository's queue.
 */
export class MergeCoordinator {
  private readonly inFlight = new Set<string>()
  private readonly watchers = new Map<string, () => void>()
  private readonly resolutions = new Map<string, ResolutionInfo>()
  /** Repositories whose "update is waiting" note is already in the event log. */
  private readonly waitingLogged = new Set<string>()
  private summarySent = false
  private closed = false

  constructor(
    private readonly deps: MergeCoordinatorDeps,
    private readonly host: MergeHost
  ) {}

  dispose(): void {
    this.closed = true
    this.watchers.clear()
  }

  /** A new worker exists: a later "all finished" is a new summary. */
  onWorkerSpawned(): void {
    this.summarySent = false
  }

  /** True while the worker is being merged (by the brain's call or automatically). */
  isMerging(workerId: string): boolean {
    return this.inFlight.has(workerId)
  }

  /**
   * A worker became Done: merge it by itself, as merge_worker would, and tell the brain the outcome
   * (clean, resolved by the resolver, or waiting for the user's answer). Errors go to the brain too.
   */
  async autoMerge(workerId: string): Promise<void> {
    const row = this.deps.workersRepo.get(workerId)
    if (!row || this.closed) return
    // The user is in control: nothing merges until they hand it back (the brain is told then).
    if (this.host.isControlled(workerId)) return
    const label = workerLabel(row)
    const project = this.deps.worktreesRepo
      .listByWorker(workerId)
      .map((t) => this.projectOf(t.projectId))
      .find(hasBranch)
    const branch = project?.branchName ?? 'the session branch'
    const report = row.summary ? ` Its report: ${clip(row.summary, 400)}` : ''
    try {
      const result = await this.mergeWorker(workerId)
      if (this.closed) return
      if (!result.merged) {
        this.host.notifyBrain(
          `[Arc] ${label} is done. Merging it into ${branch} hit a conflict: ${result.note ?? "it needs the user's decision."}${report}`
        )
        return
      }
      const resolved =
        result.result === 'resolved' ? ' A conflict was resolved by a conflict resolver.' : ''
      const waiting =
        result.pendingFastForward && result.pendingFastForward.length > 0
          ? ` The checkout of ${result.pendingFastForward.join(', ')} is not updated yet (unsaved changes there).`
          : ''
      this.host.notifyBrain(
        `[Arc] Merged ${label} into ${branch} automatically.${resolved}${waiting}${report}`
      )
    } catch (error: unknown) {
      if (this.closed) return
      if (
        error instanceof BridgeToolError &&
        (error.code === 'already_merged' || error.code === 'merge_in_progress')
      ) {
        return
      }
      this.host.notifyBrain(
        `[Arc] ${label} is done, but Arc could not merge it automatically: ${errorMessage(error)}${report} Decide how to continue and tell the user.`
      )
    }
  }

  // ---- merge_worker ----

  async mergeWorker(ref: string): Promise<MergeWorkerResult> {
    const row = this.host.resolveRef(ref)
    if (!row) throw new BridgeToolError('unknown_worker', `No worker "${ref}" in this session.`)
    const label = workerLabel(row)
    if (isResolverRow(row)) {
      throw new BridgeToolError('unknown_worker', `${label} is Arc's own merge resolver.`)
    }
    if (this.host.isControlled(row.id)) {
      throw new BridgeToolError(
        'worker_user_control',
        `The user is controlling ${label} right now. Try again after they hand it back.`
      )
    }
    if (row.status === 'merged') {
      throw new BridgeToolError('already_merged', `${label} is already merged.`)
    }
    if (this.inFlight.has(row.id)) {
      throw new BridgeToolError('merge_in_progress', `${label} is being merged right now.`)
    }
    if (row.status !== 'done') {
      throw new BridgeToolError(
        'worker_not_done',
        `${label} is ${row.status.replace('_', ' ')}; merge it after it reports done.`
      )
    }
    await this.host.branchesReady()
    await this.host.syncHeads(row.id)
    const trees = this.deps.worktreesRepo.listByWorker(row.id).filter((t) => t.removedAt === null)
    if (trees.length === 0) {
      throw new BridgeToolError('no_working_copy', `${label} has no working copy left to merge.`)
    }
    this.inFlight.add(row.id)
    let fire: (result: MergeWorkerResult) => void = () => undefined
    const earlyPromise = new Promise<MergeWorkerResult>((resolve) => {
      fire = resolve
    })
    const early: Early = {
      fired: false,
      fire: (result) => {
        early.fired = true
        fire(result)
      }
    }
    const all = this.mergeAll(row, label, trees, early).finally(() => {
      this.inFlight.delete(row.id)
    })
    all.then(
      () => {
        if (early.fired) {
          this.host.notifyBrain(
            `[Arc] ${label} is merged now that the conflict question was answered.`
          )
        }
        this.checkFinished()
      },
      (error: unknown) => {
        if (early.fired) {
          this.host.notifyBrain(
            `[Arc] The merge of ${label} did not complete: ${errorMessage(error)} The session branch is unchanged.`
          )
        }
      }
    )
    return Promise.race([all, earlyPromise])
  }

  private async mergeAll(
    row: WorkerRow,
    label: string,
    trees: readonly WorkerWorktreeRow[],
    early: Early
  ): Promise<MergeWorkerResult> {
    const outcomes: { repo: string; outcome: RepoOutcome }[] = []
    for (const tree of trees) {
      const project = this.projectOf(tree.projectId)
      if (!hasBranch(project)) {
        throw new BridgeToolError(
          'merge_failed',
          `A project of ${label} is no longer part of this session.`
        )
      }
      const ctx: RepoContext = { row, label, project, multi: trees.length > 1, early }
      const outcome = await this.deps.queue.run(project.projectPath, () =>
        this.mergeRepo(ctx, tree)
      )
      outcomes.push({ repo: project.projectName, outcome })
      await this.removeWorkingCopy(label, project, tree)
    }
    this.host.markMerged(row.id)
    let result: MergeResultKind = 'clean'
    const files: string[] = []
    const pending: string[] = []
    for (const { repo, outcome } of outcomes) {
      if (RANK[outcome.result] > RANK[result]) result = outcome.result
      files.push(...outcome.files)
      if (outcome.pending) pending.push(repo)
    }
    return {
      merged: true,
      result,
      files,
      ...(pending.length > 0 ? { pendingFastForward: pending } : {})
    }
  }

  private projectOf(projectId: string | null): SessionProjectRow | undefined {
    if (projectId === null) return undefined
    return this.deps.sessionProjectsRepo
      .listBySession(this.deps.sessionId)
      .find((p) => p.projectId === projectId)
  }

  private mergePathOf(project: SessionProjectRow): string {
    return mergeWorktreePath(this.deps, this.deps.sessionId, project.projectName)
  }

  /** One repository's merge: runs inside the repository's queue. */
  private async mergeRepo(ctx: RepoContext, tree: WorkerWorktreeRow): Promise<RepoOutcome> {
    const { project } = ctx
    const repo = project.projectPath
    const mergePath = this.mergePathOf(project)
    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
      const tip = await this.deps.mergeGit.sessionTip(repo, project.branchName)
      if (tip.diverged) {
        throw new BridgeToolError(
          'branch_diverged',
          `${project.branchName} in ${project.projectName} has commits of its own while an Arc update waits for your checkout to be clean. Save your changes, then try again.`
        )
      }
      await this.freshMergeWorktree(repo, mergePath, tip.effectiveTip)
      try {
        const outcome = await this.mergeAt(ctx, tree, tip, mergePath)
        if (outcome !== 'moved') return outcome
      } finally {
        await this.dropMergeWorktree(repo, mergePath)
      }
    }
    throw new BridgeToolError(
      'merge_failed',
      `${project.branchName} in ${project.projectName} kept changing while it was merged. Try again.`
    )
  }

  private async mergeAt(
    ctx: RepoContext,
    tree: WorkerWorktreeRow,
    tip: SessionTip,
    mergePath: string
  ): Promise<RepoOutcome | 'moved'> {
    const { project, label } = ctx
    const repo = project.projectPath
    const mg = this.deps.mergeGit
    const attempt = await mg.mergeNoFf(mergePath, tree.headSha, `Merge ${label}`)
    let result: MergeResultKind = 'clean'
    let conflictFiles: string[] = []
    if (attempt.status === 'conflict') {
      conflictFiles = attempt.files
      const resolved = await this.resolve(ctx, tree, mergePath, tip.effectiveTip, conflictFiles)
      if (!resolved.ok) {
        this.recordMerge(ctx, 'failed', [], conflictFiles, null, resolved.reason)
        this.host.logEvent(
          'merge-failed',
          `Merging ${label} failed: ${resolved.reason}`,
          { files: conflictFiles },
          ctx.row.id
        )
        throw new BridgeToolError(
          'merge_failed',
          `Merging ${label} into ${project.branchName} failed: ${resolved.reason} The session branch is unchanged.`
        )
      }
      result = resolved.escalated ? 'needs_user' : 'resolved'
    }
    const newSha = await mg.headSha(mergePath)
    const changed = newSha !== tip.effectiveTip
    let published: PublishOutcome | 'unchanged' | 'none' | 'diverged' = 'unchanged'
    let files: string[] = []
    if (changed) {
      published = await mg.publish(repo, project.branchName, tip.branchTip, newSha)
      if (published === 'moved') return 'moved'
      files = await mg.changedFiles(repo, tip.effectiveTip, newSha)
    } else if (tip.pendingTip !== null) {
      published = await mg.retryPending(repo, project.branchName)
    }
    const pending = published === 'pending'
    const shown = files.map((f) => `${project.projectName}/${f}`)
    this.recordMerge(
      ctx,
      result,
      shown,
      conflictFiles,
      newSha,
      pending ? 'The checkout is not fast-forwarded yet.' : null
    )
    const repoNote = ctx.multi ? ` (${project.projectName})` : ''
    this.host.logEvent(
      'merge',
      `Merged ${label} into ${project.branchName}${repoNote}`,
      { repo: project.projectName, mergeSha: newSha, result, files: shown },
      ctx.row.id
    )
    if (pending) this.logWaiting(project)
    else this.waitingLogged.delete(project.projectPath)
    if (changed && project.projectId !== null) this.host.reviewChanged(project.projectId, files)
    return { result, files: shown, pending }
  }

  private recordMerge(
    ctx: RepoContext,
    result: MergeResultKind | 'failed',
    files: readonly string[],
    conflictFiles: readonly string[],
    mergeSha: string | null,
    notes: string | null
  ): void {
    this.deps.mergesRepo.record({
      id: this.deps.newId(),
      sessionId: this.deps.sessionId,
      workerId: ctx.row.id,
      projectId: ctx.project.projectId,
      result,
      filesJson: JSON.stringify(files),
      conflictFilesJson: conflictFiles.length > 0 ? JSON.stringify(conflictFiles) : null,
      mergeSha,
      notes,
      mergedAt: this.deps.now()
    })
  }

  private logWaiting(project: SessionProjectRow): void {
    if (this.waitingLogged.has(project.projectPath)) return
    this.waitingLogged.add(project.projectPath)
    this.host.logEvent(
      'merge-waiting',
      `Session branch update waiting: your checkout of ${project.projectName} has unsaved changes`,
      { repo: project.projectName }
    )
  }

  // ---- conflicts ----

  private async resolve(
    ctx: RepoContext,
    tree: WorkerWorktreeRow,
    mergePath: string,
    baseSha: string,
    files: string[]
  ): Promise<{ ok: true; escalated: boolean } | { ok: false; reason: string }> {
    const { project, label } = ctx
    const mg = this.deps.mergeGit
    const shown = files.map((f) => `${project.projectName}/${f}`)
    this.host.logEvent(
      'merge-conflict',
      `Merging ${label} hit a conflict in ${shown.join(', ')}`,
      { files: shown },
      ctx.row.id
    )
    const abort = async (reason: string): Promise<{ ok: false; reason: string }> => {
      await mg.abortMerge(mergePath).catch(() => undefined)
      return { ok: false, reason }
    }
    let run: ResolverRun
    try {
      run = await this.host.startResolver({
        project,
        mergePath,
        baseSha,
        sourceLabel: label,
        files,
        task: buildResolverTask(label, project.projectName, project.branchName, files)
      })
    } catch (error: unknown) {
      return abort(errorMessage(error))
    }
    this.resolutions.set(run.workerId, {
      label,
      branch: project.branchName,
      projectName: project.projectName,
      files
    })
    let escalated = false
    const escalation = new Promise<'escalated'>((resolve) => {
      this.watchers.set(run.workerId, () => resolve('escalated'))
    })
    this.onAttention()
    const first = await Promise.race([
      run.finished.then((status) => ({ status })),
      escalation.then(() => null)
    ])
    let status: 'done' | 'failed' | 'stopped'
    if (first === null) {
      escalated = true
      ctx.early.fire({
        merged: false,
        result: 'needs_user',
        files: shown,
        note: `The conflict in ${shown.join(', ')} needs the user's decision. The merge of ${label} finishes after the answer; Arc tells you then.`
      })
      status = await run.finished
    } else {
      status = first.status
    }
    this.watchers.delete(run.workerId)
    this.resolutions.delete(run.workerId)
    this.retireResolver(run.workerId, status === 'done')

    if (status !== 'done') {
      return abort(`The conflict resolver ${status === 'stopped' ? 'was stopped' : 'failed'}.`)
    }
    let unmerged = await mg.unmergedFiles(mergePath)
    if (unmerged.length === 0 && (await mg.mergeInProgress(mergePath))) {
      await mg.commitMerge(mergePath).catch((error: unknown) => {
        this.deps.log.warn('could not finish the merge for the resolver', error)
      })
    }
    unmerged = await mg.unmergedFiles(mergePath)
    const head = await mg.headSha(mergePath)
    const complete =
      unmerged.length === 0 &&
      !(await mg.mergeInProgress(mergePath)) &&
      head !== baseSha &&
      (await mg.isAncestor(mergePath, baseSha, head)) &&
      (await mg.isAncestor(mergePath, tree.headSha, head))
    if (!complete) return abort('The resolver ended without finishing the merge.')
    for (const file of shown) {
      this.host.logEvent('merge-resolved', `Resolved conflict in ${file}`, { file }, ctx.row.id)
    }
    return { ok: true, escalated }
  }

  private retireResolver(workerId: string, merged: boolean): void {
    for (const tree of this.deps.worktreesRepo.listByWorker(workerId)) {
      if (tree.removedAt === null) this.deps.worktreesRepo.markRemoved(tree.id, this.deps.now())
    }
    if (merged) this.host.markMerged(workerId)
    else this.host.pushWorker(workerId)
  }

  /** Called whenever the set of requests waiting for the user changed. */
  onAttention(): void {
    for (const [workerId, notify] of [...this.watchers]) {
      if (this.host.hasUserRequest(workerId)) notify()
    }
  }

  /**
   * The question a resolver asks the brain, with the file and the merge named so that the user's
   * question always says where the conflict is.
   */
  decorateQuestion(workerId: string, question: string): string {
    const info = this.resolutions.get(workerId)
    if (!info) return question
    const files = info.files.map((f) => `${info.projectName}/${f}`).join(', ')
    return `Conflict in ${files} while merging ${info.label} into ${info.branch}. ${question}`
  }

  // ---- merge worktree ----

  private async freshMergeWorktree(repo: string, path: string, sha: string): Promise<void> {
    await freshMergeWorktree(this.deps, repo, path, sha)
  }

  /** Removes the temporary merge working copy (forced: it is Arc's own and may hold a half-done merge). */
  private async dropMergeWorktree(repo: string, path: string): Promise<void> {
    await dropMergeWorktree(this.deps, repo, path)
  }

  /** After a merge: `git worktree remove` without `--force`; a working copy git refuses to remove stays. */
  private async removeWorkingCopy(
    label: string,
    project: SessionProjectRow,
    tree: WorkerWorktreeRow
  ): Promise<void> {
    try {
      await this.deps.worktreeGit.remove(project.projectPath, tree.path)
    } catch (error: unknown) {
      const reason = errorMessage(error).split('\n')[0] ?? ''
      this.host.logEvent(
        'worktree-kept',
        `Kept the working copy of ${label} in ${project.projectName}: ${clip(reason, 160)}`,
        { path: tree.path },
        tree.workerId
      )
      return
    }
    this.deps.worktreesRepo.markRemoved(tree.id, this.deps.now())
    pruneEmptyFolders(this.deps.getWorktreesRoot(), tree.path)
    this.host.pushWorker(tree.workerId)
  }

  // ---- pending fast-forwards ----

  /** Retries every repository's waiting fast-forward (`skipBusy`: leave repositories with a queued merge alone). Logs a note the first time a repository is still waiting. */
  async retryPending(options: { skipBusy?: boolean } = {}): Promise<void> {
    for (const project of this.deps.sessionProjectsRepo.listBySession(this.deps.sessionId)) {
      if (project.readOnly || project.branchName === null) continue
      // A busy repository has a merge in flight (maybe waiting on the user); that merge publishes itself.
      if (options.skipBusy && this.deps.queue.isBusy(project.projectPath)) continue
      const branch = project.branchName
      try {
        await this.deps.queue.run(project.projectPath, async () => {
          const outcome = await this.deps.mergeGit.retryPending(project.projectPath, branch)
          if (outcome === 'pending') this.logWaiting(project)
          else if (outcome === 'fast-forwarded' || outcome === 'ref-updated') {
            this.waitingLogged.delete(project.projectPath)
            this.host.logEvent('merge', `Session branch updated in ${project.projectName}`, {
              repo: project.projectName
            })
            if (project.projectId !== null) this.host.reviewChanged(project.projectId, [])
          }
        })
      } catch (error: unknown) {
        this.deps.log.warn(`could not update the session branch of ${project.projectName}`, error)
      }
    }
  }

  // ---- sync_worker ----

  async syncWorker(input: SyncWorkerInput): Promise<SyncWorkerResult> {
    const target = this.host.resolveRef(input.workerId)
    if (!target) {
      throw new BridgeToolError('unknown_worker', `No worker "${input.workerId}" in this session.`)
    }
    const source = this.host.resolveRef(input.fromWorkerId)
    if (!source) {
      throw new BridgeToolError(
        'unknown_worker',
        `No worker "${input.fromWorkerId}" in this session.`
      )
    }
    if (target.id === source.id || isResolverRow(target) || isResolverRow(source)) {
      throw new BridgeToolError('invalid_sync', 'Pick two different workers.')
    }
    const targetLabel = workerLabel(target)
    const sourceLabel = workerLabel(source)
    if (target.status === 'merged' || target.status === 'queued') {
      throw new BridgeToolError(
        'worker_not_syncable',
        `${targetLabel} is ${target.status}; it has no working copy to bring changes into.`
      )
    }
    if (source.status !== 'merged' && source.status !== 'done') {
      throw new BridgeToolError(
        'source_not_ready',
        `${sourceLabel} is ${source.status.replace('_', ' ')}; share its work after it is Done (or Merged).`
      )
    }
    await this.host.branchesReady()
    if (source.status === 'done') await this.host.syncHeads(source.id)
    const sourceProjects = new Set(parseIds(source.projectIdsJson))
    const shared = this.deps.worktreesRepo
      .listByWorker(target.id)
      .filter(
        (t) => t.removedAt === null && t.projectId !== null && sourceProjects.has(t.projectId)
      )
    if (shared.length === 0) {
      throw new BridgeToolError(
        'no_shared_repo',
        `${targetLabel} and ${sourceLabel} have no project in common.`
      )
    }
    const files: string[] = []
    const conflicts: string[] = []
    for (const tree of shared) {
      const project = this.projectOf(tree.projectId)
      if (!hasBranch(project)) continue
      const branch = project.branchName
      await this.deps.queue.run(project.projectPath, async () => {
        const mg = this.deps.mergeGit
        let sha: string
        if (source.status === 'merged') {
          sha = (await mg.sessionTip(project.projectPath, branch)).effectiveTip
        } else {
          const own = this.deps.worktreesRepo
            .listByWorker(source.id)
            .find((t) => t.removedAt === null && t.projectId === tree.projectId)
          if (!own) return
          sha = own.headSha
        }
        const before = await mg.headSha(tree.path)
        let attempt
        try {
          attempt = await mg.mergeInto(tree.path, sha)
        } catch (error: unknown) {
          throw new BridgeToolError(
            'sync_failed',
            `Could not bring ${sourceLabel}'s changes into ${targetLabel}: ${clip(errorMessage(error), 300)}`
          )
        }
        if (attempt.status === 'conflict') {
          conflicts.push(...attempt.files.map((f) => `${project.projectName}/${f}`))
        } else if (attempt.changed) {
          const changed = await mg.changedFiles(tree.path, before, attempt.head)
          files.push(...changed.map((f) => `${project.projectName}/${f}`))
        }
      })
    }
    const listed =
      files.slice(0, FILES_SHOWN).join(', ') + (files.length > FILES_SHOWN ? ', ...' : '')
    const given = input.note?.trim() ?? ''
    let text =
      given !== ''
        ? `${sourceLabel}'s changes are now in your working copy: ${given}`
        : files.length > 0
          ? `${sourceLabel}'s changes to ${listed} are now in your working copy.`
          : `${sourceLabel}'s changes are now in your working copy.`
    if (conflicts.length > 0) {
      text += ` The merge stopped on conflicts in ${conflicts.join(', ')}: resolve them, git add the files and git commit.`
    }
    let notified = false
    let held = false
    // A controlled worker may have no process (paused); its message is held either way.
    if (this.host.isRunning(target.id) || this.host.isControlled(target.id)) {
      try {
        const sent = await this.host.message(target.id, text)
        notified = sent.delivered
        held = sent.queued === true
      } catch (error: unknown) {
        this.deps.log.warn(`could not tell ${targetLabel} about the shared changes`, error)
      }
    }
    const short =
      given !== '' ? clip(given.split('\n')[0] ?? given, SHORT_MAX) : clip(listed, SHORT_MAX)
    this.host.logEvent(
      'shared',
      `Shared W${source.number} → W${target.number}${short === '' ? '' : `: ${short}`}`,
      { from: source.id, to: target.id, files, conflicts },
      target.id
    )
    return {
      synced: true,
      ...(conflicts.length > 0 ? { conflicts } : {}),
      files,
      notified,
      ...(held ? { queued: true } : {})
    }
  }

  // ---- final summary ----

  /** Sends the final-summary prompt once every worker is merged, failed or stopped and nothing is merging. */
  checkFinished(): void {
    if (this.closed || this.summarySent || this.inFlight.size > 0) return
    const rows = this.deps.workersRepo
      .listBySession(this.deps.sessionId)
      .filter((r) => !isResolverRow(r))
    if (rows.length === 0) return
    if (
      !rows.every((r) => r.status === 'merged' || r.status === 'failed' || r.status === 'stopped')
    ) {
      return
    }
    // Nothing was merged: there is no session-branch work to summarise (the brain heard of each failure).
    if (this.deps.mergesRepo.listBySession(this.deps.sessionId).length === 0) return
    this.summarySent = true
    void this.sendSummary(rows).catch((error: unknown) => {
      this.deps.log.error('could not build the final summary', error)
    })
  }

  private async sendSummary(rows: readonly WorkerRow[]): Promise<void> {
    await this.retryPending()
    const lines: string[] = [
      '[Arc] All workers finished. Summarise per repository: what changed, the commits on the session branch, and anything left undone.',
      '',
      'Workers:'
    ]
    for (const r of rows) {
      const detail =
        r.status === 'failed'
          ? ` (${clip(r.failureReason ?? 'no reason given', 160)})`
          : r.status === 'merged' && r.summary
            ? ` - ${clip(r.summary, 160)}`
            : ''
      lines.push(`- W${r.number} ${r.slug}: ${r.status}${detail}`)
    }
    const conflicted = this.deps.mergesRepo
      .listBySession(this.deps.sessionId)
      .filter((m) => m.conflictFilesJson !== null && m.result !== 'failed')
    if (conflicted.length > 0) {
      lines.push('', 'Conflicts resolved during merges:')
      for (const m of conflicted) {
        const who = rows.find((r) => r.id === m.workerId)
        const repo = this.projectOf(m.projectId)?.projectName ?? 'repo'
        const files = parseIds(m.conflictFilesJson ?? '[]')
          .map((f) => `${repo}/${f}`)
          .join(', ')
        const how = m.result === 'needs_user' ? "with the user's answer" : 'by the resolver'
        lines.push(`- ${files} (${who ? `W${who.number} ${who.slug}` : 'a worker'}, ${how})`)
      }
    }
    lines.push(
      '',
      'Commits on each session branch (machine-made from git log <base>..<branch> --oneline):'
    )
    const undone: string[] = []
    for (const project of this.deps.sessionProjectsRepo.listBySession(this.deps.sessionId)) {
      if (project.readOnly || project.branchName === null) continue
      let tip: SessionTip
      try {
        tip = await this.deps.mergeGit.sessionTip(project.projectPath, project.branchName)
      } catch {
        continue
      }
      const commits = await this.deps.mergeGit.commitsOnBranch(
        project.projectPath,
        project.baseBranch,
        tip.effectiveTip
      )
      const base = project.baseBranch ? `, base ${project.baseBranch}` : ''
      lines.push(`${project.projectName} (${project.branchName}${base}):`)
      if (commits.length === 0) lines.push('  (no commits)')
      for (const c of commits) lines.push(`  ${c.sha} ${c.subject}`)
      if (tip.pendingTip !== null) {
        undone.push(
          `The ${project.branchName} update in ${project.projectName} is waiting for the user's checkout to be clean.`
        )
      }
    }
    for (const r of rows) {
      if (r.status === 'failed' || r.status === 'stopped') {
        undone.push(`W${r.number} ${r.slug} ${r.status}; its work was not merged.`)
      }
    }
    if (undone.length > 0)
      lines.push('', 'Known to be left undone:', ...undone.map((u) => `- ${u}`))
    this.host.notifySummary(lines.join('\n'))
  }
}
