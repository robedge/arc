import { describe, expect, it } from 'vitest'
import { classifyWorkerExit } from '../../../src/main/sessions/worker-exit'
import type { WorkerExitInput, WorkerExitOutcome } from '../../../src/main/sessions/worker-exit'

const base: WorkerExitInput = {
  code: 0,
  signal: null,
  expected: false,
  stderrTail: '',
  stopRequestedBy: null,
  reportedDone: false,
  sawResult: false
}

const table: { name: string; input: Partial<WorkerExitInput>; outcome: WorkerExitOutcome }[] = [
  {
    name: 'exit 0 after a result and report_done is Done',
    input: { reportedDone: true, sawResult: true },
    outcome: { status: 'done' }
  },
  {
    name: 'Done also covers our own stop after report_done (expected exit with a signal)',
    input: { reportedDone: true, sawResult: true, code: null, signal: 'SIGTERM', expected: true },
    outcome: { status: 'done' }
  },
  {
    name: 'a stop the user asked for is Stopped, even with a signal',
    input: { stopRequestedBy: 'user', code: null, signal: 'SIGTERM', expected: true },
    outcome: { status: 'stopped', stoppedBy: 'user' }
  },
  {
    name: 'a stop at quit is Stopped by quit',
    input: { stopRequestedBy: 'quit', expected: true },
    outcome: { status: 'stopped', stoppedBy: 'quit' }
  },
  {
    name: 'Stopped wins over a reported done',
    input: { stopRequestedBy: 'user', reportedDone: true, sawResult: true },
    outcome: { status: 'stopped', stoppedBy: 'user' }
  },
  {
    name: 'a non-zero exit is Failed with the code and the last stderr line',
    input: { code: 1, stderrTail: 'warning\nfatal: boom\n' },
    outcome: { status: 'failed', reason: 'The worker exited with code 1. fatal: boom' }
  },
  {
    name: 'a signal we did not ask for is Failed',
    input: { code: null, signal: 'SIGKILL' },
    outcome: { status: 'failed', reason: 'The worker was killed by signal SIGKILL.' }
  },
  {
    name: 'exit 0 without report_done is Failed',
    input: {},
    outcome: { status: 'failed', reason: 'The worker exited without reporting that it was done.' }
  },
  {
    name: 'report_done without a finished turn is Failed',
    input: { reportedDone: true, sawResult: false },
    outcome: { status: 'failed', reason: 'The worker exited before it finished its last turn.' }
  },
  {
    name: 'a crash after report_done is still Failed',
    input: { reportedDone: true, sawResult: true, code: 2 },
    outcome: { status: 'failed', reason: 'The worker exited with code 2.' }
  }
]

describe('classifyWorkerExit', () => {
  it.each(table)('$name', ({ input, outcome }) => {
    expect(classifyWorkerExit({ ...base, ...input })).toEqual(outcome)
  })

  it('caps a very long reason', () => {
    const result = classifyWorkerExit({ ...base, code: 1, stderrTail: 'x'.repeat(2000) })
    expect(result.status === 'failed' && result.reason.length).toBeLessThanOrEqual(240)
  })
})
