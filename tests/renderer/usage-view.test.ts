import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Result } from '@shared/errors'
import type {
  DailyUsage,
  SpenderRow,
  TokenTotals,
  UsageRange,
  UsageReport
} from '../../src/shared/types/usage'
import App from '../../src/renderer/src/App.svelte'
import TitleBar from '../../src/renderer/src/lib/components/ui/TitleBar.svelte'
import DailyChart from '../../src/renderer/src/lib/components/usage/DailyChart.svelte'
import UsageView from '../../src/renderer/src/lib/components/usage/UsageView.svelte'
import { motion } from '../../src/renderer/src/lib/stores/motion.svelte'
import { sessionsList } from '../../src/renderer/src/lib/stores/sessions-list.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { usage } from '../../src/renderer/src/lib/stores/usage.svelte'
import { mockHarness } from './helpers'

const t = (total: number): TokenTotals => ({
  input: total,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  total
})

const daily = (n: number): DailyUsage[] =>
  Array.from({ length: n }, (_, i) => ({
    day: `2026-10-${String(i + 1).padStart(2, '0')}`,
    byProvider:
      i % 3 === 0 ? ({} as Record<string, number>) : { claude: 1000 * (i + 1), codex: 500 * i }
  }))

const row = (
  over: Partial<SpenderRow> & Pick<SpenderRow, 'key' | 'name' | 'total'>
): SpenderRow => ({
  groupName: 'Alpha',
  provider: 'claude',
  model: 'sonnet',
  clickable: true,
  ...over
})

function report(range: UsageRange = '7d', over: Partial<UsageReport> = {}): UsageReport {
  return {
    range,
    totals: {
      total: t(12_400),
      byProvider: [
        { provider: 'claude', tokens: t(9_000) },
        { provider: 'codex', tokens: t(3_400) }
      ],
      byModel: [
        { provider: 'claude', model: 'sonnet', tokens: t(9_000) },
        { provider: 'codex', model: 'gpt-5.5', tokens: t(3_400) }
      ],
      planCheck: t(0)
    },
    daily: daily(7),
    spenders: {
      session: [
        row({ key: 's1', name: 'Big session', total: 8000, sessionId: 's1' }),
        row({ key: 's2', name: 'Gone session', total: 3000, sessionId: 's2', clickable: false })
      ],
      worker: [row({ key: 'w1', name: 'W1 docs', total: 5000, sessionId: 's1', workerId: 'w1' })],
      command: [row({ key: 'c1', name: '/review', total: 4000, clickable: false, runs: 3 })]
    },
    plans: [
      {
        provider: 'claude',
        state: 'ok',
        limits: [
          {
            provider: 'claude',
            windowId: '5h',
            label: '5h',
            usedPercent: 42,
            resetsAt: null,
            observedAt: Date.now(),
            source: 'event'
          }
        ]
      }
    ],
    suggestions: [],
    generatedAt: 1,
    ...over
  }
}

let invoke: ReturnType<typeof mockHarness>
let handler: (channel: string, request: unknown) => Result<unknown> | Promise<Result<unknown>>

beforeEach(() => {
  usage.reset()
  ui.view = 'main'
  sessionsList.byGroup = {}
  handler = (channel, request) => {
    if (channel === 'usage:get-report')
      return { ok: true, data: report((request as { range: UsageRange }).range) }
    return {
      ok: false,
      error: { code: 'INTERNAL', message: 'unexpected' }
    } as unknown as Result<unknown>
  }
  invoke = mockHarness((c, r) => handler(c, r))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('usage store', () => {
  it('ignores a stale response when the range changed meanwhile', async () => {
    const pending = new Map<string, (r: Result<unknown>) => void>()
    handler = (_c, request) =>
      new Promise((resolve) => pending.set((request as { range: string }).range, resolve))
    const slow = usage.loadReport('30d')
    const fast = usage.loadReport('today')
    pending.get('today')?.({ ok: true, data: report('today') })
    await fast
    pending.get('30d')?.({ ok: true, data: report('30d') })
    await slow
    expect(usage.report?.range).toBe('today')
    expect(usage.range).toBe('today')
  })

  it('handleChanged reloads only once a report is held', async () => {
    usage.handleChanged()
    expect(invoke).not.toHaveBeenCalled()
    await usage.loadReport('7d')
    usage.handleChanged()
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })
})

describe('Usage view', () => {
  it('loads the 7 day report with totals, per provider, per model and plan limits', async () => {
    render(UsageView)
    await waitFor(() => expect(document.querySelector('[data-usage-totals]')).toBeTruthy())
    expect(invoke).toHaveBeenCalledWith('usage:get-report', { range: '7d' })
    expect(document.querySelector('[data-range="7d"]')?.getAttribute('aria-checked')).toBe('true')
    expect(
      document.querySelector('[data-range-total] [data-tokens]')?.getAttribute('data-tokens')
    ).toBe('12400')
    expect(document.querySelector('[data-total-provider="codex"]')?.textContent).toContain('Codex')
    expect(document.querySelector('[data-total-model="codex:gpt-5.5"]')?.textContent).toContain(
      '3.4k'
    )
    expect(document.querySelector('[data-plan-limit="claude:5h"]')).toBeTruthy()
    expect(document.querySelector('[data-plan-check]')).toBeNull()
  })

  it('totals sum up new versus from cache and show the weighted figure, per provider ratios', async () => {
    const claude: TokenTotals = {
      input: 1000,
      cacheWrite: 200,
      cacheRead: 9000,
      output: 100,
      total: 10_300
    }
    const codex: TokenTotals = {
      input: 500,
      cacheWrite: 0,
      cacheRead: 4500,
      output: 50,
      total: 5050
    }
    const base = report('7d')
    handler = () => ({
      ok: true,
      data: {
        ...base,
        totals: {
          ...base.totals,
          total: { input: 1500, cacheWrite: 200, cacheRead: 13_500, output: 150, total: 15_350 },
          byProvider: [
            { provider: 'claude', tokens: claude },
            { provider: 'codex', tokens: codex }
          ]
        }
      }
    })
    render(UsageView)
    await waitFor(() => expect(document.querySelector('[data-usage-totals]')).toBeTruthy())
    const line = document.querySelector('[data-usage-totals] [data-usage-summary]') as HTMLElement
    expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('New 1.9k · From cache 13.5k (88%)')
    expect(
      [...line.querySelectorAll('[data-tokens]')].map((c) => c.getAttribute('data-tokens'))
    ).toEqual(['1850', '13500'])
    const weighted = document.querySelector(
      '[data-usage-totals] [data-usage-weighted]'
    ) as HTMLElement
    expect(weighted.textContent).toContain('Weighted ≈ 4k')
    expect(weighted.title).toContain('Not a dollar amount.')
  })

  it('switching the range reloads the report', async () => {
    render(UsageView)
    await waitFor(() => expect(document.querySelector('[data-usage-totals]')).toBeTruthy())
    await fireEvent.click(document.querySelector('[data-range="today"]') as HTMLElement)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('usage:get-report', { range: 'today' }))
    await waitFor(() => expect(usage.report?.range).toBe('today'))
    expect(document.querySelector('[data-range="today"]')?.getAttribute('aria-checked')).toBe(
      'true'
    )
  })

  it('the range picker moves with the arrow keys', async () => {
    render(UsageView)
    await waitFor(() => expect(usage.report).not.toBeNull())
    const seven = document.querySelector('[data-range="7d"]') as HTMLElement
    await fireEvent.keyDown(seven, { key: 'ArrowRight' })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('usage:get-report', { range: '30d' }))
    expect(document.querySelector('[data-range="30d"]')?.getAttribute('tabindex')).toBe('0')
    expect(seven.getAttribute('tabindex')).toBe('-1')
  })

  it('shows a Plan check line when the range holds one', async () => {
    handler = () => {
      const r = report()
      return { ok: true, data: { ...r, totals: { ...r.totals, planCheck: t(120) } } }
    }
    render(UsageView)
    await waitFor(() => expect(document.querySelector('[data-plan-check]')).toBeTruthy())
    expect(document.querySelector('[data-plan-check]')?.textContent).toContain('Plan check')
    expect(
      document.querySelector('[data-plan-check] [data-tokens]')?.getAttribute('data-tokens')
    ).toBe('120')
  })

  it('shows the empty state but keeps plan limits when there is no usage', async () => {
    handler = () => {
      const r = report('today')
      return {
        ok: true,
        data: { ...r, totals: { ...r.totals, total: t(0), byProvider: [], byModel: [] } }
      }
    }
    render(UsageView)
    await waitFor(() => expect(screen.getByText('No usage in this period.')).toBeTruthy())
    expect(document.querySelector('[data-plan-limit="claude:5h"]')).toBeTruthy()
    expect(document.querySelector('[data-daily-chart]')).toBeNull()
  })

  it('Back returns to the main view', async () => {
    ui.openUsage()
    render(UsageView)
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(ui.view).toBe('main')
  })
})

describe('Biggest spenders', () => {
  async function open(): Promise<void> {
    render(UsageView)
    await waitFor(() => expect(document.querySelector('[data-spenders]')).toBeTruthy())
  }
  const names = (): string[] =>
    [...document.querySelectorAll('[data-spender-row]')].map(
      (el) => el.querySelector('.truncate')?.textContent ?? ''
    )

  it('lists sessions in the order given with group, provider and model', async () => {
    await open()
    expect(names()).toEqual(['Big session', 'Gone session'])
    expect(document.querySelector('[data-spender-row]')?.textContent).toContain('Alpha')
    expect(document.querySelector('[data-spender-row]')?.textContent).toContain('Claude · Sonnet')
  })

  it('switches by kind and shows runs on command rows, which are not clickable', async () => {
    await open()
    await fireEvent.click(document.querySelector('[data-spender-kind="command"]') as HTMLElement)
    expect(names()).toEqual(['/review'])
    const li = document.querySelector('[data-spender-row]') as HTMLElement
    expect(li.textContent).toContain('3 runs')
    expect(li.querySelector('button')).toBeNull()
    await fireEvent.click(document.querySelector('[data-spender-kind="worker"]') as HTMLElement)
    expect(names()).toEqual(['W1 docs'])
  })

  it('a deleted session is shown plainly, a live one is a button that opens the session', async () => {
    sessionsList.byGroup = {
      g1: [{ id: 's1', groupId: 'g1', name: 'Big session' } as never]
    }
    handler = (channel, request) => {
      if (channel === 'usage:get-report') return { ok: true, data: report() }
      if (channel === 'sessions:open')
        return { ok: false, error: { code: 'INTERNAL', message: 'n/a' } } as never
      if (channel === 'groups:open') return { ok: true, data: undefined }
      if (channel === 'groups:detail') return { ok: true, data: undefined }
      void request
      return { ok: true, data: undefined }
    }
    ui.openUsage()
    await open()
    const rows = document.querySelectorAll('[data-spender-row]')
    expect(rows[1]?.querySelector('button')).toBeNull()
    await fireEvent.click(rows[0]?.querySelector('button') as HTMLElement)
    await waitFor(() => expect(ui.view).toBe('main'))
    expect(ui.selectedGroupId).toBe('g1')
    expect(invoke).toHaveBeenCalledWith('sessions:open', { sessionId: 's1' })
  })
})

describe('Daily chart', () => {
  it('renders one focusable group per day and an always-present table', () => {
    const days = daily(7)
    render(DailyChart, { daily: days, range: '7d', total: 12_400 })
    const groups = document.querySelectorAll('[data-day]')
    expect(groups).toHaveLength(7)
    expect(groups[0]?.getAttribute('data-day')).toBe('2026-10-01')
    expect(document.querySelectorAll('[data-daily-chart] [tabindex="0"]')).toHaveLength(1)
    const svg = document.querySelector('[data-daily-chart]') as SVGElement
    expect(svg.getAttribute('role')).toBe('img')
    expect(
      document.getElementById(svg.getAttribute('aria-labelledby') as string)?.textContent
    ).toContain('12,400 tokens')
    const table = document.querySelector('[data-chart-table]') as HTMLElement
    expect(table.querySelectorAll('tbody tr')).toHaveLength(7)
    expect(table.closest('.sr-only')).toBeTruthy()
  })

  it('Show as table reveals the table', async () => {
    render(DailyChart, { daily: daily(3), range: '7d', total: 1 })
    await fireEvent.click(screen.getByRole('button', { name: 'Show as table' }))
    expect(document.querySelector('[data-chart-table]')?.closest('.sr-only')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hide table' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('arrow keys move focus between days and the tooltip shows exact counts', async () => {
    render(DailyChart, { daily: daily(7), range: '7d', total: 1 })
    const first = document.querySelector('[data-day="2026-10-01"]') as SVGElement
    const second = document.querySelector('[data-day="2026-10-02"]') as SVGElement
    first.focus()
    await fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)
    expect(second.getAttribute('tabindex')).toBe('0')
    expect(first.getAttribute('tabindex')).toBe('-1')
    expect(document.querySelector('[data-chart-tooltip]')?.textContent).toContain('Claude: 2,000')
  })

  it('labels every day for 7d and every 5th for 30d', () => {
    const { unmount } = render(DailyChart, { daily: daily(7), range: '7d', total: 1 })
    expect(document.querySelectorAll('text.chart-label').length).toBeGreaterThanOrEqual(7)
    unmount()
    render(DailyChart, { daily: daily(30), range: '30d', total: 1 })
    const xLabels = [...document.querySelectorAll('text.chart-label')].filter((el) =>
      /^[A-Z][a-z]{2} \d+$/.test(el.textContent ?? '')
    )
    expect(xLabels).toHaveLength(6)
  })

  describe('compact sizing', () => {
    const widthOf = (w: number): void => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w)
    }
    const heightOf = (): number => {
      const svg = document.querySelector('[data-daily-chart]') as SVGElement
      return Number(svg.getAttribute('height'))
    }

    afterEach(() => vi.restoreAllMocks())

    it('has a fixed compact height independent of container width', () => {
      widthOf(500)
      const { unmount } = render(DailyChart, { daily: daily(7), range: '7d', total: 1 })
      const narrow = heightOf()
      unmount()
      widthOf(2400)
      render(DailyChart, { daily: daily(7), range: '7d', total: 1 })
      const svg = document.querySelector('[data-daily-chart]') as SVGElement
      expect(heightOf()).toBe(narrow)
      expect(narrow).toBeGreaterThan(0)
      expect(narrow).toBeLessThanOrEqual(200)
      expect(svg.getAttribute('viewBox')).toBe(`0 0 2400 ${narrow}`)
    })

    it('caps bar width so one day is not a fat bar', () => {
      widthOf(2400)
      render(DailyChart, { daily: daily(2), range: '7d', total: 1 })
      const bars = [...document.querySelectorAll('[data-segment]')]
      expect(bars.length).toBeGreaterThan(0)
      for (const bar of bars) expect(Number(bar.getAttribute('width'))).toBeLessThanOrEqual(32)
    })
  })

  it('animates in once, but not under reduced motion', () => {
    render(DailyChart, { daily: daily(3), range: '7d', total: 1 })
    expect(document.querySelector('[data-daily-chart]')?.getAttribute('data-intro')).toBe('true')
    cleanup()
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    const stop = motion.start()
    render(DailyChart, { daily: daily(3), range: '7d', total: 1 })
    expect(document.querySelector('[data-daily-chart]')?.hasAttribute('data-intro')).toBe(false)
    stop()
  })
})

describe('Title bar and App', () => {
  it('the Usage button opens the view and toggles back', async () => {
    render(TitleBar)
    const button = screen.getByRole('button', { name: 'Usage' })
    await fireEvent.click(button)
    expect(ui.view).toBe('usage')
    await fireEvent.click(button)
    expect(ui.view).toBe('main')
  })

  it('App renders the Usage view when it is open', async () => {
    handler = (channel, request) =>
      channel === 'usage:get-report'
        ? { ok: true, data: report((request as { range: UsageRange }).range) }
        : { ok: true, data: { plans: [], notices: [] } }
    ui.openUsage()
    render(App)
    await waitFor(() => expect(document.querySelector('[data-usage-view]')).toBeTruthy())
  })
})
