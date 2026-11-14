import type { BranchQuestionsRepo } from '../db/repositories/branch-questions-repo'
import type {
  SessionProjectRow,
  SessionProjectsRepo
} from '../db/repositories/session-projects-repo'
import type { SessionsRepo } from '../db/repositories/sessions-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import { SESSION_BRANCH_PREFIX } from '../git/session-git'
import { workerLabel } from './worker-label'
import type {
  DirtyChoice,
  DirtyRepoInfo,
  SessionBranchResult,
  SessionGit,
  SessionGitProject
} from '../git/session-git'

/**
 * Creates a session's branch in a repository when a worker first needs it (spec 013, tech spec 2.2).
 *
 * The session name only chooses the branch name (`sessions.slug`). Nothing is created until a worker
 * is about to start, and `session_projects.branch_name` stays the source of truth for "has a branch".
 * A repository with unsaved changes gets a question (`branch_questions`) instead of a branch. The
 * worker waits, and nothing is created for any project of that worker until every question it needs
 * is answered. Which workers wait on a question is derived from the queued workers, never stored.
 */

/** The answer of `ensure`. `waiting`: a question is open for each named project and nothing was created. */
export type EnsureResult =
  | { status: 'ready' }
  | { status: 'waiting'; projectNames: string[] }
  | { status: 'failed'; reason: string }

/** What the user can choose for unsaved changes. `skip` is "Don't start": nothing is created or changed. */
export type AnswerChoice = 'stash' | 'commit' | 'carry' | 'skip'

/** The choices that make a branch. Only these can stand for a second worker. */
type KeepChoice = Exclude<AnswerChoice, 'skip'>

/** `create` failed; `projectId` is set when the user's own changes in that project clash with the base branch. */
interface CreateFailed {
  status: 'failed'
  reason: string
  projectId?: string
}
type CreateResult = Exclude<EnsureResult, { status: 'failed' }> | CreateFailed

/** `not-open`: the question is gone or already answered. `failed`: the question is open again with the reason. */
export type AnswerResult =
  { status: 'ok' } | { status: 'not-open' } | { status: 'failed'; reason: string }

export interface BranchOnDemandDeps {
  sessionsRepo: Pick<SessionsRepo, 'getById'>
  sessionProjectsRepo: SessionProjectsRepo
  /** Read to find the queued workers that wait on a question. */
  workersRepo: Pick<WorkersRepo, 'listBySession' | 'setFailure' | 'setActivity'>
  branchQuestionsRepo: BranchQuestionsRepo
  sessionGit: SessionGit
  /** Writes a session event (`SessionService.logEvent`). */
  logEvent: (
    sessionId: string,
    kind: string,
    text: string,
    data?: unknown,
    workerId?: string
  ) => void
  /** Sends `session:header` for the session. */
  pushHeader: (sessionId: string) => void
  /** Starts queued workers that can run now (`WorkerManager.drain`). */
  drain: (sessionId: string) => void
  /** Workers were changed here (failed by "Don't start"): their cards must be pushed again. */
  onWorkersChanged: (sessionId: string, workerIds: readonly string[]) => void
  /** Tells the brain something with its next message (`Orchestrator.sendNote`). */
  notifyBrain: (sessionId: string, text: string) => void
  /** A question opened, was answered, was put back or was closed; the attention card must be refreshed. */
  onQuestionsChanged: (sessionId: string) => void
  now: () => number
  log: { warn: (message: string, ...rest: unknown[]) => void }
}

interface Named {
  id: string
  name: string
  slug: string
}

type ApplyOne =
  | { status: 'started'; branchName: string; collided: boolean; result: SessionBranchResult }
  | { status: 'carry-failed' }
  | { status: 'unsaved' }
  | { status: 'failed'; message: string }

/** One branch that exists now and still has to be written down and announced. */
interface Made {
  project: SessionGitProject
  result: SessionBranchResult
  /** Said in the event log: the name was taken, or the branch was found already in place. */
  note: 'created' | 'collided' | 'adopted'
}

function parseIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function gitProjectOf(row: SessionProjectRow): SessionGitProject {
  return {
    projectId: row.projectId as string,
    name: row.projectName,
    path: row.projectPath,
    isGit: true
  }
}

export class BranchOnDemand {
  /** One chain per session: the calls of a session run one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: BranchOnDemandDeps) {}

  /**
   * Makes sure every git project in `projectIds` has the session branch. Projects that already have
   * one, and read-only projects, are left alone. All or nothing: when any project cannot get its
   * branch, the ones made in this call are taken back and nothing is recorded.
   */
  ensure(
    sessionId: string,
    projectIds: readonly string[],
    workerId: string
  ): Promise<EnsureResult> {
    return this.locked(sessionId, () => {
      // An answer the user already gave for a project that has no branch yet (another worker still
      // waits on a different project) stands, so the same question is not asked twice.
      const wanted = new Set(projectIds)
      const rows = this.deps.sessionProjectsRepo
        .listBySession(sessionId)
        .filter((r) => r.projectId !== null && wanted.has(r.projectId))
      return this.create(
        sessionId,
        projectIds,
        workerId,
        this.answeredChoices(sessionId, rows, workerId)
      )
    })
  }

  /**
   * Closes the questions nobody waits on: the project has no queued worker that needs it, or it is
   * no longer part of the session. Runs under the session lock, so it never lands in the middle of a
   * spawn that is opening a question; a worker still `starting` counts as a waiter for the same reason.
   */
  cancelOrphans(sessionId: string): Promise<void> {
    return this.locked(sessionId, () => Promise.resolve(this.cancelOrphansNow(sessionId)))
  }

  /** Names of the projects among `projectIds` that have an open question (derived, not stored). */
  waitingOn(sessionId: string, projectIds: readonly string[]): string[] {
    const wanted = new Set(projectIds)
    return this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter(
        (r) =>
          r.projectId !== null &&
          wanted.has(r.projectId) &&
          this.deps.branchQuestionsRepo.getPendingFor(r.id) !== undefined
      )
      .map((r) => r.projectName)
  }

  /**
   * Applies the user's choice for one question, then creates the branches of every queued worker
   * that waited on that project and has no open question left, and lets the worker manager start
   * them. The project is looked at again now: changes the user saved meanwhile are simply not set
   * aside, and files added since are set aside with the rest. Arc never throws changes away.
   * `onAccepted` runs once, when the answer is accepted and before the work starts; not for `not-open`.
   */
  answer(questionId: string, choice: AnswerChoice, onAccepted?: () => void): Promise<AnswerResult> {
    const question = this.deps.branchQuestionsRepo.getById(questionId)
    if (!question) return Promise.resolve({ status: 'not-open' })
    return this.locked(question.sessionId, () => this.runAnswer(questionId, choice, onAccepted))
  }

  private locked<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    const tail = next.catch(() => undefined)
    this.locks.set(sessionId, tail)
    void tail.then(() => {
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId)
    })
    return next
  }

  private namedSession(sessionId: string): Named | null {
    const row = this.deps.sessionsRepo.getById(sessionId)
    if (!row || row.slug === null) return null
    return { id: row.id, name: row.name, slug: row.slug }
  }

  private cancelOrphansNow(sessionId: string): void {
    const { branchQuestionsRepo: questions, sessionProjectsRepo: projects } = this.deps
    const pending = questions.listPending(sessionId)
    if (pending.length === 0) return
    const rows = projects.listBySession(sessionId)
    const needed = this.neededProjectIds(sessionId, ['queued', 'starting'])
    let closed = false
    for (const question of pending) {
      const row = rows.find((r) => r.id === question.sessionProjectId)
      const orphan =
        !row || row.projectId === null || row.membership !== 'active' || !needed.has(row.projectId)
      if (orphan && questions.cancel(question.id, this.deps.now())) closed = true
    }
    if (closed) this.deps.onQuestionsChanged(sessionId)
  }

  /** The ids of the projects that workers in these states need, optionally leaving one worker out. */
  private neededProjectIds(
    sessionId: string,
    states: readonly string[],
    except?: string
  ): Set<string> {
    const ids = new Set<string>()
    for (const worker of this.deps.workersRepo.listBySession(sessionId)) {
      if (!states.includes(worker.status) || worker.id === except) continue
      for (const id of parseIds(worker.projectIdsJson)) ids.add(id)
    }
    return ids
  }

  /** "Don't start": every queued worker that needs the project ends failed, and nothing is touched in git. */
  private skip(sessionId: string, row: SessionProjectRow): void {
    const projectId = row.projectId as string
    const reason = `Not started: you chose to leave ${row.projectName} as it is`
    const failed = this.deps.workersRepo
      .listBySession(sessionId)
      .filter((w) => w.status === 'queued' && parseIds(w.projectIdsJson).includes(projectId))
    for (const worker of failed) {
      this.deps.workersRepo.setFailure(worker.id, reason, this.deps.now())
      this.deps.workersRepo.setActivity(worker.id, null, this.deps.now())
      this.deps.logEvent(
        sessionId,
        'worker-failed',
        `${workerLabel(worker)} failed: ${reason}`,
        undefined,
        worker.id
      )
    }
    if (failed.length > 0) {
      this.deps.onWorkersChanged(
        sessionId,
        failed.map((w) => w.id)
      )
      this.deps.notifyBrain(
        sessionId,
        `[Arc] The user chose not to start work in ${row.projectName} (unsaved changes). Not started: ${failed
          .map(workerLabel)
          .join(
            ', '
          )}. Nothing was changed in ${row.projectName}. Tell the user or change your approach.`
      )
    }
    // A worker that also waited on another project is gone too, so that question may have no one left.
    this.cancelOrphansNow(sessionId)
  }

  private async runAnswer(
    questionId: string,
    choice: AnswerChoice,
    onAccepted?: () => void
  ): Promise<AnswerResult> {
    const { branchQuestionsRepo: questions, sessionProjectsRepo: projects } = this.deps
    const question = questions.getById(questionId)
    if (!question || question.status !== 'pending') return { status: 'not-open' }
    const sessionId = question.sessionId
    const row = projects.listBySession(sessionId).find((r) => r.id === question.sessionProjectId)
    if (!row || row.projectId === null) return { status: 'not-open' }
    if (!questions.resolve(questionId, choice, this.deps.now())) return { status: 'not-open' }
    // The click is accepted here, before any git work: whoever listens can note it at this moment.
    try {
      onAccepted?.()
    } catch (error: unknown) {
      this.deps.log.warn('could not note the accepted unsaved-changes answer', error)
    }
    // A carry can clash and bring the panel back. Pushing the empty list first would remove the user's
    // request panel from the dock, so for a carry the one push comes after the outcome is known.
    if (choice !== 'carry') this.deps.onQuestionsChanged(sessionId)

    if (choice === 'skip') {
      this.skip(sessionId, row)
      this.deps.drain(sessionId)
      return { status: 'ok' }
    }

    let failure: CreateFailed | null = null
    for (const worker of this.deps.workersRepo.listBySession(sessionId)) {
      const ids = parseIds(worker.projectIdsJson)
      if (worker.status !== 'queued' || !ids.includes(row.projectId)) continue
      const rows = projects
        .listBySession(sessionId)
        .filter((r) => r.projectId !== null && ids.includes(r.projectId))
      // A worker that still needs another answer keeps waiting, and nothing is made for it yet.
      if (rows.some((r) => questions.getPendingFor(r.id) !== undefined)) continue
      const result = await this.create(
        sessionId,
        ids,
        worker.id,
        this.answeredChoices(sessionId, rows)
      )
      if (result.status === 'failed') {
        failure = result
        break
      }
    }
    if (failure !== null) {
      // The question is asked again, with the reason; the changes were not touched. When the clash
      // is in another project whose choice was given earlier, that project's card comes back instead.
      const other =
        failure.projectId !== undefined && failure.projectId !== row.projectId
          ? projects.listBySession(sessionId).find((r) => r.projectId === failure?.projectId)
          : undefined
      const target = other ? questions.lastAnsweredFor(other.id)?.id : undefined
      questions.reopenWithMessage(target ?? questionId, failure.reason)
    }
    if (failure !== null || choice === 'carry') this.deps.onQuestionsChanged(sessionId)
    this.deps.drain(sessionId)
    return failure === null ? { status: 'ok' } : { status: 'failed', reason: failure.reason }
  }

  /**
   * The choices the user already made for projects that still have no branch. An answer only stands
   * while a queued worker (other than `except`) still needs that project: once its workers failed or
   * were stopped, the next worker there asks again. "Don't start" is never reused.
   */
  private answeredChoices(
    sessionId: string,
    rows: readonly SessionProjectRow[],
    except?: string
  ): Map<string, KeepChoice> {
    const choices = new Map<string, KeepChoice>()
    const waiting = this.neededProjectIds(sessionId, ['queued'], except)
    for (const r of rows) {
      if (r.projectId === null || r.branchName !== null || !waiting.has(r.projectId)) continue
      const last = this.deps.branchQuestionsRepo.lastAnsweredFor(r.id)
      const choice = last?.choice
      if (choice === 'stash' || choice === 'commit' || choice === 'carry') {
        choices.set(r.projectId, choice)
      }
    }
    return choices
  }

  /**
   * Makes the branches of one worker. A dirty project without a choice in `choices` gets a question
   * and the call returns `waiting` before anything is created.
   */
  private async create(
    sessionId: string,
    projectIds: readonly string[],
    workerId: string,
    choices: ReadonlyMap<string, KeepChoice>
  ): Promise<CreateResult> {
    const session = this.namedSession(sessionId)
    if (!session) {
      return { status: 'failed', reason: 'The session has no branch name yet' }
    }
    const wanted = new Set(projectIds)
    const todoRows = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter(
        (r) =>
          !r.readOnly && r.projectId !== null && r.branchName === null && wanted.has(r.projectId)
      )
    const todo = todoRows.map(gitProjectOf)
    if (todo.length === 0) return { status: 'ready' }

    const made: Made[] = []
    const created: Made[] = []
    try {
      // A branch Arc made just before a crash is taken over instead of made again.
      const creating: SessionGitProject[] = []
      for (const project of todo) {
        const found = await this.deps.sessionGit.adoptableBranch(
          project.path,
          SESSION_BRANCH_PREFIX + session.slug
        )
        if (!found) {
          creating.push(project)
          continue
        }
        made.push({
          project,
          note: 'adopted',
          result: {
            projectId: project.projectId,
            branchName: SESSION_BRANCH_PREFIX + session.slug,
            baseBranch: found.baseBranch,
            previousBranch: null,
            baseSha: found.baseSha,
            readOnly: false,
            dirtyHandling: 'none',
            stashRef: null
          }
        })
      }
      // Checked for every project first, so a dirty one stops the call before any branch exists.
      const plan = await this.deps.sessionGit.planSessionStart(creating)
      const unanswered = plan.dirtyRepos.filter((d) => !choices.has(d.projectId))
      if (unanswered.length > 0) return this.wait(sessionId, todoRows, unanswered)
      for (const project of creating) {
        const applied = await this.applyOne(session, project, choices.get(project.projectId))
        if (applied.status !== 'started') {
          await this.takeBack(created)
          if (applied.status === 'carry-failed') {
            return {
              status: 'failed',
              projectId: project.projectId,
              reason: `The changes in ${project.name} clash with the branch the session branch starts from, so they cannot come along. Choose another way.`
            }
          }
          return {
            status: 'failed',
            reason:
              applied.status === 'unsaved'
                ? `${project.name} has unsaved changes`
                : applied.status === 'failed'
                  ? applied.message
                  : `Could not create the session branch in ${project.name}`
          }
        }
        created.push({
          project,
          result: applied.result,
          note: applied.collided ? 'collided' : 'created'
        })
      }
      made.push(...created)
    } catch (error: unknown) {
      await this.takeBack(created)
      return { status: 'failed', reason: errorText(error) }
    }
    if (!this.deps.sessionsRepo.getById(sessionId)) {
      await this.takeBack(made.filter((m) => m.note !== 'adopted'))
      return { status: 'failed', reason: 'The session no longer exists' }
    }
    this.record(sessionId, made, workerId)
    this.closeQuestionsOf(sessionId, todoRows, made)
    return { status: 'ready' }
  }

  /** Opens the question of each dirty project (one per project, shared by every worker) and reports `waiting`. */
  private wait(
    sessionId: string,
    rows: readonly SessionProjectRow[],
    dirty: readonly DirtyRepoInfo[]
  ): EnsureResult {
    const questions = this.deps.branchQuestionsRepo
    let opened = false
    for (const d of dirty) {
      const row = rows.find((r) => r.projectId === d.projectId)
      if (!row) continue
      if (questions.getPendingFor(row.id) === undefined) opened = true
      questions.openFor(sessionId, row.id, this.deps.now())
    }
    if (opened) this.deps.onQuestionsChanged(sessionId)
    return { status: 'waiting', projectNames: dirty.map((d) => d.name) }
  }

  /** A question left open for a project that now has its branch (it was cleaned up by hand) is closed. */
  private closeQuestionsOf(
    sessionId: string,
    rows: readonly SessionProjectRow[],
    made: readonly Made[]
  ): void {
    const questions = this.deps.branchQuestionsRepo
    let closed = false
    for (const { project } of made) {
      const row = rows.find((r) => r.projectId === project.projectId)
      const open = row ? questions.getPendingFor(row.id) : undefined
      if (open && questions.cancel(open.id, this.deps.now())) closed = true
    }
    if (closed) this.deps.onQuestionsChanged(sessionId)
  }

  /** One `planSessionStart` and one `applySessionStart` for one project, with the session's fixed name. */
  private async applyOne(
    session: Named,
    project: SessionGitProject,
    choice: DirtyChoice | undefined
  ): Promise<ApplyOne> {
    const git = this.deps.sessionGit
    const fixed = SESSION_BRANCH_PREFIX + session.slug
    // The name is the same everywhere unless it was taken here after the session was named.
    const branchName = await git.uniqueBranch([project.path], session.slug)
    const plan = await git.planSessionStart([project])
    const outcome = await git.applySessionStart(plan, {
      sessionName: session.name,
      slug: session.slug,
      branchName,
      choices: { [project.projectId]: choice }
    })
    if (outcome.status === 'started') {
      const result = outcome.results.find((r) => r.projectId === project.projectId)
      if (!result) return { status: 'failed', message: `No branch was made in ${project.name}` }
      return { status: 'started', branchName, collided: branchName !== fixed, result }
    }
    if (outcome.reason === 'carry-failed') return { status: 'carry-failed' }
    if (outcome.reason === 'cancelled') return { status: 'unsaved' }
    return { status: 'failed', message: outcome.message }
  }

  /** Switches the user's copy back and removes the branches made in this call. */
  private async takeBack(made: readonly Made[]): Promise<void> {
    for (const m of [...made].reverse()) {
      const { previousBranch, baseSha, branchName } = m.result
      if (previousBranch === null || baseSha === null || branchName === null) continue
      try {
        await this.deps.sessionGit.undoSessionBranch(
          m.project.path,
          branchName,
          previousBranch,
          baseSha
        )
      } catch (error: unknown) {
        this.deps.log.warn(`could not take back ${branchName} in ${m.project.name}`, error)
      }
    }
  }

  private record(sessionId: string, made: readonly Made[], workerId: string | null): void {
    const repo = this.deps.sessionProjectsRepo
    for (const { project, result } of made) {
      if (result.readOnly || result.branchName === null) continue
      repo.setBranch(
        sessionId,
        project.projectId,
        result.branchName,
        result.baseBranch,
        result.previousBranch
      )
      if (result.baseSha !== null) {
        const row = repo.listBySession(sessionId).find((p) => p.projectId === project.projectId)
        if (row) repo.setBaseSha(row.id, result.baseSha)
      }
      if (result.dirtyHandling !== 'none') {
        repo.setDirtyHandling(sessionId, project.projectId, result.dirtyHandling, result.stashRef)
      }
    }
    for (const { project, result, note } of made) {
      const branchName = result.branchName
      if (branchName === null) continue
      const base = result.baseBranch
      const text =
        note === 'adopted'
          ? `Using ${branchName} in ${project.name}, which was already checked out`
          : `Created ${branchName} in ${project.name}${base ? ` (from ${base})` : ''}${
              note === 'collided' ? '; the usual name was already taken there' : ''
            }`
      this.deps.logEvent(sessionId, 'branch', text, {
        branchName,
        projectName: project.name,
        ...(workerId !== null ? { workerId } : {})
      })
    }
    this.deps.pushHeader(sessionId)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
