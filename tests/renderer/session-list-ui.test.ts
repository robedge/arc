import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionRow from '../../src/renderer/src/lib/components/sessions/SessionRow.svelte'
import SessionsTab from '../../src/renderer/src/lib/components/sessions/SessionsTab.svelte'
import Conversation from '../../src/renderer/src/lib/components/sessions/Conversation.svelte'
import { sessionsList } from '../../src/renderer/src/lib/stores/sessions-list.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type {
  SessionListStatus,
  SessionMessage,
  SessionSummary
} from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const summary = (
  id: string,
  lastActiveAt: number,
  listStatus: SessionListStatus = 'idle'
): SessionSummary => ({
  id,
  groupId: 'g1',
  name: `Session ${id}`,
  lastActiveAt,
  status: listStatus === 'stopped' ? 'stopped' : 'active',
  listStatus,
  attentionCount: 0
})

const message = (id: number): SessionMessage => ({
  id,
  sessionId: 's1',
  role: 'user',
  content: `m${id}`,
  state: 'complete',
  planId: null,
  createdAt: id,
  updatedAt: id
})

beforeEach(() => {
  sessionsList.byGroup = {}
  activeSession.close()
  ui.selectedGroupId = 'g1'
  mockHarness(() => ({ ok: true, data: [] }))
})
afterEach(cleanup)

it.each([
  ['working', 'Working', 'text-accent'],
  ['needs-attention', 'Needs attention', 'text-attention'],
  ['idle', 'Idle', 'text-text-muted'],
  ['stopped', 'Stopped', 'text-text-faint']
] as const)('row shows the word and tone for %s', (status, word, tone) => {
  render(SessionRow, { session: summary('a', Date.now(), status), onopen: () => {} })
  const el = screen.getByText(word)
  expect(el.classList.contains(tone)).toBe(true)
})

it('row menu opens, moves with arrows, closes with Escape and returns focus to the trigger', async () => {
  render(SessionRow, { session: summary('a', 1), onopen: () => {} })
  const trigger = screen.getByRole('button', { name: 'Session options' })
  await fireEvent.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const rename = screen.getByRole('menuitem', { name: 'Rename' })
  const del = screen.getByRole('menuitem', { name: 'Delete Session' })
  await waitFor(() => expect(document.activeElement).toBe(rename))
  await fireEvent.keyDown(rename, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(del)
  await fireEvent.keyDown(del, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('choosing Rename parks focus on the trigger and calls onrename', async () => {
  const calls: string[] = []
  render(SessionRow, {
    session: summary('a', 1),
    onopen: () => {},
    onrename: (id: string) => calls.push(id)
  })
  const trigger = screen.getByRole('button', { name: 'Session options' })
  await fireEvent.click(trigger)
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  expect(calls).toEqual(['a'])
  expect(document.activeElement).toBe(trigger)
})

it('delete dialog states the consequences and confirm calls sessions:delete and removes the row', async () => {
  sessionsList.byGroup = { g1: [summary('a', 2), summary('b', 1)] }
  const invoke = mockHarness((channel) =>
    channel === 'sessions:delete'
      ? { ok: true, data: undefined }
      : { ok: true, data: sessionsList.for('g1') }
  )
  render(SessionsTab, { showBanner: false })
  await fireEvent.click(screen.getAllByRole('button', { name: 'Session options' })[0]!)
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Session' }))
  const text = screen.getByRole('dialog').textContent?.replace(/\s+/g, ' ') ?? ''
  expect(text).toContain('Its branches are kept in your repositories')
  expect(text).toContain('unmerged worker working copies will be removed')
  await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:delete', { sessionId: 'a' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(sessionsList.for('g1').some((s) => s.id === 'a')).toBe(false)
  expect(screen.queryByText('Session a')).toBeNull()
})

it('deleting the open session returns to the list', async () => {
  const { default: Dialog } =
    await import('../../src/renderer/src/lib/components/sessions/DeleteSessionDialog.svelte')
  sessionsList.byGroup = { g1: [summary('s1', 1)] }
  activeSession.sessionId = 's1'
  mockHarness(() => ({ ok: true, data: undefined }))
  render(Dialog, { session: { id: 's1', name: 'x' }, onclose: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(activeSession.sessionId).toBeNull())
})

it('Rename from the row calls sessions:rename and updates the row', async () => {
  sessionsList.byGroup = { g1: [summary('a', 1)] }
  const invoke = mockHarness((channel, req) =>
    channel === 'sessions:rename'
      ? { ok: true, data: { ...summary('a', 1), name: (req as { name: string }).name } }
      : { ok: true, data: sessionsList.for('g1') }
  )
  render(SessionsTab, { showBanner: false })
  await fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const input = screen.getByLabelText('Session name') as HTMLInputElement
  await fireEvent.input(input, { target: { value: 'Fresh name' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:rename', { sessionId: 'a', name: 'Fresh name' })
  )
  await waitFor(() => expect(sessionsList.for('g1')[0]!.name).toBe('Fresh name'))
})

it('a session:summary push upserts the row and re-sorts newest first', () => {
  sessionsList.byGroup = { g1: [summary('a', 30), summary('b', 20), summary('c', 10)] }
  sessionsList.applySummary({ groupId: 'g1', summary: summary('c', 40, 'working') })
  expect(sessionsList.for('g1').map((s) => s.id)).toEqual(['c', 'a', 'b'])
  expect(sessionsList.for('g1')[0]!.listStatus).toBe('working')
  sessionsList.applySummary({ groupId: 'g1', summary: summary('n', 25) })
  expect(sessionsList.for('g1').map((s) => s.id)).toEqual(['c', 'a', 'n', 'b'])
})

it('Load earlier appears for a full snapshot, pages with the smallest id and prepends', async () => {
  const first = Array.from({ length: 100 }, (_, i) => message(101 + i))
  const older = Array.from({ length: 5 }, (_, i) => message(96 + i))
  const invoke = mockHarness(() => ({ ok: true, data: older }))
  activeSession.setSnapshot({
    header: {
      id: 's1',
      groupId: 'g1',
      name: 'x',
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
    },
    messages: first,
    events: [],
    workers: [],
    plan: null,
    attention: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  })
  render(Conversation)
  await tick()
  await fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:page', {
      sessionId: 's1',
      kind: 'messages',
      beforeId: 101,
      limit: 100
    })
  )
  await waitFor(() => expect(activeSession.messages[0]!.id).toBe(96))
  expect(activeSession.messages).toHaveLength(105)
  expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
})
