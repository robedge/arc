import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SuggestionsList from '../../src/renderer/src/lib/components/usage/SuggestionsList.svelte'
import UsagePanel from '../../src/renderer/src/lib/components/sessions/UsagePanel.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { usage } from '../../src/renderer/src/lib/stores/usage.svelte'
import type {
  SessionUsage,
  Suggestion,
  SuggestionKind,
  UsageReport
} from '../../src/shared/types/usage'
import { mockHarness } from './helpers'

const { openSession } = vi.hoisted(() => ({ openSession: vi.fn() }))
vi.mock('../../src/renderer/src/lib/navigate-session', () => ({ openSession }))

const KINDS: [SuggestionKind, string][] = [
  ['model-too-strong', 'Model too strong'],
  ['setup-overhead', 'Setup overhead'],
  ['repeated-work', 'Repeated work'],
  ['long-running', 'Long-running agent']
]

const sug = (id: string, kind: SuggestionKind, createdAt = 1): Suggestion => ({
  id,
  kind,
  sessionId: 's1',
  sessionName: 'Refactor',
  text: `text ${id}`,
  advice: `advice ${id}`,
  params: {},
  createdAt
})

const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }
const snap = (suggestions: Suggestion[]): SessionUsage => ({
  sessionId: 's1',
  total: totals,
  setupShare: null,
  arcSetupShare: null,
  byProvider: {},
  partial: false,
  agents: [],
  suggestions,
  updatedAt: 1
})

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  usage.reset()
  openSession.mockReset()
  invoke = mockHarness(() => ({ ok: true, data: undefined }))
})
afterEach(cleanup)

it('renders each kind label, text and advice', () => {
  render(SuggestionsList, {
    suggestions: KINDS.map(([k], i) => sug(`i${i}`, k)),
    ondismiss: () => {}
  })
  for (const [kind, label] of KINDS) {
    const item = document.querySelector(`[data-suggestion="${kind}"]`) as HTMLElement
    expect(item.textContent).toContain(label)
  }
  expect(screen.getByText('text i2')).toBeTruthy()
  expect(screen.getByText('Try: advice i2')).toBeTruthy()
  expect(document.querySelector('[data-suggestion-session]')).toBeNull()
  expect(screen.getByRole('list')).toBeTruthy()
})

it('the session link opens the session on the Usage page', async () => {
  render(SuggestionsList, {
    suggestions: [sug('a', 'repeated-work')],
    showSessionLink: true,
    ondismiss: () => {}
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Refactor' }))
  expect(openSession).toHaveBeenCalledWith('s1')
})

it('dismiss has a descriptive name and moves focus to the next item, then the heading', async () => {
  const list = [sug('a', 'repeated-work'), sug('b', 'long-running')]
  const { rerender } = render(SuggestionsList, {
    suggestions: list,
    ondismiss: (id: string) => void rerender({ suggestions: list.filter((s) => s.id !== id) })
  })
  const first = screen.getByRole('button', {
    name: 'Dismiss suggestion: Repeated work in Refactor'
  })
  await fireEvent.click(first)
  await waitFor(() =>
    expect(document.activeElement).toBe(
      document.querySelector('[data-suggestion="long-running"] [data-suggestion-dismiss]')
    )
  )
  await fireEvent.click(document.querySelector('[data-suggestion-dismiss]') as HTMLElement)
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Suggestions'))
})

it('store dismiss removes from the panel and the report and calls IPC', async () => {
  const s = sug('a', 'model-too-strong')
  usage.applySession(snap([s]))
  usage.report = { suggestions: [s] } as UsageReport
  render(UsagePanel, { id: 'p', snapshot: usage.bySession.s1 ?? null })
  await usage.dismissSuggestion('a')
  expect(invoke).toHaveBeenCalledWith('usage:dismiss-suggestion', { id: 'a' })
  expect(usage.bySession.s1?.suggestions).toEqual([])
  expect(usage.report?.suggestions).toEqual([])
})

it('store dismiss restores everywhere when the call fails', async () => {
  invoke = mockHarness(
    () =>
      ({
        ok: false,
        error: { code: 'internal', message: 'no' }
      }) as never
  )
  const s = sug('a', 'model-too-strong')
  usage.applySession(snap([s]))
  usage.report = { suggestions: [s] } as UsageReport
  await usage.dismissSuggestion('a')
  expect(usage.bySession.s1?.suggestions.map((x) => x.id)).toEqual(['a'])
  expect(usage.report?.suggestions.map((x) => x.id)).toEqual(['a'])
})

it('the Usage page lists suggestions newest first, or a muted line when none', async () => {
  const base = { range: '7d', totals: { total: totals }, plans: [], generatedAt: 1 }
  const withItems = {
    ...base,
    suggestions: [sug('old', 'repeated-work', 1), sug('new', 'long-running', 9)]
  }
  mockHarness(() => ({ ok: true, data: withItems }))
  const { default: UsageView } =
    await import('../../src/renderer/src/lib/components/usage/UsageView.svelte')
  render(UsageView)
  await waitFor(() => expect(document.querySelectorAll('[data-suggestion]').length).toBe(2))
  const order = [...document.querySelectorAll('[data-suggestion]')].map((e) =>
    e.getAttribute('data-suggestion')
  )
  expect(order).toEqual(['long-running', 'repeated-work'])
  cleanup()
  usage.reset()
  mockHarness(() => ({ ok: true, data: { ...base, suggestions: [] } }))
  render(UsageView)
  await waitFor(() => expect(screen.getByText('No suggestions in this period.')).toBeTruthy())
})

// ---- spec 009: the Setup overhead suggestion opens Agent loading ---------------------------------------------

const setup = (id: string, setupTokens: number, arcSetupTokens: number): Suggestion => ({
  ...sug(id, 'setup-overhead'),
  params: { setupTokens, arcSetupTokens }
})

it('offers "Choose what agents load" on a Setup overhead suggestion that is mostly the CLI’s', async () => {
  ui.closeSettings()
  render(SuggestionsList, { suggestions: [setup('a', 1000, 100)], ondismiss: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Choose what agents load' }))
  expect(ui.view).toBe('settings')
  expect(ui.settingsPage).toBe('agent-load')
  ui.closeSettings()
})

it('has no such button when Arc’s additions are 25% or more of the setup, or for another kind', () => {
  render(SuggestionsList, {
    suggestions: [
      setup('exact', 1000, 250),
      setup('arc', 1000, 900),
      sug('other', 'long-running'),
      sug('bare', 'setup-overhead')
    ],
    ondismiss: () => {}
  })
  expect(screen.queryByRole('button', { name: 'Choose what agents load' })).toBeNull()
})

it('keeps the line at 25% exactly: 249 of 1000 still gets the button', () => {
  render(SuggestionsList, { suggestions: [setup('edge', 1000, 249)], ondismiss: () => {} })
  expect(screen.getAllByRole('button', { name: 'Choose what agents load' })).toHaveLength(1)
})

it('shows the button in the session’s usage panel too', async () => {
  usage.applySession(snap([setup('p', 40_000, 1_000)]))
  render(UsagePanel, { id: 'p', snapshot: usage.bySession.s1 ?? null })
  expect(await screen.findByRole('button', { name: 'Choose what agents load' })).toBeTruthy()
})
