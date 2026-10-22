import type {
  SessionProjectRow,
  SessionProjectsRepo
} from '../db/repositories/session-projects-repo'
import type { ReviewMarksRepo } from '../db/repositories/review-marks-repo'
import type { MergeGit } from '../git/merge'
import type { PushGit } from '../git/push'
import { AppErrorException } from '../../shared/errors'
import { LARGE_FILE_LINES, TOO_LARGE_FILE_LINES, parseUnifiedDiff } from '../git/review-git'
import type { ReviewFileChange, ReviewGit } from '../git/review-git'
import { sortLabels, workersOfFile } from './attribution'
import type { Attribution } from './attribution'
import { hunkOfNewFile, readUntracked } from './untracked'
import type {
  ReviewFile,
  ReviewFileDiff,
  ReviewFileSource,
  ReviewFileStatus,
  ReviewPush,
  ReviewRepo,
  ReviewSnapshot,
  ReviewUncommitted,
  ReviewUncommittedFile
} from '../../shared/types/review'

const CACHE_LIMIT = 64

export interface ReviewServiceLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface ReviewServiceDeps {
  sessionProjectsRepo: Pick<SessionProjectsRepo, 'listBySession' | 'setBaseSha'>
  mergeGit: Pick<MergeGit, 'sessionTip' | 'isAncestor'>
  reviewGit: ReviewGit
  /** Only `chooseRemote` (read-only) is used: whether the repository has a remote to push to. */
  pushGit: Pick<PushGit, 'chooseRemote'>
  attribution: Attribution
  marksRepo: Pick<ReviewMarksRepo, 'listByProject' | 'mark' | 'unmark'>
  log: ReviewServiceLog
}

/** A changed file as cached: git's record with its fingerprint, plus who changed it. Marks are applied on top. */
type CachedFile = ReviewFileChange & { workers: string[] }

/** Uncommitted changes carry no fingerprint: only committed session files can be marked reviewed. */
function withoutFingerprint(change: ReviewFileChange): ReviewUncommittedFile {
  const { path, oldPath, status, added, removed, binary, large } = change
  return {
    path,
    ...(oldPath !== undefined ? { oldPath } : {}),
    status,
    added,
    removed,
    binary,
    large
  }
}

/** A session project that has a session branch in a git repository. */
export type ReviewableRow = SessionProjectRow & { projectId: string; branchName: string }

function isReviewable(row: SessionProjectRow): row is ReviewableRow {
  return !row.readOnly && row.branchName !== null && row.projectId !== null
}

/** What undo needs to know about one changed file (`ReviewService.locateFile`). */
export interface LocatedFile {
  row: ReviewableRow
  base: string
  tip: string
  file: { path: string; oldPath?: string; status: ReviewFileStatus }
}

/**
 * Builds the change review of a session (tech spec 2.1, 2.2): per repository, the files that differ between
 * the base recorded when the branch started and the session branch's effective tip. Nothing is stored; results
 * are cached in memory by (repo, base, tip), which is safe because a diff between two commits never changes.
 */
export class ReviewService {
  private readonly cache = new Map<string, CachedFile[]>()
  private readonly warnedBases = new Set<string>()

  constructor(private readonly deps: ReviewServiceDeps) {}

  async getReview(sessionId: string): Promise<Omit<ReviewSnapshot, 'notes'>> {
    const rows = this.deps.sessionProjectsRepo.listBySession(sessionId).filter(isReviewable)
    const repos = await Promise.all(rows.map((row) => this.reviewRepo(row)))
    const present = repos.filter((r): r is ReviewRepo => r !== null)
    const workers = sortLabels(present.flatMap((repo) => repo.files.flatMap((f) => f.workers)))
    return { sessionId, repos: present, workers }
  }

  /**
   * Ticks or unticks a changed session file (`review:set-reviewed`). The path must be a currently changed file
   * of that project; uncommitted files cannot be ticked. Ticking stores the file's current fingerprint.
   */
  async setReviewed(
    sessionId: string,
    projectId: string,
    path: string,
    reviewed: boolean
  ): Promise<void> {
    const row = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter(isReviewable)
      .find((r) => r.projectId === projectId)
    const range = row ? await this.rangeOf(row) : null
    if (!row || range === null) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const file = (await this.filesFor(sessionId, row.projectPath, range.base, range.tip)).find(
      (f) => f.path === path
    )
    if (!file) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    if (reviewed) this.deps.marksRepo.mark(row.id, file.path, file.fingerprint)
    else this.deps.marksRepo.unmark(row.id, file.path)
  }

  /**
   * A currently changed session file with the base it is compared with and the row of its repository, for
   * undo. `atTip` pins the tip the caller already read (inside the merge queue); without it the effective tip is
   * read. `REVIEW_FILE_NOT_FOUND` when the project is not reviewable or the path is not a changed file.
   */
  async locateFile(
    sessionId: string,
    projectId: string,
    path: string,
    atTip?: string
  ): Promise<LocatedFile> {
    const row = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter(isReviewable)
      .find((r) => r.projectId === projectId)
    if (!row) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const tip =
      atTip ?? (await this.deps.mergeGit.sessionTip(row.projectPath, row.branchName)).effectiveTip
    const base = await this.resolveBase(row, tip)
    if (base === null) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const file = (await this.filesFor(sessionId, row.projectPath, base, tip)).find(
      (f) => f.path === path
    )
    if (!file) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    return {
      row,
      base,
      tip,
      file: {
        path: file.path,
        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
        status: file.status
      }
    }
  }

  /** Changed files summed over every repository of the session. */
  async changedFileCount(sessionId: string): Promise<number> {
    const snapshot = await this.getReview(sessionId)
    return snapshot.repos.reduce((sum, repo) => sum + repo.files.length, 0)
  }

  /**
   * One file's change (`review:file`), between the same base and tip the review list uses. Binary files give
   * no text; a file over 2,000 changed lines waits for `showAnyway`; over 50,000 it is never shown.
   * `REVIEW_FILE_NOT_FOUND` when the path is not a changed file of that project.
   */
  async getFile(
    sessionId: string,
    projectId: string,
    path: string,
    showAnyway: boolean,
    source: ReviewFileSource = 'session'
  ): Promise<ReviewFileDiff> {
    const row = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter(isReviewable)
      .find((r) => r.projectId === projectId)
    if (source === 'uncommitted') {
      if (!row) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
      return this.getUncommittedFile(row, path, showAnyway)
    }
    const range = row ? await this.rangeOf(row) : null
    if (!row || range === null) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const file = (await this.filesFor(sessionId, row.projectPath, range.base, range.tip)).find(
      (f) => f.path === path
    )
    if (!file) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    if (file.binary) return { kind: 'binary' }
    const changedLines = file.added + file.removed
    if (changedLines > TOO_LARGE_FILE_LINES) return { kind: 'tooLarge', changedLines }
    if (changedLines > LARGE_FILE_LINES && !showAnyway) return { kind: 'large', changedLines }
    const text = await this.deps.reviewGit.fileDiff(
      row.projectPath,
      range.base,
      range.tip,
      file.path,
      file.oldPath
    )
    return { kind: 'text', hunks: parseUnifiedDiff(text) }
  }

  /**
   * One uncommitted file's change. The path must be one the current "Not committed" list reports, so no other
   * path is ever read.
   */
  private async getUncommittedFile(
    row: ReviewableRow,
    path: string,
    showAnyway: boolean
  ): Promise<ReviewFileDiff> {
    const { reviewGit } = this.deps
    const repo = row.projectPath
    if ((await reviewGit.currentBranch(repo)) !== row.branchName) {
      throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    }
    const { tracked, untracked } = await reviewGit.uncommittedChanges(repo)
    const change = tracked.find((f) => f.path === path)
    if (change) {
      if (change.binary) return { kind: 'binary' }
      const changedLines = change.added + change.removed
      if (changedLines > TOO_LARGE_FILE_LINES) return { kind: 'tooLarge', changedLines }
      if (changedLines > LARGE_FILE_LINES && !showAnyway) return { kind: 'large', changedLines }
      const text = await reviewGit.headFileDiff(repo, change.path, change.oldPath)
      return { kind: 'text', hunks: parseUnifiedDiff(text) }
    }
    if (!untracked.includes(path)) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const read = await readUntracked(repo, path)
    if (read === null) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    if (read.file.binary) return { kind: 'binary' }
    if (read.lines === null) return { kind: 'tooLarge', changedLines: 0 }
    const changedLines = read.lines.length
    if (changedLines > TOO_LARGE_FILE_LINES) return { kind: 'tooLarge', changedLines }
    if (changedLines > LARGE_FILE_LINES && !showAnyway) return { kind: 'large', changedLines }
    return { kind: 'text', hunks: hunkOfNewFile(read.lines, read.noNewlineAtEnd) }
  }

  /**
   * The review marks laid over the cached list (marks change without the tip changing, so they are never part of
   * the cache). A file is reviewed while its stored fingerprint equals the current one; a mark with another
   * fingerprint means it changed since. Marks of files no longer listed are ignored and kept.
   */
  private withMarks(sessionProjectId: number, files: CachedFile[]): ReviewFile[] {
    const marks = new Map(
      this.deps.marksRepo.listByProject(sessionProjectId).map((m) => [m.path, m.fingerprint])
    )
    return files.map(({ fingerprint, ...file }) => {
      const stored = marks.get(file.path)
      return {
        ...file,
        reviewed: stored === fingerprint,
        changedSinceReviewed: stored !== undefined && stored !== fingerprint
      }
    })
  }

  /**
   * The push state of a repository. A merge waiting for the user's checkout comes first (push sends the real
   * branch only); then a recorded push with the commits made since; otherwise whether a remote exists.
   */
  private async pushStateOf(
    row: ReviewableRow,
    tip: string,
    waiting: boolean
  ): Promise<ReviewPush> {
    if (waiting) return { state: 'waiting' }
    try {
      if (row.pushedAt !== null && row.pushedRemote !== null) {
        const newerCommits =
          row.pushedSha === null
            ? 0
            : await this.deps.reviewGit.countCommits(row.projectPath, row.pushedSha, tip)
        return { state: 'pushed', remote: row.pushedRemote, at: row.pushedAt, newerCommits }
      }
      const remote = await this.deps.pushGit.chooseRemote(row.projectPath, row.branchName)
      return remote === null ? { state: 'no-remote' } : { state: 'never' }
    } catch (error: unknown) {
      this.deps.log.warn(
        `review: could not read the push state of ${row.projectName}: ${error instanceof Error ? error.message : String(error)}`
      )
      return { state: 'never' }
    }
  }

  /** A failure reading the checkout must not take the repository's committed changes with it. */
  private async uncommittedSafely(row: ReviewableRow): Promise<ReviewUncommitted> {
    try {
      return await this.uncommittedOf(row)
    } catch (error: unknown) {
      this.deps.log.warn(
        `review: could not read uncommitted changes of ${row.projectName}: ${error instanceof Error ? error.message : String(error)}`
      )
      return { state: 'unavailable' }
    }
  }

  /** The "Not committed" section: recomputed on every call, only while the checkout is on the session branch. */
  private async uncommittedOf(row: ReviewableRow): Promise<ReviewUncommitted> {
    const { reviewGit } = this.deps
    const repo = row.projectPath
    const current = await reviewGit.currentBranch(repo)
    if (current !== row.branchName) return { state: 'other-branch', current }
    const { tracked, untracked } = await reviewGit.uncommittedChanges(repo)
    const files: ReviewUncommittedFile[] = tracked.map(withoutFingerprint)
    const seen = new Set(tracked.map((f) => f.path))
    for (const path of untracked) {
      if (seen.has(path)) continue
      const read = await readUntracked(repo, path)
      if (read) files.push(read.file)
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { state: 'ok', files }
  }

  /** The base and the effective tip a repository is reviewed between, or null without a base. */
  private async rangeOf(
    row: ReviewableRow
  ): Promise<{ base: string; tip: string; waiting: boolean } | null> {
    const sessionTip = await this.deps.mergeGit.sessionTip(row.projectPath, row.branchName)
    const tip = sessionTip.effectiveTip
    const waiting = tip !== sessionTip.branchTip
    const base = await this.resolveBase(row, tip)
    if (base === null) {
      this.deps.log.warn(`review: no base for ${row.projectName} on ${row.branchName}`)
      return null
    }
    return { base, tip, waiting }
  }

  private async reviewRepo(row: ReviewableRow): Promise<ReviewRepo | null> {
    const { projectPath: repo, branchName: branch } = row
    try {
      const range = await this.rangeOf(row)
      if (range === null) return null
      const { base, tip, waiting } = range
      return {
        projectId: row.projectId,
        projectName: row.projectName,
        branch,
        files: this.withMarks(row.id, await this.filesFor(row.sessionId, repo, base, tip)),
        uncommitted: await this.uncommittedSafely(row),
        push: await this.pushStateOf(row, tip, waiting)
      }
    } catch (error: unknown) {
      this.deps.log.warn(
        `review: could not read ${row.projectName} on ${branch}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * The stored base when it is still an ancestor of the tip. A missing base (a session from before review)
   * is derived once with `merge-base <base_branch> <tip>` and stored. A stored base that is no longer an
   * ancestor (history rewritten outside Arc) is re-derived for this call only: the stored value stays, a
   * warning is logged once, and the next review tries the stored value again.
   */
  private async resolveBase(row: ReviewableRow, tip: string): Promise<string | null> {
    const { projectPath: repo, baseBranch } = row
    if (row.baseSha === null) {
      const derived =
        baseBranch === null ? null : await this.deps.reviewGit.mergeBase(repo, baseBranch, tip)
      if (derived !== null) this.deps.sessionProjectsRepo.setBaseSha(row.id, derived)
      return derived
    }
    if (await this.deps.mergeGit.isAncestor(repo, row.baseSha, tip)) return row.baseSha
    const warnKey = `${row.id}:${row.baseSha}`
    if (!this.warnedBases.has(warnKey)) {
      this.warnedBases.add(warnKey)
      this.deps.log.warn(
        `review: the base ${row.baseSha} of ${row.projectName} is no longer in ${row.branchName}; using merge-base with ${baseBranch ?? 'the base branch'}`
      )
    }
    return baseBranch === null ? null : this.deps.reviewGit.mergeBase(repo, baseBranch, tip)
  }

  /**
   * The changed files with who changed them. Cached by (repo, base, tip) plus the attribution version: the
   * worker commit and merge rows are written around the time the tip moves, so a list built just before the
   * rows landed is not reused.
   */
  private async filesFor(
    sessionId: string,
    repo: string,
    base: string,
    tip: string
  ): Promise<CachedFile[]> {
    const { attribution } = this.deps
    const key = `${repo}\0${base}\0${tip}\0${attribution.version(sessionId)}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const [changes, byPath] = await Promise.all([
      this.deps.reviewGit.listChanges(repo, base, tip),
      attribution.attribute({ sessionId, repo, base, tip })
    ])
    const files = changes.map((f) => ({ ...f, workers: workersOfFile(byPath, f.path, f.oldPath) }))
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, files)
    return files
  }
}
