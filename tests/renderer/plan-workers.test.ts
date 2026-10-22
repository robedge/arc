import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import PlanCard from '../../src/renderer/src/lib/components/sessions/PlanCard.svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import { WORKER_STATUS } from '../../src/renderer/src/lib/components/sessions/worker-status'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type {
  PlanStatus,
  PlanView,
  SessionHeader as Header,
  WorkerStatus,
  WorkerView
} from '../../src/shared/types/session'
import { mockHarness } from './helpers'

function plan(status: PlanStatus = 'proposed', over: Partial<PlanView> = {}): PlanView {
  return {
    id: 'p1',
    sessionId: 's1',
    status,
    workers: [
      { name: 'api-retry', task: 'Add retry.', repos: ['api'], model: 'opus', rationale: '' },
      { name: 'web-status', task: 'Show status.', repos: ['web'], model: 'haiku', rationale: '' }
    ],
    messageId: 1,
    replacedById: null,
    changesRequested: false,
    createdAt: 1,
    resolvedAt: null,
    ...over
  }
}

function worker(status: WorkerStatus = 'working', over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: ['api'],
    model: 'sonnet',
    status,
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: false,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

const header: Header = {
  id: 's1',
  groupId: 'g',
  name: 'S',
  mode: 'plan_first',
  workerLimit: 3,
  model: 'auto',
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  invoke = mockHarness(() => ({ ok: true, data: undefined }))
  activeSession.close()
})
afterEach(cleanup)

it('Approve sends the edited models', async () => {
  render(PlanCard, { plan: plan(), workerModel: 'auto' })
  await fireEvent.change(screen.getByLabelText('Model for web-status'), {
    target: { value: 'sonnet' }
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:plan-decision', {
      sessionId: 's1',
      planId: 'p1',
      decision: 'approve',
      models: {
        'api-retry': { provider: 'claude', model: 'opus' },
        'web-status': { provider: 'claude', model: 'sonnet' }
      }
    })
  )
})

it('shows the forced worker model and disables the selects', () => {
  render(PlanCard, { plan: plan(), workerModel: 'haiku' })
  const select = screen.getByLabelText('Model for api-retry') as HTMLSelectElement
  expect(select.value).toBe('haiku')
  expect(select.disabled).toBe(true)
})

it('Ask for changes focuses the composer and the card waits', async () => {
  activeSession.sessionId = 's1'
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  const view = render(PlanCard, { plan: plan(), workerModel: 'auto' })
  await fireEvent.click(screen.getByRole('button', { name: 'Ask for changes' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByLabelText('Message to the brain'))
  )
  expect(invoke).toHaveBeenCalledWith(
    'sessions:plan-decision',
    expect.objectContaining({ decision: 'ask-changes' })
  )
  view.unmount()
  render(PlanCard, { plan: plan('proposed', { changesRequested: true }), workerModel: 'auto' })
  expect(screen.getByText('Waiting for your changes')).toBeTruthy()
})

it.each([
  ['replaced', 'Replaced'],
  ['rejected', 'Rejected'],
  ['approved', 'Approved']
] as const)('a %s plan shows its tag and disables the buttons', (status, tag) => {
  render(PlanCard, { plan: plan(status), workerModel: 'auto' })
  expect(screen.getByText(tag)).toBeTruthy()
  for (const name of ['Approve', 'Ask for changes', 'Reject']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  }
})

it('a worker card shows the status word for all nine statuses', () => {
  const all = Object.keys(WORKER_STATUS) as WorkerStatus[]
  expect(all).toHaveLength(9)
  for (const status of all) {
    const { unmount } = render(WorkerCard, { worker: worker(status), onopen: () => {} })
    expect(screen.getByText('W1 · api-retry')).toBeTruthy()
    expect(document.querySelector('[data-worker-status]')?.textContent).toBe(
      WORKER_STATUS[status].label
    )
    unmount()
  }
})

it('WorkerDetails asks to confirm before calling workers:stop', async () => {
  invoke = mockHarness((channel) =>
    channel === 'workers:get'
      ? {
          ok: true,
          data: {
            id: 'w1',
            sessionId: 's1',
            number: 1,
            name: 'W1 · api-retry',
            status: 'working',
            model: 'sonnet',
            task: 'Add retry.',
            activity: null,
            lastReport: 'Nearly there.',
            failureReason: null,
            stoppedBy: null,
            changedFiles: ['src/a.ts'],
            worktreePaths: [{ projectName: 'api', path: '/wt/api' }],
            projects: ['api']
          }
        }
      : { ok: true, data: undefined }
  )
  let closed = false
  render(WorkerDetails, { worker: worker('working'), onclose: () => (closed = true) })
  await waitFor(() => expect(screen.getByText('src/a.ts')).toBeTruthy())
  expect(screen.getByText('/wt/api')).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(invoke).not.toHaveBeenCalledWith('workers:stop', expect.anything())
  expect(document.querySelector('[data-stop-confirm]')?.textContent).toContain(
    'Stop W1 · api-retry?'
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Stop worker' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('workers:stop', { workerId: 'w1' }))
  await waitFor(() => expect(closed).toBe(true))
})

it('the header menus call set-config with the right field', async () => {
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  await fireEvent.click(
    within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Opus' })
  )
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    brainModel: { provider: 'claude', model: 'opus' }
  })
  expect(screen.getByRole('button', { name: 'Brain model' }).textContent).toContain(
    'Brain · Sonnet'
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Worker model' }))
  expect(screen.getByRole('button', { name: 'Worker model' }).textContent).toContain(
    'Workers · Auto'
  )
  await fireEvent.click(
    within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Haiku' })
  )
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    workers: { mode: 'model', model: { provider: 'claude', model: 'haiku' } }
  })
})

it('the mode and limit menu sends mode and workerLimit, with keyboard and focus return', async () => {
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  const button = screen.getByRole('button', { name: 'Mode and worker limit' })
  await fireEvent.click(button)
  await fireEvent.click(
    within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Limit 5' })
  )
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', { sessionId: 's1', workerLimit: 5 })
  expect(document.activeElement).toBe(button)
  await fireEvent.click(button)
  await fireEvent.click(
    within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Autonomous' })
  )
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    mode: 'autonomous'
  })
  await fireEvent.click(button)
  await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(button)
})

it('a queued worker card says Queued in the faint tone', () => {
  render(WorkerCard, { worker: worker('queued'), onopen: () => {} })
  const word = document.querySelector('[data-worker-status]')
  expect(word?.textContent).toBe('Queued')
  expect(word?.className).toContain('text-text-faint')
})

it('details of a queued worker show its task and allow Stop', async () => {
  render(WorkerDetails, { worker: worker('queued'), onclose: () => {} })
  expect(document.querySelector('[data-worker-details]')?.textContent).toContain('Queued')
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
})

it('reducers apply plan and worker events, guarded by seq', () => {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 10
  })
  activeSession.applyPlan({ sessionId: 's1', seq: 11, plan: plan() })
  activeSession.applyPlan({ sessionId: 's1', seq: 5, plan: plan('rejected') })
  expect(activeSession.plans.p1?.status).toBe('proposed')
  activeSession.applyWorker({ sessionId: 's1', seq: 12, worker: worker('starting') })
  activeSession.applyWorker({ sessionId: 's1', seq: 13, worker: worker('working') })
  activeSession.applyWorker({ sessionId: 'other', seq: 14, worker: worker('done', { id: 'x' }) })
  expect(activeSession.workers).toHaveLength(1)
  expect(activeSession.workers[0]?.status).toBe('working')
})

it('a worker card labels a command worker with the command name and keeps the args in the title', () => {
  render(WorkerCard, {
    worker: worker('working', { command: '/awos:spec retry settings' }),
    onopen: () => {}
  })
  const title = document.querySelector('[data-worker-title]') as HTMLElement
  expect(title.textContent).toBe('W1 · /awos:spec')
  expect(title.getAttribute('title')).toBe('W1 · /awos:spec retry settings')
  expect(title.className).toContain('font-mono')
})

it('a worker card without a command keeps the slug label and no title tooltip', () => {
  render(WorkerCard, { worker: worker('working'), onopen: () => {} })
  const title = document.querySelector('[data-worker-title]') as HTMLElement
  expect(title.textContent).toBe('W1 · api-retry')
  expect(title.hasAttribute('title')).toBe(false)
})

it('WorkerDetails shows the full command text with its arguments', () => {
  render(WorkerDetails, {
    worker: worker('working', { command: '/awos:spec retry settings' }),
    onclose: () => {},
    preset: {
      id: 'w1',
      sessionId: 's1',
      number: 1,
      role: 'worker',
      name: 'W1 · /awos:spec',
      status: 'working',
      model: 'sonnet',
      task: 'x',
      activity: null,
      lastReport: null,
      failureReason: null,
      stoppedBy: null,
      changedFiles: [],
      worktreePaths: [],
      projects: ['api'],
      hasWorkingCopy: false,
      unmergedCommits: 0
    }
  })
  expect(document.querySelector('[data-worker-command]')?.textContent?.trim()).toBe(
    '/awos:spec retry settings'
  )
})

it('a plan entry shows a command chip before the task text', () => {
  const p = plan('proposed')
  p.workers[0] = { ...p.workers[0]!, command: '/awos:spec retry settings' }
  render(PlanCard, { plan: p, workerModel: 'auto' })
  const chips = document.querySelectorAll('[data-plan-command]')
  expect(chips).toHaveLength(1)
  expect(chips[0]!.textContent).toBe('/awos:spec')
  expect(chips[0]!.parentElement?.textContent).toBe('/awos:specAdd retry.')
})
