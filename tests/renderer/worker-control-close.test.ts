import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { workerControl } from '../../src/renderer/src/lib/stores/worker-control.svelte'
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

function worker(status: WorkerStatus, extra: Partial<WorkerView> = {}): WorkerView {
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
    ...extra
  }
}

function load(w: WorkerView): void {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers: [w],
    attention: [],
    seq: 0
  })
}

const DETAILS = {
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
  unmergedCommits: 0
}

let invoke: ReturnType<typeof mockHarness>
let handBackResult: { ok: true; data: unknown } | { ok: false; error: { code: string } }

beforeEach(() => {
  handBackResult = { ok: true, data: { ok: true } }
  invoke = mockHarness((channel) => {
    if (channel === 'workers:open-terminal')
      return { ok: true, data: { backlog: 'x\n', seq: 1, truncated: false } }
    if (channel === 'workers:hand-back') return handBackResult as never
    if (channel === 'workers:get') return { ok: true, data: DETAILS } as never
    if (channel === 'commands:list') return { ok: true, data: [] }
    return { ok: true, data: { ok: true } }
  })
})

afterEach(() => {
  cleanup()
  workerTerminals.reset()
  workerControl.reset()
  activeSession.close()
})

async function openControlled(userControl: 'active' | 'paused' = 'active'): Promise<void> {
  load(worker('working', { userControl }))
  render(SessionScreen)
  workerTerminals.open('w1')
  await screen.findByRole('tab', { name: 'W1 · api-retry' })
}

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]')
const handBackCalls = (): number =>
  invoke.mock.calls.filter((c) => c[0] === 'workers:hand-back').length

it('closing a controlled tab asks with three buttons', async () => {
  await openControlled()
  await fireEvent.click(screen.getByRole('button', { name: 'Close W1 · api-retry' }))
  const d = dialog()
  expect(d?.querySelector('h2')?.textContent?.trim()).toBe('Hand W1 · api-retry back to the brain?')
  for (const name of ['Hand back', 'Keep it paused', 'Cancel'])
    expect(
      d?.querySelectorAll('button') &&
        [...d.querySelectorAll('button')].some((b) => b.textContent?.trim() === name)
    ).toBe(true)
  expect(workerTerminals.tabs).toEqual(['w1'])
})

it('a tab that is not controlled closes without asking', async () => {
  load(worker('working'))
  render(SessionScreen)
  workerTerminals.open('w1')
  await fireEvent.click(await screen.findByRole('button', { name: 'Close W1 · api-retry' }))
  expect(dialog()).toBeNull()
  expect(workerTerminals.tabs).toEqual([])
})

it('Hand back calls workers:hand-back and then closes the tab', async () => {
  await openControlled()
  await fireEvent.click(screen.getByRole('button', { name: 'Close W1 · api-retry' }))
  const d = dialog() as HTMLElement
  await fireEvent.click(
    [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Hand back')!
  )
  await waitFor(() => expect(workerTerminals.tabs).toEqual([]))
  expect(invoke).toHaveBeenCalledWith('workers:hand-back', { workerId: 'w1' })
  expect(dialog()).toBeNull()
})

it('Keep it paused closes the tab without any IPC call', async () => {
  await openControlled()
  await fireEvent.click(screen.getByRole('button', { name: 'Close W1 · api-retry' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Keep it paused' }))
  expect(workerTerminals.tabs).toEqual([])
  expect(handBackCalls()).toBe(0)
  expect(dialog()).toBeNull()
})

it('Cancel and Escape leave the tab open', async () => {
  await openControlled()
  await fireEvent.click(screen.getByRole('button', { name: 'Close W1 · api-retry' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(dialog()).toBeNull()
  expect(workerTerminals.tabs).toEqual(['w1'])

  await fireEvent.click(screen.getByRole('button', { name: 'Close W1 · api-retry' }))
  await fireEvent.keyDown(dialog() as HTMLElement, { key: 'Escape' })
  expect(dialog()).toBeNull()
  expect(workerTerminals.tabs).toEqual(['w1'])
  expect(handBackCalls()).toBe(0)
})

it('a failed hand-back shows the error and keeps the dialog open', async () => {
  handBackResult = { ok: false, error: { code: 'VALIDATION_FAILED' } }
  await openControlled()
  await fireEvent.click(screen.getByRole('button', { name: 'Close W1 · api-retry' }))
  const d = dialog() as HTMLElement
  await fireEvent.click(
    [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Hand back')!
  )
  await waitFor(() => expect(dialog()?.querySelector('[role="alert"]')).toBeTruthy())
  expect(workerTerminals.tabs).toEqual(['w1'])
})

it('the Delete key on a controlled tab opens the same dialog', async () => {
  await openControlled()
  await fireEvent.keyDown(screen.getByRole('tab', { name: 'W1 · api-retry' }), { key: 'Delete' })
  expect(dialog()?.querySelector('h2')?.textContent?.trim()).toBe(
    'Hand W1 · api-retry back to the brain?'
  )
  expect(workerTerminals.tabs).toEqual(['w1'])
})

it('a paused worker shows the paused label on the card and tab, with the input and Hand back', async () => {
  await openControlled('paused')
  const labels = [...document.querySelectorAll('[data-worker-control]')].map((e) =>
    e.textContent?.trim()
  )
  expect(labels.length).toBeGreaterThanOrEqual(2)
  for (const l of labels) expect(l).toBe("You're in control (paused)")
  expect(screen.getByRole('button', { name: 'Hand back' })).toBeTruthy()
  expect(document.querySelector('#worker-input-w1')).toBeTruthy()
})

it('Hand back is offered on a paused worker whatever its status', async () => {
  load(worker('stopped', { userControl: 'paused' }))
  render(SessionScreen)
  workerTerminals.open('w1')
  expect(await screen.findByRole('button', { name: 'Hand back' })).toBeTruthy()
})

it('Details offers Step in, which steps in, opens the tab and closes Details', async () => {
  let closed = false
  load(worker('working'))
  render(WorkerDetails, { worker: worker('working'), onclose: () => (closed = true) })
  await fireEvent.click(screen.getByRole('button', { name: 'Step in' }))
  await waitFor(() => expect(closed).toBe(true))
  expect(invoke).toHaveBeenCalledWith('workers:step-in', { workerId: 'w1' })
  expect(workerTerminals.tabs).toEqual(['w1'])
  expect(workerTerminals.active).toBe('w1')
})

it('Details hides Step in for finished and queued workers', () => {
  for (const status of ['done', 'merged', 'stopped', 'failed', 'queued'] as const) {
    const { unmount } = render(WorkerDetails, { worker: worker(status), onclose: () => {} })
    expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull()
    unmount()
  }
})

it('Details offers Hand back instead of Step in when controlled', async () => {
  render(WorkerDetails, {
    worker: worker('working', { userControl: 'active' }),
    onclose: () => {}
  })
  expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Hand back' }))
  await waitFor(() => expect(handBackCalls()).toBe(1))
})

it('a failed Step in from Details shows the error and keeps Details open', async () => {
  invoke = mockHarness((channel) =>
    channel === 'workers:step-in'
      ? { ok: false, error: { code: 'VALIDATION_FAILED' } }
      : ({ ok: true, data: channel === 'workers:get' ? DETAILS : { ok: true } } as never)
  )
  let closed = false
  render(WorkerDetails, { worker: worker('working'), onclose: () => (closed = true) })
  await fireEvent.click(screen.getByRole('button', { name: 'Step in' }))
  await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy())
  expect(closed).toBe(false)
})
