import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import AttentionDialog from '../../src/renderer/src/lib/components/ui/attention/AttentionDialog.svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import AgentColumn from '../../src/renderer/src/lib/components/sessions/AgentColumn.svelte'
import GroupSidebar from '../../src/renderer/src/lib/components/shell/GroupSidebar.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { workerTerminals } from '../../src/renderer/src/lib/stores/worker-terminals.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { leaveGuard } from '../../src/renderer/src/lib/stores/leave-guard.svelte'
import { sessionsList } from '../../src/renderer/src/lib/stores/sessions-list.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { SECTION_SESSIONS, ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { navigateToAttention } from '../../src/renderer/src/lib/navigate-attention'
import type {
  AttentionView,
  SessionHeader as Header,
  SessionSnapshot,
  WorkerView
} from '../../src/shared/types/session'
import type { AttentionRequest } from '../../src/renderer/src/lib/components/ui/attention/types'
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

const perm: AttentionView = {
  id: 'p1',
  route: 'queue',
  kind: 'permission',
  from: 'W1 api · via brain',
  workerId: 'w1',
  action: 'git push'
}
const question: AttentionView = {
  id: 'q1',
  route: 'queue',
  kind: 'question',
  from: 'W2 docs · via brain',
  workerId: 'w2',
  question: 'Which branch?'
}

function worker(id: string, number: number, status: WorkerView['status']): WorkerView {
  return {
    id,
    sessionId: 's1',
    number,
    slug: `task-${number}`,
    role: 'worker',
    task: 't',
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
    updatedAt: 1
  }
}

function snapshot(attention: AttentionView[], workers: WorkerView[] = []): SessionSnapshot {
  return {
    header,
    messages: [],
    events: [],
    workers,
    plan: null,
    attention,
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  }
}

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  invoke = mockHarness(() => ({ ok: true, data: undefined }))
  activeSession.close()
  sessionsList.byGroup = {}
  sessionsList.attentionByGroup = {}
  toasts.list = []
  groups.list = [
    { id: 'g1', name: 'Alpha', createdAt: 1, updatedAt: 1 },
    { id: 'g2', name: 'Beta', createdAt: 2, updatedAt: 2 }
  ]
  ui.closeDialog()
  ui.selectGroup(null)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderHeader = () => render(SessionHeader, { header, groupName: 'Alpha', onback: vi.fn() })

it('badge shows the count and is hidden at zero', async () => {
  activeSession.setSnapshot(snapshot([perm, question]))
  renderHeader()
  expect(screen.getByRole('button', { name: 'Needs attention, 2 waiting' })).toBeTruthy()
  activeSession.applyAttention({ sessionId: 's1', requests: [] })
  await waitFor(() => expect(screen.queryByRole('button', { name: /Needs attention/ })).toBeNull())
})

it('dialog approve, deny and answer send attention:answer payloads', async () => {
  activeSession.setSnapshot(snapshot([perm, { ...perm, id: 'p2' }, question]))
  renderHeader()
  await fireEvent.click(screen.getByRole('button', { name: /Needs attention, 3/ }))
  const dialog = screen.getByRole('dialog')
  const approves = within(dialog).getAllByRole('button', { name: 'Approve' })
  await fireEvent.click(approves[0]!)
  await fireEvent.click(within(dialog).getAllByRole('button', { name: 'Deny' })[1]!)
  await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: 'main' } })
  await fireEvent.click(within(dialog).getByRole('button', { name: /Send/ }))
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'p1', approve: true })
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'p2', approve: false })
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'q1', text: 'main' })
  })
})

it('dialog closes itself when the list empties', async () => {
  activeSession.setSnapshot(snapshot([perm]))
  renderHeader()
  await fireEvent.click(screen.getByRole('button', { name: /Needs attention/ }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  activeSession.applyAttention({ sessionId: 's1', requests: [] })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(activeSession.attentionDialog).toBeNull()
})

it('session:attention for another session is ignored', () => {
  activeSession.setSnapshot(snapshot([perm]))
  activeSession.applyAttention({ sessionId: 'other', requests: [] })
  expect(activeSession.attention).toHaveLength(1)
})

const dialogRequests: AttentionRequest[] = [
  { id: 'a', kind: 'permission', from: 'one', action: 'ls' },
  { id: 'b', kind: 'question', from: 'two', question: 'Q?' },
  { id: 'c', kind: 'permission', from: 'three', action: 'pwd' }
]
const order = () =>
  [...document.querySelectorAll('[data-attention-list] article')].map(
    (el) => el.getAttribute('aria-label') ?? ''
  )

it('initialRequestId puts that request first and keeps the rest in order', () => {
  render(AttentionDialog, {
    open: true,
    requests: dialogRequests,
    initialRequestId: 'c',
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onAlwaysAllow: vi.fn(),
    onAnswer: vi.fn(),
    onClose: vi.fn()
  })
  expect(order()[0]).toContain('three')
  expect(order()[1]).toContain('one')
  expect(order()[2]).toContain('two')
})

it('initialRequestId falls back to the default order when missing', () => {
  render(AttentionDialog, {
    open: true,
    requests: dialogRequests,
    initialRequestId: 'nope',
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onAlwaysAllow: vi.fn(),
    onAnswer: vi.fn(),
    onClose: vi.fn()
  })
  expect(order()[0]).toContain('one')
  expect(order()[2]).toContain('three')
})

it('a worker card in an attention state opens the dialog with its request first', async () => {
  activeSession.setSnapshot(
    snapshot([perm, question], [worker('w1', 1, 'needs_approval'), worker('w2', 2, 'has_question')])
  )
  render(AgentColumn, { brainState: 'idle', workers: activeSession.workers })
  render(SessionHeader, { header, groupName: 'Alpha', onback: vi.fn() })
  await fireEvent.click(screen.getByText('W2 · task-2'))
  expect(activeSession.attentionDialog).toEqual({ initialRequestId: 'q1' })
  await waitFor(() => expect(order()[0]).toContain('W2 docs'))
})

it('a worker card that is not in an attention state opens its terminal instead', async () => {
  mockHarness(() => ({ ok: true, data: { backlog: '', seq: 0, truncated: false } }))
  activeSession.setSnapshot(snapshot([], [worker('w1', 1, 'working')]))
  render(AgentColumn, { brainState: 'idle', workers: activeSession.workers })
  await fireEvent.click(screen.getByText('W1 · task-1'))
  expect(activeSession.attentionDialog).toBeNull()
  expect(workerTerminals.tabs).toEqual(['w1'])
  workerTerminals.reset()
})

it('shows an amber dot for groups with pending requests and follows pushes', async () => {
  invoke = mockHarness((channel) =>
    channel === 'sessions:attention-summary'
      ? { ok: true, data: { byGroup: { g1: 2 } } }
      : { ok: true, data: [] }
  )
  render(GroupSidebar)
  await sessionsList.loadAttention()
  await waitFor(() =>
    expect(screen.getAllByRole('img', { name: 'Needs attention' })).toHaveLength(1)
  )
  expect(
    within(screen.getByRole('button', { name: /^Alpha/ })).getByRole('img', {
      name: 'Needs attention'
    })
  ).toBeTruthy()

  // another session in group g2 raises a request: the summary is refetched
  invoke = mockHarness((channel) =>
    channel === 'sessions:attention-summary'
      ? { ok: true, data: { byGroup: { g1: 2, g2: 1 } } }
      : { ok: true, data: [] }
  )
  sessionsList.applyAttention({ sessionId: 'x', count: 1 })
  await waitFor(() =>
    expect(screen.getAllByRole('img', { name: 'Needs attention' })).toHaveLength(2)
  )

  // session:summary with a changed count also refetches
  invoke = mockHarness(() => ({ ok: true, data: { byGroup: {} } }))
  sessionsList.byGroup = { g2: [] }
  sessionsList.applySummary({
    groupId: 'g2',
    summary: {
      id: 'x',
      groupId: 'g2',
      name: 'n',
      lastActiveAt: 1,
      status: 'active',
      listStatus: 'idle',
      attentionCount: 0
    }
  })
  await waitFor(() =>
    expect(screen.queryAllByRole('img', { name: 'Needs attention' })).toHaveLength(0)
  )
})

it('navigateToAttention selects group, Sessions tab and session, then opens the dialog', async () => {
  invoke = mockHarness((channel) =>
    channel === 'sessions:open'
      ? { ok: true, data: snapshot([perm, question]) }
      : { ok: true, data: [] }
  )
  ui.selectedSectionId = 'some-section'
  await navigateToAttention({ sessionId: 's1', groupId: 'g1', requestId: 'q1' })
  expect(ui.selectedGroupId).toBe('g1')
  expect(ui.activeSectionId).toBe(SECTION_SESSIONS)
  expect(activeSession.sessionId).toBe('s1')
  expect(activeSession.attentionDialog).toEqual({ initialRequestId: 'q1' })
})

it('navigateToAttention finds the group from loaded sessions when the payload has none', async () => {
  invoke = mockHarness((channel) =>
    channel === 'sessions:open' ? { ok: true, data: snapshot([perm]) } : { ok: true, data: [] }
  )
  sessionsList.byGroup = {
    g2: [
      {
        id: 's1',
        groupId: 'g2',
        name: 'n',
        lastActiveAt: 1,
        status: 'active',
        listStatus: 'needs-attention',
        attentionCount: 1
      }
    ]
  }
  await navigateToAttention({ sessionId: 's1' })
  expect(ui.selectedGroupId).toBe('g2')
})

it('navigateToAttention toasts and does nothing else when the leave guard refuses', async () => {
  ui.selectGroup('g2')
  invoke.mockClear()
  vi.spyOn(leaveGuard, 'proceed').mockResolvedValue(false)
  await navigateToAttention({ sessionId: 's1', groupId: 'g1', requestId: 'p1' })
  expect(ui.selectedGroupId).toBe('g2')
  expect(activeSession.sessionId).toBeNull()
  expect(activeSession.attentionDialog).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith('sessions:open', expect.anything())
  expect(toasts.list).toHaveLength(1)
  expect(toasts.list[0]!.message).toMatch(/unsaved/i)
})

it('the dialog and badge leave out terminal requests and those of controlled workers', async () => {
  const controlled = { ...worker('w1', 1, 'needs_approval'), userControl: 'active' as const }
  const terminal: AttentionView = { ...perm, id: 'tp', route: 'terminal', workerId: 'w3' }
  const ofControlled: AttentionView = { ...perm, id: 'pc', workerId: 'w1' }
  activeSession.setSnapshot(
    snapshot([terminal, ofControlled, question], [controlled, worker('w2', 2, 'has_question')])
  )
  expect(activeSession.queueAttention.map((r) => r.id)).toEqual(['q1'])
  renderHeader()
  expect(screen.getByRole('button', { name: 'Needs attention, 1 waiting' })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: /Needs attention, 1/ }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).queryByText('git push')).toBeNull()
  expect(within(dialog).getByText('Which branch?')).toBeTruthy()
})
