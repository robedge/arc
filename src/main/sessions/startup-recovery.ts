import type { Db } from '../db/client'
import type { AttentionRepo } from '../db/repositories/attention-repo'
import type { EventsRepo } from '../db/repositories/events-repo'
import type { MessagesRepo } from '../db/repositories/messages-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import { ASK_USER_QUESTION_TOOL } from './attention-questions'

export interface StartupRecoveryDeps {
  db: Pick<Db, 'transaction'>
  workersRepo: Pick<
    WorkersRepo,
    'recoverInterrupted' | 'pauseAllActiveControl' | 'get' | 'setStatus'
  >
  attentionRepo: Pick<AttentionRepo, 'cancelPendingToolQuestions' | 'listPending'>
  messagesRepo: Pick<MessagesRepo, 'recoverStreaming'>
  eventsRepo: Pick<EventsRepo, 'append'>
  now: number
}

/**
 * Before the UI reads anything: workers that were starting or working when Arc died become Stopped
 * (crash), with an event each; streaming brain messages become stopped. Workers waiting on an
 * approval or an answer keep their status, except that a pending `AskUserQuestion` (its call died
 * with the process) is cancelled and its worker, if nothing else is pending for it, becomes Stopped
 * so Continue resumes it with a note to ask again. A worker the user is in control of is paused,
 * never stopped (its process died with Arc; the next typed line or Hand back resumes it). One transaction.
 */
export function recoverAtStartup(deps: StartupRecoveryDeps): { workers: number; messages: number } {
  return deps.db.transaction(() => {
    deps.workersRepo.pauseAllActiveControl(deps.now)
    const rows = deps.workersRepo.recoverInterrupted(deps.now)
    for (const row of rows) {
      deps.eventsRepo.append({
        sessionId: row.sessionId,
        at: deps.now,
        kind: 'worker-stopped',
        text: 'Stopped when Arc closed unexpectedly',
        workerId: row.id,
        dataJson: null
      })
    }
    for (const row of deps.attentionRepo.cancelPendingToolQuestions(
      ASK_USER_QUESTION_TOOL,
      deps.now
    )) {
      if (row.workerId === null) continue
      const worker = deps.workersRepo.get(row.workerId)
      const stillWaiting = deps.attentionRepo
        .listPending(row.sessionId)
        .some((r) => r.workerId === row.workerId)
      if (!worker || stillWaiting || worker.status !== 'has_question') continue
      if (worker.userControl !== null) continue
      deps.workersRepo.setStatus(worker.id, 'stopped', deps.now, 'crash')
      deps.eventsRepo.append({
        sessionId: row.sessionId,
        at: deps.now,
        kind: 'worker-stopped',
        text: 'Stopped when Arc closed; its question was cancelled',
        workerId: worker.id,
        dataJson: null
      })
    }
    const messages = deps.messagesRepo.recoverStreaming(deps.now)
    return { workers: rows.length, messages }
  })
}
