import type { WorkerStoppedBy } from '@shared/types/session'

export interface WorkerExitInput {
  code: number | null
  signal: string | null
  /** The supervisor reported the exit as one it caused (stop, interrupt ladder, quit). */
  expected: boolean
  stderrTail: string
  /** Arc asked this worker to stop, and why. */
  stopRequestedBy: WorkerStoppedBy | null
  /** `report_done` was accepted. */
  reportedDone: boolean
  /** A turn ended with a result after the worker started. */
  sawResult: boolean
}

export type WorkerExitOutcome =
  | { status: 'done' }
  | { status: 'stopped'; stoppedBy: WorkerStoppedBy }
  | { status: 'failed'; reason: string }

const REASON_MAX = 240

function lastStderrLine(tail: string): string {
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return lines[lines.length - 1] ?? ''
}

/**
 * Exit classification (tech spec 2.3):
 * - Done: the worker reported done, ended a turn, and exited cleanly (or by our own stop after it reported).
 * - Stopped: Arc stopped it (the user's Stop, or quit).
 * - Failed: anything else; the reason comes from the signal or exit code and the last stderr line.
 */
export function classifyWorkerExit(input: WorkerExitInput): WorkerExitOutcome {
  if (input.stopRequestedBy !== null) {
    return { status: 'stopped', stoppedBy: input.stopRequestedBy }
  }
  if (input.reportedDone && input.sawResult && (input.code === 0 || input.expected)) {
    return { status: 'done' }
  }
  let reason: string
  if (input.signal !== null) {
    reason = `The worker was killed by signal ${input.signal}.`
  } else if (input.code !== null && input.code !== 0) {
    reason = `The worker exited with code ${input.code}.`
  } else if (input.reportedDone) {
    reason = 'The worker exited before it finished its last turn.'
  } else {
    reason = 'The worker exited without reporting that it was done.'
  }
  const detail = lastStderrLine(input.stderrTail)
  if (detail !== '') reason += ` ${detail}`
  return { status: 'failed', reason: reason.slice(0, REASON_MAX) }
}
