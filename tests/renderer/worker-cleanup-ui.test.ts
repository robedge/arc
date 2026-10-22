import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { workerTerminals } from '../../src/renderer/src/lib/stores/worker-terminals.svelte'
import type {
  SessionHeader as Header,
  WorkerStatus,
  WorkerView
} from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

function worker(status: WorkerStatus, over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: [],
    model: 'sonnet',
    status,
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

let unmerged = 0
let removeResult: { ok: true; data: undefined } | { ok: false; error: { code: string } }
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  unmerged = 0
  removeResult = { ok: true, data: undefined }
  invoke = mockHarness((channel) => {
    if (channel === 'workers:get')
      return {
        ok: true,
        data: {
          id: 'w1',
          sessionId: 's1',
          number: 1,
          role: 'worker',
          name: 'W1 · api-retry',
          status: 'working',
          model: 'sonnet',
          task: 'Add retry.',
          activity: null,
          failureReason: null,
          stoppedBy: null,
          lastReport: null,
          changedFiles: [],
          worktreePaths: [],
          projects: [],
          hasWorkingCopy: true,
          unmergedCommits: unmerged
        }
      }
    if (channel === 'workers:open-terminal')
      return { ok: true, data: { backlog: 'x\n', seq: 1, truncated: false } }
    if (channel === 'workers:remove') return removeResult as never
    return { ok: true, data: undefined }
  })
})

afterEach(() => {
  cleanup()
  workerTerminals.reset()
  activeSession.close()
})

function load(workers: WorkerView[]): void {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers,
    attention: [],
    seq: 0
  })
}

const stopText = (): string => document.querySelector('[data-stop-confirm]')?.textContent ?? ''
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

it('the Stop confirmation says the working copy will be removed', async () => {
  render(WorkerDetails, { worker: worker('working'), onclose: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(flat(stopText())).toBe('Stop W1 · api-retry? Its working copy will be removed.')
  expect(document.querySelector('[data-unmerged-warning]')).toBeNull()
})

it('the Stop confirmation reads fresh unmerged commits and warns in danger styling', async () => {
  unmerged = 3
  render(WorkerDetails, { worker: worker('working'), onclose: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(document.querySelector('[data-unmerged-warning]')).toBeTruthy())
  expect(flat(stopText())).toBe(
    'Stop W1 · api-retry? Its working copy will be removed. Its 3 unmerged commits will be discarded.'
  )
  expect(document.querySelector('[data-unmerged-warning] [role="alert"]')?.className).toContain(
    'text-danger'
  )
})

it('Remove shows only for finished workers', () => {
  for (const status of ['done', 'merged', 'failed', 'stopped'] as const) {
    const { unmount } = render(WorkerDetails, { worker: worker(status), onclose: () => {} })
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    unmount()
  }
  for (const status of [
    'queued',
    'starting',
    'working',
    'needs_approval',
    'has_question'
  ] as const) {
    const { unmount } = render(WorkerDetails, { worker: worker(status), onclose: () => {} })
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    unmount()
  }
})

it('Remove of a Done worker with unmerged commits asks first', async () => {
  unmerged = 2
  render(WorkerDetails, { worker: worker('done'), onclose: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(document.querySelector('[data-remove-confirm]')).toBeTruthy())
  expect(flat(document.querySelector('[data-remove-confirm]')?.textContent ?? '')).toBe(
    'Remove W1 · api-retry? Its 2 unmerged commits will be discarded.'
  )
  expect(invoke).not.toHaveBeenCalledWith('workers:remove', expect.anything())
  await fireEvent.click(screen.getByRole('button', { name: 'Remove worker' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('workers:remove', { workerId: 'w1' }))
})

it('Remove of a stopped worker needs no confirmation', async () => {
  render(WorkerDetails, { worker: worker('stopped'), onclose: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('workers:remove', { workerId: 'w1' }))
})

it('a successful Remove drops the worker, closes its tab and its details', async () => {
  load([worker('done'), worker('done', { id: 'w2', number: 2, slug: 'web-status' })])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  expect(workerTerminals.tabs).toEqual(['w1'])
  await fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  await waitFor(() => expect(document.querySelector('[data-worker-details]')).toBeTruthy())
  await fireEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1) as HTMLElement)
  await waitFor(() => expect(activeSession.workers.map((w) => w.id)).toEqual(['w2']))
  expect(workerTerminals.tabs).toEqual([])
  expect(document.querySelector('[data-worker-details]')).toBeNull()
  expect(screen.queryByText('W1 · api-retry', { selector: '[data-worker-title]' })).toBeNull()
})

it('the terminal tab header has a Remove button for a finished worker', async () => {
  load([worker('stopped')])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  await fireEvent.click(
    within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Remove' })
  )
  await waitFor(() => expect(activeSession.workers).toHaveLength(0))
  expect(workerTerminals.tabs).toEqual([])
})

it('VALIDATION_FAILED shows Stop the worker first and keeps the worker', async () => {
  removeResult = { ok: false, error: { code: 'VALIDATION_FAILED' } }
  load([worker('stopped')])
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Details for W1 · api-retry' }))
  await waitFor(() => expect(document.querySelector('[data-worker-details]')).toBeTruthy())
  await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(await screen.findByText('Stop the worker first.')).toBeTruthy()
  expect(activeSession.workers).toHaveLength(1)
})
