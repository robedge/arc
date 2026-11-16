import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import ConversationTabs from '../../src/renderer/src/lib/components/sessions/ConversationTabs.svelte'
import { permissionView, questionSurface } from './attention-fixtures'
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
import { mockArc } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  skipApprovals: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

const perm: AttentionView = permissionView({ id: 'p1', action: 'git push' })
const question: AttentionView = {
  id: 'q1',
  route: 'queue',
  kind: 'question',
  from: 'W2 docs · via brain',
  workerId: 'w2',
  question: 'Which branch?',
  surface: questionSurface('q1', 'Which branch?')
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
    knowledgeSuggestions: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  }
}

let invoke: ReturnType<typeof mockArc>
beforeEach(() => {
  invoke = mockArc(() => ({ ok: true, data: undefined }))
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
const renderConversation = (workers: WorkerView[] = []) =>
  render(ConversationTabs, { sessionId: 's1', workers })
const dock = () => document.querySelector('[data-attention-dock]')

it('the header has no Needs attention button; the dock heading shows the count and empties', async () => {
  activeSession.setSnapshot(snapshot([perm, question]))
  const { container: headerEl } = renderHeader()
  renderConversation()
  // The only "Needs attention" button is the fold button inside the dock heading.
  expect(within(headerEl).queryByRole('button', { name: /Needs attention/ })).toBeNull()
  expect(
    screen
      .getAllByRole('button', { name: /Needs attention/ })
      .every((b) => b.closest('[data-attention-heading]') !== null)
  ).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(
    within(screen.getByRole('region', { name: 'Needs attention' })).getByRole('heading', {
      name: 'Needs attention · 2'
    })
  ).toBeTruthy()
  activeSession.applyAttention({ sessionId: 's1', requests: [] })
  await waitFor(() => expect(dock()).toBeNull())
})

it('the dock shows a pushed request without a click and answers send attention:answer payloads', async () => {
  activeSession.setSnapshot(snapshot([]))
  renderConversation()
  expect(dock()).toBeNull()
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [perm, permissionView({ id: 'p2', action: 'ls' }), question]
  })
  const region = await screen.findByRole('region', { name: 'Needs attention' })
  const approves = within(region).getAllByRole('button', { name: 'Approve' })
  await fireEvent.click(approves[0]!)
  await fireEvent.click(within(region).getAllByRole('button', { name: 'Deny' })[1]!)
  await fireEvent.input(within(region).getByRole('textbox'), { target: { value: 'main' } })
  await fireEvent.click(within(region).getByRole('button', { name: /Send/ }))
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'p1', approve: true })
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'p2', approve: false })
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'q1', text: 'main' })
  })
})

it('session:attention for another session is ignored', () => {
  activeSession.setSnapshot(snapshot([perm]))
  activeSession.applyAttention({ sessionId: 'other', requests: [] })
  expect(activeSession.attention).toHaveLength(1)
})

it('a worker card in an attention state brings its request panel into view', async () => {
  activeSession.setSnapshot(
    snapshot([perm, question], [worker('w1', 1, 'needs_approval'), worker('w2', 2, 'has_question')])
  )
  render(AgentColumn, { brainState: 'idle', workers: activeSession.workers })
  renderConversation(activeSession.workers)
  await fireEvent.click(screen.getByText('W2 · task-2'))
  expect(activeSession.attentionFocus).toMatchObject({ requestId: 'q1' })
  expect(workerTerminals.active).toBe('brain')
  expect(
    document.querySelector('[data-attention-dock] article[aria-label*="W2 docs"]')
  ).toBeTruthy()
})

it('a worker card that is not in an attention state opens its terminal instead', async () => {
  mockArc(() => ({ ok: true, data: { backlog: '', seq: 0, truncated: false } }))
  activeSession.setSnapshot(snapshot([], [worker('w1', 1, 'working')]))
  render(AgentColumn, { brainState: 'idle', workers: activeSession.workers })
  await fireEvent.click(screen.getByText('W1 · task-1'))
  expect(activeSession.attentionFocus).toBeNull()
  expect(workerTerminals.tabs).toEqual(['w1'])
  workerTerminals.reset()
})

it('shows an amber dot for groups with pending requests and follows pushes', async () => {
  invoke = mockArc((channel) =>
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
  invoke = mockArc((channel) =>
    channel === 'sessions:attention-summary'
      ? { ok: true, data: { byGroup: { g1: 2, g2: 1 } } }
      : { ok: true, data: [] }
  )
  sessionsList.applyAttention({ sessionId: 'x', count: 1 })
  await waitFor(() =>
    expect(screen.getAllByRole('img', { name: 'Needs attention' })).toHaveLength(2)
  )

  // session:summary with a changed count also refetches
  invoke = mockArc(() => ({ ok: true, data: { byGroup: {} } }))
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
      attentionCount: 0,
      skipApprovals: false
    }
  })
  await waitFor(() =>
    expect(screen.queryAllByRole('img', { name: 'Needs attention' })).toHaveLength(0)
  )
})

it('navigateToAttention selects group, Sessions tab and session, then focuses the request', async () => {
  invoke = mockArc((channel) =>
    channel === 'sessions:open'
      ? { ok: true, data: snapshot([perm, question]) }
      : { ok: true, data: [] }
  )
  ui.selectedSectionId = 'some-section'
  await navigateToAttention({ sessionId: 's1', groupId: 'g1', requestId: 'q1' })
  expect(ui.selectedGroupId).toBe('g1')
  expect(ui.activeSectionId).toBe(SECTION_SESSIONS)
  expect(activeSession.sessionId).toBe('s1')
  expect(activeSession.attentionFocus).toMatchObject({ requestId: 'q1' })
})

it('navigateToAttention finds the group from loaded sessions when the payload has none', async () => {
  invoke = mockArc((channel) =>
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
        attentionCount: 1,
        skipApprovals: false
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
  expect(activeSession.attentionFocus).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith('sessions:open', expect.anything())
  expect(toasts.list).toHaveLength(1)
  expect(toasts.list[0]!.message).toMatch(/unsaved/i)
})

it('the dock leaves out terminal requests and those of controlled workers', () => {
  const controlled = { ...worker('w1', 1, 'needs_approval'), userControl: 'active' as const }
  const terminal: AttentionView = permissionView({ id: 'tp', route: 'terminal', workerId: 'w3' })
  const ofControlled: AttentionView = permissionView({ id: 'pc', workerId: 'w1' })
  activeSession.setSnapshot(
    snapshot([terminal, ofControlled, question], [controlled, worker('w2', 2, 'has_question')])
  )
  expect(activeSession.queueAttention.map((r) => r.id)).toEqual(['q1'])
  renderConversation()
  const region = screen.getByRole('region', { name: 'Needs attention' })
  expect(within(region).getByRole('heading', { name: 'Needs attention · 1' })).toBeTruthy()
  expect(within(region).queryByText('git push')).toBeNull()
  expect(within(region).getByText('Which branch?')).toBeTruthy()
})
