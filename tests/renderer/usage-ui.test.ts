import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import TokenCount from '../../src/renderer/src/lib/components/ui/TokenCount.svelte'
import UsageChip from '../../src/renderer/src/lib/components/sessions/UsageChip.svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import { usage } from '../../src/renderer/src/lib/stores/usage.svelte'
import type { AgentUsage, SessionUsage, TokenTotals } from '../../src/shared/types/usage'
import type { WorkerDetails as WorkerDetailsData, WorkerView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const totals = (total: number): TokenTotals => ({
  input: total,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  total
})
const snap = (total: number, updatedAt = 1): SessionUsage => ({
  sessionId: 's1',
  total: totals(total),
  setupShare: null,
  arcSetupShare: null,
  byProvider: {},
  partial: false,
  agents: [],
  suggestions: [],
  updatedAt
})

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  usage.reset()
  invoke = mockHarness(() => ({ ok: true, data: snap(1_200_000) }))
})
afterEach(cleanup)

it('TokenCount shows the short form with the exact count in title and aria-label', () => {
  render(TokenCount, { value: 12_412, suffix: 'tokens' })
  const el = document.querySelector('[data-token-count]') as HTMLElement
  expect(el.textContent).toBe('12.4k tokens')
  expect(el.title).toBe('12,412 tokens')
  expect(el.getAttribute('aria-label')).toBe('12,412 tokens')
  expect(el.dataset.tokens).toBe('12412')
})

it('TokenCount shows Not recorded for null', () => {
  render(TokenCount, { value: null })
  expect(screen.getByText('Not recorded')).toBeTruthy()
  expect(document.querySelector('[data-tokens]')).toBeNull()
})

it('store applySession replaces the snapshot and loadSession reads it', async () => {
  usage.applySession(snap(10))
  usage.applySession(snap(20, 2))
  expect(usage.totalFor('s1')).toBe(20)
  expect(usage.totalFor('other')).toBeNull()
  usage.reset()
  await usage.loadSession('s1')
  expect(invoke).toHaveBeenCalledWith('usage:get-session', { sessionId: 's1' })
  expect(usage.totalFor('s1')).toBe(1_200_000)
})

it('UsageChip renders the total and follows the store', async () => {
  usage.applySession(snap(1_200_000))
  render(UsageChip, { sessionId: 's1' })
  await waitFor(() =>
    expect(document.querySelector('[data-usage-chip]')?.textContent).toContain('1.2M')
  )
  expect(document.querySelector('[data-usage-chip]')?.textContent).toContain('Tokens')
  usage.applySession(snap(1_500_000, 5))
  await waitFor(() =>
    expect(document.querySelector('[data-usage-chip]')?.textContent).toContain('1.5M')
  )
})

function worker(over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: [],
    model: 'sonnet',
    status: 'working',
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    ...over
  } as WorkerView
}

it('WorkerCard shows Not recorded for null tokens', () => {
  render(WorkerCard, { worker: worker({ tokens: null }), onopen: () => {} })
  expect(document.querySelector('[data-worker-card] [data-token-count]')?.textContent).toBe(
    'Not recorded'
  )
})

it('WorkerCard shows the worker total, and nothing when tokens are absent', () => {
  const { unmount } = render(WorkerCard, {
    worker: worker({ tokens: totals(84_000) }),
    onopen: () => {}
  })
  expect(document.querySelector('[data-worker-card]')?.textContent).toContain('84k tokens')
  unmount()
  render(WorkerCard, { worker: worker(), onopen: () => {} })
  expect(document.querySelector('[data-token-count]')).toBeNull()
})

function agent(over: Partial<AgentUsage>): AgentUsage {
  return {
    agentKey: 'brain',
    role: 'brain',
    label: 'Brain',
    provider: 'claude',
    model: 'sonnet',
    recording: 'recorded',
    tokens: { input: 5000, cacheWrite: 100, cacheRead: 1500, output: 300, total: 6900 },
    byModel: [],
    maxCallInput: 0,
    setup: {
      arcAdditionsPerRequest: null,
      fixedSetupPerRequest: null,
      setupTokens: 0,
      arcSetupTokens: 0,
      work: 0
    },
    ...over
  }
}
const panelSnap = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  sessionId: 's1',
  total: totals(7200),
  setupShare: null,
  arcSetupShare: null,
  byProvider: { claude: totals(6900), codex: totals(300) },
  partial: false,
  agents: [
    agent({}),
    agent({
      agentKey: 'w1',
      role: 'worker',
      label: 'W1 · api-retry',
      provider: 'codex',
      model: 'gpt-5.5',
      tokens: totals(300)
    })
  ],
  suggestions: [],
  updatedAt: 1,
  ...over
})
const chip = (): HTMLButtonElement =>
  document.querySelector('[data-usage-chip]') as HTMLButtonElement

it('UsageChip opens the panel, closes on Escape and returns focus', async () => {
  usage.applySession(panelSnap())
  render(UsageChip, { sessionId: 's1' })
  expect(chip().getAttribute('aria-haspopup')).toBe('dialog')
  expect(chip().getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[data-usage-panel]')).toBeNull()
  await fireEvent.click(chip())
  const panel = document.querySelector('[data-usage-panel]') as HTMLElement
  expect(chip().getAttribute('aria-expanded')).toBe('true')
  expect(chip().getAttribute('aria-controls')).toBe(panel.id)
  expect(document.activeElement).toBe(panel)
  await fireEvent.keyDown(panel, { key: 'Escape' })
  expect(document.querySelector('[data-usage-panel]')).toBeNull()
  expect(document.activeElement).toBe(chip())
})

it('UsageChip closes on a click outside and on a second click', async () => {
  usage.applySession(panelSnap())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  await fireEvent.pointerDown(document.body)
  expect(document.querySelector('[data-usage-panel]')).toBeNull()
  await fireEvent.click(chip())
  await fireEvent.click(chip())
  expect(document.querySelector('[data-usage-panel]')).toBeNull()
})

it('UsagePanel lists rows, the session total and per-provider totals', async () => {
  usage.applySession(panelSnap())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const rows = [...document.querySelectorAll('[data-usage-row]')] as HTMLElement[]
  expect(rows.map((r) => r.dataset.usageRow)).toEqual(['brain', 'w1'])
  expect(rows[0]!.textContent).toContain('Brain')
  expect(rows[0]!.textContent).toContain('Claude · Sonnet')
  expect(rows[0]!.querySelectorAll('td [data-tokens]')).toHaveLength(5)
  expect(rows[1]!.textContent).toContain('Codex · gpt-5.5')
  expect(document.querySelector('[data-usage-total]')?.textContent).toContain('7.2k')
  expect(document.querySelector('[data-usage-provider-total="claude"]')?.textContent).toContain(
    'Claude · 6.9k'
  )
  expect(document.querySelector('[data-usage-provider-total="codex"]')?.textContent).toContain(
    'Codex · 300'
  )
  expect(document.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(5)
  expect(document.querySelector('[data-usage-note]')).toBeNull()
})

it('UsagePanel shows Not recorded and the partial notes', async () => {
  usage.applySession(
    panelSnap({
      partial: true,
      agents: [
        agent({ recording: 'partial' }),
        agent({
          agentKey: 'w3',
          role: 'worker',
          label: 'W3',
          recording: 'not-recorded',
          tokens: null
        })
      ]
    })
  )
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const gone = document.querySelector('[data-usage-row="w3"]') as HTMLElement
  expect(gone.textContent).toContain('Not recorded')
  expect(gone.querySelector('[data-tokens]')).toBeNull()
  expect(document.querySelector('[data-usage-row="brain"] [data-usage-partial]')).toBeTruthy()
  expect(document.querySelector('[data-usage-note]')).toBeTruthy()
})

it('a session from before recording shows Not recorded in the total row and the chip, not 0', async () => {
  usage.applySession(
    panelSnap({
      total: totals(0),
      agents: [
        agent({ recording: 'not-recorded', tokens: null }),
        agent({
          agentKey: 'w1',
          role: 'worker',
          label: 'W1',
          recording: 'not-recorded',
          tokens: null
        })
      ]
    })
  )
  render(UsageChip, { sessionId: 's1' })
  expect(chip().textContent).toContain('Not recorded')
  expect(chip().querySelector('[data-tokens]')).toBeNull()
  await fireEvent.click(chip())
  const total = document.querySelector('[data-usage-total]') as HTMLElement
  expect(total.textContent).toContain('Not recorded')
  expect(total.querySelector('[data-tokens]')).toBeNull()
})

it('a partly recorded session keeps the numeric total row', async () => {
  usage.applySession(
    panelSnap({
      agents: [
        agent({ recording: 'partial' }),
        agent({
          agentKey: 'w1',
          role: 'worker',
          label: 'W1',
          recording: 'not-recorded',
          tokens: null
        })
      ]
    })
  )
  render(UsageChip, { sessionId: 's1' })
  expect(chip().querySelector('[data-tokens]')).toBeTruthy()
  await fireEvent.click(chip())
  expect(document.querySelector('[data-usage-total] [data-tokens]')).toBeTruthy()
})

const preset = {
  task: 'Add retry.',
  lastReport: null,
  failureReason: null,
  changedFiles: [],
  worktreePaths: []
} as unknown as WorkerDetailsData

it('WorkerDetails shows the breakdown from the snapshot, else the card totals, else Not recorded', () => {
  usage.applySession(
    panelSnap({
      agents: [
        agent({
          agentKey: 'w1',
          role: 'worker',
          tokens: { input: 1000, cacheWrite: 20, cacheRead: 300, output: 40, total: 1360 }
        })
      ]
    })
  )
  const { unmount } = render(WorkerDetails, { worker: worker(), onclose: () => {}, preset })
  const row = (key: string): string | undefined =>
    document
      .querySelector(`[data-worker-tokens-row="${key}"] [data-tokens]`)
      ?.getAttribute('data-tokens') ?? undefined
  expect(row('input')).toBe('1000')
  expect(row('cacheWrite')).toBe('20')
  expect(row('cacheRead')).toBe('300')
  expect(row('output')).toBe('40')
  expect(row('total')).toBe('1360')
  unmount()
  usage.reset()
  render(WorkerDetails, { worker: worker({ tokens: totals(84_000) }), onclose: () => {}, preset })
  expect(row('total')).toBe('84000')
  cleanup()
  render(WorkerDetails, { worker: worker({ tokens: null }), onclose: () => {}, preset })
  expect(document.querySelector('[data-worker-tokens]')?.textContent).toContain('Not recorded')
})

it('UsagePanel is a viewport-bounded vertical scroll container', async () => {
  usage.applySession(panelSnap())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const panel = document.querySelector('[data-usage-panel]') as HTMLElement
  expect(panel.classList.contains('overflow-y-auto')).toBe(true)
  // jsdom: the chip's rect is all zeros, so the bound is the window height minus the 16px margin.
  expect(panel.style.maxHeight).toBe(`${window.innerHeight - 16}px`)
})

const mixed = (): SessionUsage => {
  const claude: TokenTotals = {
    input: 1000,
    cacheWrite: 200,
    cacheRead: 9000,
    output: 100,
    total: 10_300
  }
  const codex: TokenTotals = { input: 500, cacheWrite: 0, cacheRead: 4500, output: 50, total: 5050 }
  return panelSnap({
    total: { input: 1500, cacheWrite: 200, cacheRead: 13_500, output: 150, total: 15_350 },
    byProvider: { claude, codex },
    agents: [agent({ tokens: claude })]
  })
}

it('UsagePanel names the cache columns by cold and hit, here and in the worker details', async () => {
  usage.applySession(mixed())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const heads = [...document.querySelectorAll('th[scope="col"]')].map((th) => th.textContent)
  expect(heads).toEqual([
    'Agent',
    'Input',
    'Cache write (cold)',
    'Cache read (hit)',
    'Output',
    'Total'
  ])
  cleanup()
  usage.applySession(panelSnap({ agents: [agent({ agentKey: 'w1', role: 'worker' })] }))
  render(WorkerDetails, { worker: worker(), onclose: () => {}, preset })
  const labels = [...document.querySelectorAll('[data-worker-tokens-row]')].map(
    (dd) => dd.previousElementSibling?.textContent
  )
  expect(labels).toEqual(['Input', 'Cache write (cold)', 'Cache read (hit)', 'Output', 'Total'])
})

it('UsagePanel sums up what was new and what came from cache, with exact counts on hover', async () => {
  usage.applySession(mixed())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const line = document.querySelector('[data-usage-summary]') as HTMLElement
  expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('New 1.9k · From cache 13.5k (88%)')
  const counts = [...line.querySelectorAll('[data-tokens]')] as HTMLElement[]
  expect(counts.map((c) => c.dataset.tokens)).toEqual(['1850', '13500'])
  expect(counts.map((c) => c.title)).toEqual(['1,850 tokens', '13,500 tokens'])
})

it('UsagePanel shows the weighted figure per provider ratios, with the explanation on hover and for assistive tech', async () => {
  usage.applySession(mixed())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const weighted = document.querySelector('[data-usage-weighted]') as HTMLElement
  expect(weighted.textContent).toContain('Weighted ≈ 4k')
  expect(weighted.querySelector('[data-tokens]')?.getAttribute('data-tokens')).toBe('4000')
  const explanation =
    "Weighted by cost relative to normal input: Claude cache read x0.1, cache write x1.25, output x5; Codex cached input x0.1, output x8; Cursor, where it reports tokens, at Claude's ratios. Not a dollar amount."
  expect(weighted.title).toBe(explanation)
  const described = weighted.getAttribute('aria-describedby') ?? ''
  expect(document.getElementById(described)?.textContent).toBe(explanation)
  // The header chip stays raw.
  expect(chip().textContent).not.toContain('Weighted')
})

it('UsagePanel always carries the "Not counted" footnote', async () => {
  usage.applySession(mixed())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const note = document.querySelector('[data-usage-not-counted]') as HTMLElement
  expect(note.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Not counted: CLI runs an agent starts itself, for example claude -p from its shell.'
  )
})

it('UsagePanel leaves out the summary and the weighted figure when nothing was recorded', async () => {
  usage.applySession(
    panelSnap({
      total: totals(0),
      byProvider: {},
      agents: [agent({ recording: 'not-recorded', tokens: null })]
    })
  )
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  expect(document.querySelector('[data-usage-summary]')).toBeNull()
  expect(document.querySelector('[data-usage-weighted]')).toBeNull()
  expect(document.querySelector('[data-usage-not-counted]')).toBeTruthy()
})
