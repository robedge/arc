import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import PlanMeters from '../../src/renderer/src/lib/components/ui/PlanMeters.svelte'
import { planUsage } from '../../src/renderer/src/lib/stores/plan-usage.svelte'
import { limitSeverity } from '../../src/renderer/src/lib/usage/derive'
import { formatAsOf, formatResetTime } from '../../src/renderer/src/lib/format/time'
import type { PlanLimit, PlanSnapshot, ProviderPlan } from '../../src/shared/types/usage'
import { mockHarness } from './helpers'

const limit = (windowId: string, label: string, usedPercent: number, extra = {}): PlanLimit => ({
  provider: 'claude',
  windowId,
  label,
  usedPercent,
  resetsAt: new Date(2026, 9, 20, 15, 40).getTime() / 1000,
  observedAt: new Date(2026, 9, 20, 14, 10).getTime(),
  source: 'event',
  ...extra
})
const snap = (plans: ProviderPlan[]): PlanSnapshot => ({ plans, notices: [] })
const claude = (limits: PlanLimit[]): ProviderPlan => ({ provider: 'claude', state: 'ok', limits })

beforeEach(() => {
  // The fixtures' reset times are on 2026-10-20; pin the clock so they read as "today".
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 20, 9, 0))
  planUsage.reset()
  mockHarness(() => ({ ok: true, data: snap([claude([limit('5h', '5h', 42)])]) }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('limitSeverity', () => {
  it.each([
    [79, 'ok'],
    [80, 'warn'],
    [94, 'warn'],
    [95, 'critical']
  ] as const)('%i -> %s', (pct, expected) => {
    expect(limitSeverity(pct)).toBe(expected)
  })
})

describe('time formats', () => {
  const now = new Date(2026, 9, 20, 9, 0).getTime()
  it('formats reset today and later', () => {
    expect(formatResetTime(new Date(2026, 9, 20, 15, 40).getTime() / 1000, now)).toBe('3:40 PM')
    expect(formatResetTime(new Date(2026, 9, 26, 15, 40).getTime() / 1000, now)).toBe('Mon 3:40 PM')
  })
  it('formats as-of', () => {
    expect(formatAsOf(new Date(2026, 9, 20, 14, 10).getTime())).toBe('as of 2:10 PM')
  })
})

describe('store', () => {
  it('apply replaces plans and exposes byProvider and meters', () => {
    planUsage.apply(snap([claude([limit('5h', '5h', 10)])]))
    planUsage.apply(snap([claude([limit('5h', '5h', 20)])]))
    expect(planUsage.byProvider.claude?.limits[0]?.usedPercent).toBe(20)
    expect(planUsage.meters).toHaveLength(1)
  })
  it('load and refresh call the plan channels', async () => {
    const invoke = mockHarness(() => ({ ok: true, data: snap([claude([limit('5h', '5h', 42)])]) }))
    await planUsage.load()
    expect(invoke).toHaveBeenCalledWith('plan:get', {})
    planUsage.reset()
    await planUsage.refresh()
    expect(invoke).toHaveBeenCalledWith('plan:refresh', {})
    expect(planUsage.meters).toHaveLength(1)
  })
})

describe('PlanMeters', () => {
  const btn = (p: string): HTMLElement => document.querySelector(`[data-plan-meter="${p}"]`)!

  it('shows the limits of an ok meter', () => {
    planUsage.apply(snap([claude([limit('5h', '5h', 42), limit('7d', 'Weekly', 18)])]))
    render(PlanMeters)
    expect(btn('claude').getAttribute('aria-label')).toBe('Claude · 5h 42% · Weekly 18%')
    expect(btn('claude').dataset.planMeterState).toBe('ok')
    expect(btn('claude').querySelector('[data-plan-compact]')!.textContent).toBe('Claude · 5h 42%')
  })

  it('shows waiting, not-reported and stale states', () => {
    planUsage.apply(
      snap([
        { provider: 'claude', state: 'waiting', limits: [] },
        { provider: 'codex', state: 'not-reported', limits: [] }
      ])
    )
    render(PlanMeters)
    expect(btn('claude').getAttribute('aria-label')).toBe('Claude · Waiting for first use')
    expect(btn('codex').getAttribute('aria-label')).toBe('Codex · Not reported')
    cleanup()
    planUsage.apply(snap([{ ...claude([limit('5h', '5h', 97, { stale: true })]), state: 'stale' }]))
    render(PlanMeters)
    expect(btn('claude').getAttribute('aria-label')).toBe('Claude · 5h Reset')
    expect(btn('claude').dataset.severity).toBe('ok')
    expect(btn('claude').textContent).not.toContain('97')
  })

  it.each([
    [79, 'ok', null],
    [80, 'warn', 'warning'],
    [94, 'warn', 'warning'],
    [95, 'critical', 'critical']
  ] as const)('severity at %i%%', (pct, severity, hidden) => {
    planUsage.apply(snap([claude([limit('7d', 'Weekly', 10), limit('5h', '5h', pct)])]))
    render(PlanMeters)
    expect(btn('claude').dataset.severity).toBe(severity)
    const sr = btn('claude').querySelector('.sr-only')
    expect(sr?.textContent ?? null).toBe(hidden)
  })

  it('opens on click, shows rows, closes on Escape and returns focus', async () => {
    planUsage.apply(snap([claude([limit('5h', '5h', 42), limit('7d', 'Weekly', 18)])]))
    render(PlanMeters)
    const b = btn('claude')
    expect(b.getAttribute('aria-haspopup')).toBe('dialog')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    b.focus()
    await fireEvent.click(b)
    expect(b.getAttribute('aria-expanded')).toBe('true')
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('[data-plan-limit]')).toHaveLength(2)
    expect(dialog.querySelector('[data-plan-limit="claude:5h"]')!.textContent).toContain(
      'Resets at 3:40 PM'
    )
    expect(dialog.textContent).toContain('as of 2:10 PM')
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(b)
  })

  it('opens on focus and hover', async () => {
    planUsage.apply(snap([claude([limit('5h', '5h', 42)])]))
    render(PlanMeters)
    await fireEvent.focusIn(btn('claude'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await fireEvent.focusOut(btn('claude'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await fireEvent.mouseEnter(btn('claude').parentElement!)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('popover rows show Reset for a stale limit', async () => {
    planUsage.apply(snap([claude([limit('5h', '5h', 97, { stale: true })])]))
    render(PlanMeters)
    await fireEvent.click(btn('claude'))
    const row = document.querySelector('[data-plan-limit="claude:5h"]')!
    expect(row.textContent).toContain('Reset')
    expect(row.textContent).not.toContain('97%')
  })

  it('leaves the empty title bar draggable: only each meter is no-drag', () => {
    planUsage.apply(snap([claude([limit('5h', '5h', 42)])]))
    render(PlanMeters)
    expect(document.querySelector('[data-plan-meters]')!.classList.contains('no-drag')).toBe(false)
    const root = document.querySelector('[data-plan-meter-root]')!
    expect(root.classList.contains('no-drag')).toBe(true)
    expect(root.classList.contains('select-none')).toBe(true)
  })

  it('renders nothing without meters', () => {
    planUsage.reset()
    render(PlanMeters)
    expect(document.querySelector('[data-plan-meters]')).toBeNull()
  })
})
