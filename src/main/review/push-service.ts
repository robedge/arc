import { AppErrorException } from '../../shared/errors'
import type { ReviewPushPreview, ReviewPushResult } from '../../shared/types/review'
import type {
  SessionProjectRow,
  SessionProjectsRepo
} from '../db/repositories/session-projects-repo'
import { GitError } from '../git/git'
import type { MergeGit } from '../git/merge'
import type { PushGit } from '../git/push'

export interface PushServiceLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface PushServiceDeps {
  sessionProjectsRepo: Pick<SessionProjectsRepo, 'listBySession' | 'recordPush'>
  mergeGit: Pick<MergeGit, 'sessionTip'>
  pushGit: PushGit
  now?: () => number
  log: PushServiceLog
}

/** What a finished push tells the session (event, `session:review-changed`). */
export interface PushOutcome extends ReviewPushResult {
  projectId: string
  /** The session branch that was pushed, `arc/<slug>`. */
  branch: string
}

/**
 * Push branch (tech spec 2.5): sends one repository's session branch to its remote, only after the user
 * confirmed the exact command in the review. It runs outside the merge queue, so it never stalls merges.
 */
export class PushService {
  constructor(private readonly deps: PushServiceDeps) {}

  /** `review:push-preview`. Errors `SESSION_NOT_FOUND`, `WAITING_FOR_CHECKOUT`, `NO_REMOTE`. */
  async preview(sessionId: string, projectId: string): Promise<ReviewPushPreview> {
    const { remote, branch } = await this.target(sessionId, projectId)
    return { command: `git push -u ${remote} ${branch}`, remote }
  }

  /** `review:push`. Errors as the preview, plus `PUSH_FAILED` carrying git's message in `details.reason`. */
  async push(sessionId: string, projectId: string): Promise<PushOutcome> {
    const { row, remote, branch } = await this.target(sessionId, projectId)
    let sha: string
    try {
      sha = await this.deps.pushGit.push(row.projectPath, remote, branch)
    } catch (error: unknown) {
      throw this.failure(error)
    }
    const pushedAt = (this.deps.now ?? Date.now)()
    this.deps.sessionProjectsRepo.recordPush(row.id, { remote, branch, sha, at: pushedAt })
    return { pushedAt, remote, sha, projectId, branch }
  }

  private failure(error: unknown): AppErrorException {
    const reason =
      error instanceof GitError
        ? error.kind === 'timeout'
          ? 'git push timed out'
          : error.stderr || error.message
        : error instanceof Error
          ? error.message
          : String(error)
    this.deps.log.warn('push failed', error)
    return new AppErrorException('PUSH_FAILED', { reason })
  }

  /** The repository, its session branch and the remote a push would go to. */
  private async target(
    sessionId: string,
    projectId: string
  ): Promise<{ row: SessionProjectRow; remote: string; branch: string }> {
    const row = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .find((r) => r.projectId === projectId && !r.readOnly && r.branchName !== null)
    if (!row || row.branchName === null) throw new AppErrorException('SESSION_NOT_FOUND')
    const branch = row.branchName
    const tip = await this.deps.mergeGit.sessionTip(row.projectPath, branch)
    if (tip.effectiveTip !== tip.branchTip) throw new AppErrorException('WAITING_FOR_CHECKOUT')
    const remote = await this.deps.pushGit.chooseRemote(row.projectPath, branch)
    if (remote === null) throw new AppErrorException('NO_REMOTE')
    return { row, remote, branch }
  }
}
