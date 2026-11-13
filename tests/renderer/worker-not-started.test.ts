// @spec: 013-session-branches-on-demand
// @regression
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import type { WorkerView } from '../../src/shared/types/session'

afterEach(cleanup)

it('a worker that was not started shows its reason on the card', () => {
  const worker: WorkerView = {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'web-fix',
    role: 'worker',
    task: 'Fix it.',
    projectIds: ['web'],
    model: 'sonnet',
    status: 'failed',
    activity: 'Failed',
    failureReason: 'Not started: you chose to leave web as it is',
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: false,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1
  }
  render(WorkerCard, { worker, onopen: () => {} })
  expect(screen.getByText('Not started: you chose to leave web as it is')).toBeTruthy()
})
