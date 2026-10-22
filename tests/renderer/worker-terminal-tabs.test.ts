import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import TerminalPanel from '../../src/renderer/src/lib/components/sessions/TerminalPanel.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import {
  TerminalBuffer,
  workerTerminals
} from '../../src/renderer/src/lib/stores/worker-terminals.svelte'
import type {
  AttentionView,
  SessionHeader as Header,
  SessionSnapshot,
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

function worker(id: string, number: number, status: WorkerView['status'] = 'working'): WorkerView {
  return {
    id,
    sessionId: 's1',
    number,
    slug: number === 1 ? 'api-retry' : 'web-status',
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
    updatedAt: 1
  }
}

function load(workers: WorkerView[], attention: AttentionView[] = []): void {
  const snapshot: SessionSnapshot = {
    header,
    messages: [],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers,
    attention,
    seq: 0
  }
  activeSession.setSnapshot(snapshot)
}

let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  invoke = mockHarness((channel) => {
    if (channel === 'workers:open-terminal')
      return { ok: true, data: { backlog: 'first line\nsecond line\n', seq: 3, truncated: false } }
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
          failureReason: null,
          lastReport: null,
          changedFiles: [],
          worktreePaths: []
        }
      }
    return { ok: true, data: [] }
  })
})

afterEach(() => {
  cleanup()
  workerTerminals.reset()
  activeSession.close()
})

const calls = (channel: string): number => invoke.mock.calls.filter((c) => c[0] === channel).length

it('clicking a worker card opens its tab next to Brain and focuses it', async () => {
  load([worker('w1', 1), worker('w2', 2)])
  render(SessionScreen)
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Brain'])
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Brain', 'W1 · api-retry'])
  expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
  expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
  await waitFor(() => expect(screen.getByText('second line')).toBeTruthy())
  expect(screen.getByRole('log', { name: 'W1 · api-retry output' })).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('a second click switches to the existing tab without a duplicate', async () => {
  load([worker('w1', 1), worker('w2', 2)])
  render(SessionScreen)
  const card = (n: string): HTMLElement =>
    screen.getByText(n, { selector: '[data-worker-title]' }) as HTMLElement
  await fireEvent.click(card('W1 · api-retry'))
  await fireEvent.click(card('W2 · web-status'))
  expect(screen.getAllByRole('tab')).toHaveLength(3)
  await fireEvent.click(card('W1 · api-retry'))
  expect(screen.getAllByRole('tab')).toHaveLength(3)
  expect(workerTerminals.active).toBe('w1')
  expect(calls('workers:open-terminal')).toBe(2)
})

it('closing the active tab returns to Brain and keeps the other tab', async () => {
  load([worker('w1', 1), worker('w2', 2)])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  await fireEvent.click(screen.getByText('W2 · web-status', { selector: '[data-worker-title]' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Close W2 · web-status' }))
  expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual([
    'Brain',
    'W1 · api-retry'
  ])
  expect(screen.getByRole('tab', { name: 'Brain' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy()
})

it('Brain shows the conversation and composer; a worker tab hides the composer', async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy()
  expect(screen.getByRole('combobox')).toBeTruthy()
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('log', { name: 'Conversation' })).toBeNull()
  await fireEvent.click(screen.getByRole('tab', { name: 'Brain' }))
  expect(screen.getByRole('combobox')).toBeTruthy()
})

it('arrow keys move between tabs and Delete closes a worker tab', async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  const worker1 = screen.getByRole('tab', { name: 'W1 · api-retry' })
  await fireEvent.keyDown(worker1, { key: 'ArrowLeft' })
  expect(workerTerminals.active).toBe('brain')
  await fireEvent.keyDown(screen.getByRole('tab', { name: 'Brain' }), { key: 'ArrowRight' })
  expect(workerTerminals.active).toBe('w1')
  await fireEvent.keyDown(screen.getByRole('tab', { name: 'W1 · api-retry' }), { key: 'Delete' })
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(workerTerminals.active).toBe('brain')
})

it('the tab header shows name, status and model, and its Details button opens details', async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  const panel = screen.getByRole('tabpanel')
  expect(panel.textContent).toContain('Working')
  expect(panel.textContent).toContain('sonnet')
  await fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  await waitFor(() => expect(document.querySelector('[data-worker-details]')).toBeTruthy())
})

it('the tab header offers Step in before Details, and Hand back with a control chip once controlled', async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  const buttons = within(screen.getByRole('tabpanel'))
    .getAllByRole('button')
    .map((b) => b.textContent?.trim())
  expect(buttons.indexOf('Step in')).toBeGreaterThan(-1)
  expect(buttons.indexOf('Step in')).toBe(buttons.indexOf('Details') - 1)
  load([{ ...worker('w1', 1, 'done'), userControl: 'active' }])
  const handBack = await screen.findByRole('button', { name: 'Hand back' })
  expect(handBack.getAttribute('data-variant')).toBe('primary')
  expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull()
  expect(screen.getByRole('tabpanel').querySelector('[data-worker-control]')?.textContent).toBe(
    "You're in control"
  )
  expect(document.querySelector('[data-terminal]')?.parentElement?.lastElementChild).toBe(
    document.querySelector('[data-step-in-bar]')
  )
})

it('a card Details button opens details without opening a tab', async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Details for W1 · api-retry' }))
  await waitFor(() => expect(document.querySelector('[data-worker-details]')).toBeTruthy())
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(calls('workers:open-terminal')).toBe(0)
})

it('an amber card opens Needs attention instead of a tab', async () => {
  load(
    [worker('w1', 1, 'needs_approval')],
    [
      {
        id: 'p1',
        route: 'queue',
        kind: 'permission',
        from: 'W1',
        workerId: 'w1',
        action: 'git push'
      }
    ]
  )
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  expect(activeSession.attentionDialog).toEqual({ initialRequestId: 'p1' })
  expect(screen.getAllByRole('tab')).toHaveLength(1)
})

it('tabs reset when the session changes', async () => {
  load([worker('w1', 1)])
  const view = render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  expect(workerTerminals.tabs).toEqual(['w1'])
  activeSession.close()
  await view.rerender({})
  await waitFor(() => expect(workerTerminals.tabs).toEqual([]))
})

// ---- TerminalPanel ----

function bufferOf(count: number): TerminalBuffer {
  const buffer = new TerminalBuffer()
  buffer.ready = true
  buffer.append(Array.from({ length: count }, (_, i) => `line ${i}`).join('\n'))
  return buffer
}

/** jsdom has no layout: give the scroller one. */
function fakeLayout(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => (top = v)
  })
}

it('TerminalPanel renders only a window of a long log', async () => {
  const buffer = bufferOf(5000)
  render(TerminalPanel, { buffer, label: 'T output' })
  const log = screen.getByRole('log')
  expect(log.getAttribute('aria-live')).toBe('off')
  expect(log.querySelectorAll('[data-terminal-line]').length).toBeLessThan(120)
  await new Promise((r) => setTimeout(r, 0)) // let the initial follow-the-tail settle
  fakeLayout(log, 90_000, 400)
  log.scrollTop = 9000
  await fireEvent.scroll(log)
  const texts = [...log.querySelectorAll('[data-terminal-line]')].map((l) => l.textContent?.trim())
  expect(texts.length).toBeLessThan(120)
  expect(texts).toContain('line 500')
  expect(texts).not.toContain('line 0')
})

it('TerminalPanel follows the tail while stuck and offers Jump to latest when not', async () => {
  const buffer = bufferOf(100)
  render(TerminalPanel, { buffer, label: 'T output' })
  const log = screen.getByRole('log')
  fakeLayout(log, 1800, 400)
  buffer.append('\nmore')
  await waitFor(() => expect(log.scrollTop).toBe(1800))
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()

  log.scrollTop = 0
  await fireEvent.scroll(log)
  const jump = await screen.findByRole('button', { name: 'Jump to latest' })
  buffer.append('\nand more')
  await Promise.resolve()
  expect(log.scrollTop).toBe(0)
  await fireEvent.click(jump)
  expect(log.scrollTop).toBe(1800)
})

it('TerminalPanel notes trimmed history and ignores typing', async () => {
  const buffer = bufferOf(3)
  buffer.truncated = true
  render(TerminalPanel, { buffer, label: 'T output' })
  expect(screen.getByText('Earlier output trimmed')).toBeTruthy()
  const log = screen.getByRole('log')
  const before = invoke.mock.calls.length
  await fireEvent.keyDown(log, { key: 'a' })
  await fireEvent.keyPress(log, { key: 'a' })
  await fireEvent.keyDown(log, { key: 'Enter' })
  await fireEvent.paste(log)
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(invoke.mock.calls.length).toBe(before)
  expect(buffer.lines).toEqual(['line 0', 'line 1', 'line 2'])
})

it('drops chunks at or below the backlog seq and appends newer ones', async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  await waitFor(() => expect(screen.getByText('second line')).toBeTruthy())
  workerTerminals.apply({ workerId: 'w1', seq: 3, text: 'stale chunk\n' })
  workerTerminals.apply({ workerId: 'w1', seq: 4, text: 'fresh chunk\n' })
  await waitFor(() => expect(screen.getByText('fresh chunk')).toBeTruthy())
  expect(screen.queryByText('stale chunk')).toBeNull()
})

it("keeps a tab's output while another tab is shown", async () => {
  load([worker('w1', 1)])
  render(SessionScreen)
  await fireEvent.click(screen.getByText('W1 · api-retry', { selector: '[data-worker-title]' }))
  await fireEvent.click(screen.getByRole('tab', { name: 'Brain' }))
  workerTerminals.apply({ workerId: 'w1', seq: 4, text: 'while away\n' })
  workerTerminals.flush()
  await fireEvent.click(screen.getByRole('tab', { name: 'W1 · api-retry' }))
  await waitFor(() => expect(screen.getByText('while away')).toBeTruthy())
  expect(calls('workers:open-terminal')).toBe(1)
})
