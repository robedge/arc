import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { commands } from '../../src/renderer/src/lib/stores/commands.svelte'
import { workerControl } from '../../src/renderer/src/lib/stores/worker-control.svelte'
import { workerTerminals } from '../../src/renderer/src/lib/stores/worker-terminals.svelte'
import type {
  AttentionView,
  SessionHeader as Header,
  SessionSnapshot,
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
    hasWorkingCopy: false,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function load(w: WorkerView): void {
  const snapshot: SessionSnapshot = {
    header,
    messages: [],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers: [w],
    attention: [],
    seq: 0
  }
  activeSession.setSnapshot(snapshot)
}

/** Main pushes the worker's new view; the test stands in for that push. */
function push(w: WorkerView): void {
  load(w)
}

let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  invoke = mockHarness((channel) => {
    if (channel === 'workers:open-terminal')
      return { ok: true, data: { backlog: 'first line\n', seq: 1, truncated: false } }
    if (channel === 'workers:interrupt') return { ok: true, data: { outcome: 'acked' } }
    if (channel === 'commands:list') return { ok: true, data: [] }
    return { ok: true, data: { ok: true } }
  })
})

afterEach(() => {
  cleanup()
  workerTerminals.reset()
  workerControl.reset()
  commands.reset()
  activeSession.close()
})

async function openTab(): Promise<void> {
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  await waitFor(() => expect(screen.getByText('first line')).toBeTruthy())
}

const sent = (channel: string): unknown[] =>
  invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

it.each<WorkerStatus>(['starting', 'working', 'needs_approval', 'has_question'])(
  'shows Step in for a %s worker',
  async (status) => {
    load(worker(status))
    await openTab()
    expect(screen.getByRole('button', { name: 'Step in' })).toBeTruthy()
  }
)

it.each<WorkerStatus>(['done', 'merged', 'failed', 'stopped', 'queued'])(
  'shows no Step in for a %s worker',
  async (status) => {
    load(worker(status))
    await openTab()
    expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull()
  }
)

it('Step in calls workers:step-in and moves focus to the input once control arrives', async () => {
  load(worker('working'))
  await openTab()
  await fireEvent.click(screen.getByRole('button', { name: 'Step in' }))
  await waitFor(() => expect(sent('workers:step-in')).toEqual([{ workerId: 'w1' }]))
  push(worker('working', { userControl: 'active' }))
  const input = await screen.findByLabelText('Message to W1 · api-retry')
  expect(input.id).toBe('worker-input-w1')
  await waitFor(() => expect(document.activeElement).toBe(input))
  expect(screen.getByRole('button', { name: 'Hand back' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull()
  expect(document.querySelector('[data-worker-control="active"]')?.textContent).toContain(
    "You're in control"
  )
})

async function controlled(extra: Partial<WorkerView> = {}): Promise<HTMLTextAreaElement> {
  load(worker('working', { userControl: 'active', ...extra }))
  await openTab()
  return (await screen.findByLabelText('Message to W1 · api-retry')) as HTMLTextAreaElement
}

it('Enter sends the line verbatim and clears the draft; Shift+Enter does not send', async () => {
  const input = await controlled()
  await fireEvent.input(input, { target: { value: 'use 5 retries' } })
  await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(sent('workers:send-input')).toEqual([])
  await fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(sent('workers:send-input')).toEqual([])
  await fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(sent('workers:send-input')).toEqual([{ workerId: 'w1', text: 'use 5 retries' }])
  )
  await waitFor(() => expect(input.value).toBe(''))
})

it('keeps the draft when the send fails and shows the error', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'workers:open-terminal')
      return { ok: true, data: { backlog: 'first line\n', seq: 1, truncated: false } }
    if (channel === 'workers:send-input') return { ok: false, error: { code: 'INTERNAL' } }
    return { ok: true, data: [] }
  })
  const input = await controlled()
  await fireEvent.input(input, { target: { value: 'hello' } })
  await fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(document.querySelector('[data-step-in-bar] [role="alert"]')).toBeTruthy()
  )
  expect(input.value).toBe('hello')
})

it('Escape interrupts only while the worker is replying', async () => {
  const idle = await controlled({ controlReplying: false })
  await fireEvent.keyDown(idle, { key: 'Escape' })
  expect(sent('workers:interrupt')).toEqual([])
  cleanup()
  workerTerminals.reset()
  const replying = await controlled({ controlReplying: true })
  await fireEvent.keyDown(replying, { key: 'Escape' })
  await waitFor(() => expect(sent('workers:interrupt')).toEqual([{ workerId: 'w1' }]))
})

it('Escape closes the slash menu first and does not interrupt', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'workers:open-terminal')
      return { ok: true, data: { backlog: 'first line\n', seq: 1, truncated: false } }
    if (channel === 'commands:list')
      return {
        ok: true,
        data: [{ name: 'review', description: 'Review code', source: 'user', argumentHint: '' }]
      }
    return { ok: true, data: [] }
  })
  const input = await controlled({ controlReplying: true })
  await fireEvent.input(input, { target: { value: '/re' } })
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
  await fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(sent('workers:interrupt')).toEqual([])
})

it('Hand back calls workers:hand-back and returns focus to Step in', async () => {
  const input = await controlled()
  expect(input).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Hand back' }))
  await waitFor(() => expect(sent('workers:hand-back')).toEqual([{ workerId: 'w1' }]))
  push(worker('working'))
  const stepIn = await screen.findByRole('button', { name: 'Step in' })
  await waitFor(() => expect(document.activeElement).toBe(stepIn))
  expect(screen.queryByLabelText('Message to W1 · api-retry')).toBeNull()
})

it('keeps a draft per worker across tab changes', async () => {
  const input = await controlled()
  await fireEvent.input(input, { target: { value: 'half typed' } })
  await fireEvent.click(screen.getByRole('tab', { name: 'Brain' }))
  await fireEvent.click(screen.getByRole('tab', { name: 'W1 · api-retry' }))
  const again = (await screen.findByLabelText('Message to W1 · api-retry')) as HTMLTextAreaElement
  expect(again.value).toBe('half typed')
})

it('a controlled card shows the control label, stays default-toned and opens its tab, not Needs attention', async () => {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers: [worker('needs_approval', { userControl: 'paused' })],
    attention: [
      {
        id: 'p1',
        route: 'queue',
        kind: 'permission',
        from: 'W1',
        workerId: 'w1',
        action: 'git push'
      }
    ],
    seq: 0
  })
  render(SessionScreen)
  const label = document.querySelector('[data-worker-control]')
  expect(label?.textContent).toBe("You're in control (paused)")
  expect(label?.getAttribute('data-worker-control')).toBe('paused')
  expect(document.querySelector('[data-worker-card]')?.getAttribute('data-tone')).toBe('default')
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  expect(activeSession.attentionDialog).toBeNull()
  expect(workerTerminals.tabs).toEqual(['w1'])
})

const terminalPerm: AttentionView = {
  id: 'tp1',
  route: 'terminal',
  kind: 'permission',
  from: 'W1 api-retry',
  workerId: 'w1',
  action: 'rm -rf build'
}
const terminalQuestion: AttentionView = {
  id: 'tq1',
  route: 'terminal',
  kind: 'question',
  from: 'W1 api-retry',
  workerId: 'w1',
  question: 'Which branch?'
}

function loadControlled(attention: AttentionView[]): void {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers: [worker('needs_approval', { userControl: 'active' })],
    attention,
    seq: 0
  })
}

it('pins terminal requests in a labelled group with no Always allow', async () => {
  loadControlled([terminalPerm, terminalQuestion])
  await openTab()
  const group = screen.getByRole('group', { name: 'Needs your answer' })
  expect(within(group).getByText('rm -rf build')).toBeTruthy()
  expect(within(group).getByText('Which branch?')).toBeTruthy()
  expect(within(group).queryByRole('button', { name: /Always allow/ })).toBeNull()
  expect(within(group).getByRole('button', { name: 'Approve' })).toBeTruthy()
})

it('answers a pinned request through attention:answer', async () => {
  loadControlled([terminalPerm, terminalQuestion])
  await openTab()
  const group = screen.getByRole('group', { name: 'Needs your answer' })
  await fireEvent.click(within(group).getByRole('button', { name: 'Approve' }))
  await fireEvent.input(within(group).getByRole('textbox'), { target: { value: 'main' } })
  await fireEvent.click(within(group).getByRole('button', { name: /Send/ }))
  await waitFor(() => {
    expect(sent('attention:answer')).toContainEqual({ requestId: 'tp1', approve: true })
    expect(sent('attention:answer')).toContainEqual({ requestId: 'tq1', text: 'main' })
  })
})

it('shows no group when nothing is waiting in the terminal', async () => {
  loadControlled([])
  await openTab()
  expect(screen.queryByRole('group', { name: 'Needs your answer' })).toBeNull()
})
