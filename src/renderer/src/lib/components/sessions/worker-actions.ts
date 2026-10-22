import type { AppError } from '@shared/errors'
import type { WorkerView } from '@shared/types/session'
import { messageFor } from '../../ipc/messages'
import { activeSession } from '../../stores/active-session.svelte'
import { workerTerminals } from '../../stores/worker-terminals.svelte'

/** The exact unmerged-commit count (`workers:get` reads git); falls back to the card's figure. */
export async function freshUnmerged(worker: WorkerView): Promise<number> {
  const res = await window.harness.invoke('workers:get', { workerId: worker.id })
  return res.ok ? res.data.unmergedCommits : worker.unmergedCommits
}

/** Removes a finished worker; on success drops it locally, closes its tab and details. */
export async function removeWorker(workerId: string): Promise<string | null> {
  const res = await window.harness.invoke('workers:remove', { workerId })
  if (!res.ok) {
    return res.error.code === 'VALIDATION_FAILED' ? 'Stop the worker first.' : messageFor(res.error)
  }
  workerTerminals.close(workerId)
  if (workerTerminals.detailsId === workerId) workerTerminals.closeDetails()
  activeSession.dropWorker(workerId)
  return null
}

/** A stopped worker the user did not stop, with its working copy intact, can be continued. */
export function canContinue(
  worker: Pick<WorkerView, 'status' | 'stoppedBy' | 'hasWorkingCopy'>
): boolean {
  return worker.status === 'stopped' && worker.stoppedBy !== 'user' && worker.hasWorkingCopy
}

/** The sentence to show when a continue request was refused. */
function refusal(error: AppError): string {
  return error.details?.reason ?? messageFor(error)
}

/** Continues one worker; returns the refusal reason, or null on success. */
export async function continueWorker(workerId: string): Promise<string | null> {
  const res = await window.harness.invoke('workers:continue', { workerId })
  return res.ok ? null : refusal(res.error)
}

/** Continues every continuable worker of a session; returns the refusal reason, or null. */
export async function continueAll(sessionId: string): Promise<string | null> {
  const res = await window.harness.invoke('workers:continue', { sessionId, all: true })
  return res.ok ? null : refusal(res.error)
}
