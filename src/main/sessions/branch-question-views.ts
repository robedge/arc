import type { AttentionView } from '@shared/types/session'
import type { BranchQuestionsRepo } from '../db/repositories/branch-questions-repo'
import type { SessionProjectsRepo } from '../db/repositories/session-projects-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import type { SessionGit } from '../git/session-git'
import { workerLabel } from './worker-label'

/** How many changed paths a card lists; the rest is counted in `moreFiles`. */
const MAX_FILES = 10

export interface BranchQuestionViewDeps {
  branchQuestionsRepo: Pick<BranchQuestionsRepo, 'listPending'>
  sessionProjectsRepo: Pick<SessionProjectsRepo, 'listBySession'>
  workersRepo: Pick<WorkersRepo, 'listBySession'>
  sessionGit: Pick<SessionGit, 'checkDirty'>
  log: { warn: (message: string, ...rest: unknown[]) => void }
}

function projectIdsOf(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * The cards for a session's open unsaved-changes questions, oldest first. Nothing about the files
 * is stored: the list is read from git each time the view is built, so it shows what is there now.
 * The waiting workers are derived: the queued workers whose projects include the question's one.
 */
export async function branchQuestionViews(
  deps: BranchQuestionViewDeps,
  sessionId: string
): Promise<AttentionView[]> {
  const questions = deps.branchQuestionsRepo.listPending(sessionId)
  if (questions.length === 0) return []
  const projects = deps.sessionProjectsRepo.listBySession(sessionId)
  const queued = deps.workersRepo.listBySession(sessionId).filter((w) => w.status === 'queued')
  const views: AttentionView[] = []
  for (const question of questions) {
    const project = projects.find((p) => p.id === question.sessionProjectId)
    if (!project || project.projectId === null) continue
    const projectId = project.projectId
    let files: string[] = []
    try {
      files = (await deps.sessionGit.checkDirty(project.projectPath)).files
    } catch (error: unknown) {
      deps.log.warn(`could not read the changed files of ${project.projectName}`, error)
    }
    views.push({
      id: question.id,
      route: 'queue',
      kind: 'branch',
      from: 'Arc',
      projectId,
      projectName: project.projectName,
      files: files.slice(0, MAX_FILES),
      moreFiles: Math.max(0, files.length - MAX_FILES),
      workers: queued
        .filter((w) => projectIdsOf(w.projectIdsJson).includes(projectId))
        .map(workerLabel),
      ...(question.message ? { message: question.message } : {})
    })
  }
  return views
}
