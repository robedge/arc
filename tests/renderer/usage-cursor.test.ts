import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import TokenCount from '../../src/renderer/src/lib/components/ui/TokenCount.svelte'
import PlanMeters from '../../src/renderer/src/lib/components/ui/PlanMeters.svelte'
import UsageChip from '../../src/renderer/src/lib/components/sessions/UsageChip.svelte'
import DailyChart from '../../src/renderer/src/lib/components/usage/DailyChart.svelte'
import UsageTotals from '../../src/renderer/src/lib/components/usage/UsageTotals.svelte'
import { planUsage } from '../../src/renderer/src/lib/stores/plan-usage.svelte'
import { usage } from '../../src/renderer/src/lib/stores/usage.svelte'
import type {
  AgentUsage,
  PlanSnapshot,
  RangeTotals,
  SessionUsage,
  TokenTotals
} from '../../src/shared/types/usage'
import { mockHarness } from './helpers'

const t = (total: number): TokenTotals => ({
  input: total,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  total
})
const agent = (over: Partial<AgentUsage>): AgentUsage => ({
  agentKey: 'brain',
  role: 'brain',
  label: 'Brain',
  provider: 'claude',
  model: 'sonnet',
  recording: 'recorded',
  tokens: t(1000),
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
})
const cursorAgent = agent({
  agentKey: 'w1',
  role: 'worker',
  label: 'W1 · ui',
  provider: 'cursor',
  model: 'auto',
  recording: 'not-reported',
  tokens: null
})
const snap = (over: Partial<SessionUsage>): SessionUsage => ({
  sessionId: 's1',
  total: t(1000),
  setupShare: null,
  arcSetupShare: null,
  byProvider: { claude: t(1000) },
  notReported: ['cursor'],
  partial: false,
  agents: [agent({}), cursorAgent],
  suggestions: [],
  updatedAt: 1,
  ...over
})
const chip = (): HTMLElement => document.querySelector('[data-usage-chip]') as HTMLElement

beforeEach(() => {
  usage.reset()
  planUsage.reset()
  mockHarness(() => ({ ok: true, data: snap({}) }))
})
afterEach(cleanup)

it('TokenCount reads Not reported for a not-reported agent', () => {
  render(TokenCount, { value: null, notReported: true })
  expect(document.querySelector('[data-token-count]')?.textContent).toBe('Not reported')
})

it('the panel marks the Cursor row, keeps it out of the total and explains why', async () => {
  usage.applySession(snap({}))
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const row = document.querySelector('[data-usage-row="w1"]') as HTMLElement
  expect(row.textContent).toContain('Not reported')
  expect(row.textContent).not.toContain('Not recorded')
  expect(document.querySelector('[data-usage-total]')?.textContent).toContain('1k')
  expect(document.querySelector('[data-usage-provider-total="cursor"]')).toBeNull()
  expect(document.querySelector('[data-usage-not-reported]')?.textContent).toContain(
    "Cursor doesn't report tokens; its agents aren't in these totals."
  )
})

it('the chip and the total row read Not reported for a Cursor-only session', async () => {
  usage.applySession(snap({ total: t(0), byProvider: {}, agents: [cursorAgent] }))
  render(UsageChip, { sessionId: 's1' })
  expect(chip().textContent).toContain('Not reported')
  expect(chip().textContent).not.toContain('Not recorded')
  await fireEvent.click(chip())
  expect(document.querySelector('[data-usage-total]')?.textContent).toContain('Not reported')
})

it('the Usage page lists Cursor as Not reported', () => {
  const totals: RangeTotals = {
    total: t(500),
    byProvider: [
      { provider: 'claude', tokens: t(500) },
      { provider: 'cursor', tokens: t(0), notReported: true }
    ],
    byModel: [],
    planCheck: t(0)
  }
  render(UsageTotals, { totals })
  expect(document.querySelector('[data-total-provider="cursor"]')?.textContent?.trim()).toBe(
    'Cursor · Not reported'
  )
  expect(document.querySelector('[data-total-provider="claude"]')?.textContent).toContain('500')
})

it('DailyChart draws three providers in order with the Cursor dot pattern and legend', () => {
  render(DailyChart, {
    daily: [{ day: '2026-10-01', byProvider: { cursor: 30, codex: 20, claude: 10 } }],
    range: 'today',
    total: 60
  })
  const order = [...document.querySelectorAll('[data-segment]')].map((s) =>
    s.getAttribute('data-segment')
  )
  expect(order).toEqual(['claude', 'codex', 'cursor'])
  expect(document.querySelector('[data-segment="cursor"]')?.getAttribute('fill')).toBe(
    'url(#chart-dots-cursor)'
  )
  expect(document.querySelector('pattern#chart-dots-cursor circle')).toBeTruthy()
  const legend = document.querySelectorAll('[data-chart-legend] li')
  expect([...legend].map((l) => l.textContent?.trim())).toEqual(['Claude', 'Codex', 'Cursor'])
  expect(legend[2]?.querySelector('rect')?.getAttribute('fill')).toBe('url(#chart-dots-cursor)')
})

it('DailyChart leaves a provider with only zero rows out of the legend and table, and lists it once it has usage', () => {
  const zeroCursor = [
    { day: '2026-10-01', byProvider: { claude: 10, cursor: 0 } },
    { day: '2026-10-02', byProvider: { claude: 5, cursor: 0 } }
  ]
  const view = render(DailyChart, { daily: zeroCursor, range: '7d', total: 15 })
  const names = (): (string | undefined)[] =>
    [...document.querySelectorAll('[data-chart-legend] li')].map((l) => l.textContent?.trim())
  const heads = (): (string | undefined)[] =>
    [...document.querySelectorAll('[data-chart-table] thead th')].map((h) => h.textContent?.trim())
  expect(names()).toEqual(['Claude'])
  expect(heads()).toEqual(['Date', 'Claude', 'Total'])
  expect(document.querySelector('[data-segment="cursor"]')).toBeNull()

  view.rerender({
    daily: [zeroCursor[0]!, { day: '2026-10-02', byProvider: { claude: 5, cursor: 7 } }],
    range: '7d',
    total: 22
  })
  return Promise.resolve().then(() => {
    expect(names()).toEqual(['Claude', 'Cursor'])
    expect(heads()).toEqual(['Date', 'Claude', 'Cursor', 'Total'])
  })
})

it('PlanMeters shows Cursor · Not reported', () => {
  const plans: PlanSnapshot = {
    plans: [{ provider: 'cursor', state: 'not-reported', limits: [], planType: 'pro' }],
    notices: []
  }
  planUsage.apply(plans)
  render(PlanMeters)
  expect(document.querySelector('[data-plan-meter="cursor"]')?.getAttribute('aria-label')).toBe(
    'Cursor · Not reported'
  )
})
