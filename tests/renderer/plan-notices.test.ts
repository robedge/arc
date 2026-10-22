import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import PlanMeters from '../../src/renderer/src/lib/components/ui/PlanMeters.svelte'
import PlanNotices from '../../src/renderer/src/lib/components/banners/PlanNotices.svelte'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import { planUsage } from '../../src/renderer/src/lib/stores/plan-usage.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import type { AppSettings } from '../../src/shared/types/provider'
import type { PlanNotice, PlanSnapshot } from '../../src/shared/types/usage'
import { mockHarness } from './helpers'

const resetsAt = new Date(2026, 9, 20, 15, 40).getTime() / 1000
const notice = (threshold: 80 | 95, over: Partial<PlanNotice> = {}): PlanNotice => ({
  key: `claude:5h:${threshold}:1`,
  provider: 'claude',
  windowId: '5h',
  label: '5h',
  threshold,
  usedPercent: threshold,
  resetsAt,
  ...over
})
const snap = (notices: PlanNotice[]): PlanSnapshot => ({ plans: [], notices })

beforeEach(() => {
  // The fixtures' reset times are on 2026-10-20; pin the clock so they read as "today".
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 20, 9, 0))
  planUsage.reset()
  settings.reset()
  mockHarness(() => ({ ok: true, data: undefined }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PlanNotices', () => {
  it('words an 80% notice and uses a status region', () => {
    planUsage.apply(snap([notice(80)]))
    render(PlanNotices)
    const p = document.querySelector('[data-plan-notice="claude:5h:80"]')!
    expect(p.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      "Claude's 5-hour limit is at 80%. It resets at 3:40 PM."
    )
    expect(p.closest('[data-kind]')!.getAttribute('role')).toBe('status')
    expect(p.closest('[data-kind]')!.getAttribute('data-kind')).toBe('warning')
  })

  it('words a 95% weekly notice and uses an alert', () => {
    planUsage.apply(snap([notice(95, { windowId: '7d', label: 'Weekly', key: 'k95' })]))
    render(PlanNotices)
    const p = document.querySelector('[data-plan-notice="claude:7d:95"]')!
    expect(p.textContent).toContain("Claude's weekly limit is at 95%.")
    expect(p.closest('[data-kind]')!.getAttribute('role')).toBe('alert')
    expect(p.closest('[data-kind]')!.getAttribute('data-kind')).toBe('error')
  })

  it('dismiss removes the notice and sends its key', async () => {
    const invoke = mockHarness(() => ({ ok: true, data: undefined }))
    planUsage.apply(snap([notice(80)]))
    render(PlanNotices)
    await fireEvent.click(screen.getByRole('button', { name: /Dismiss Claude 5-hour/ }))
    expect(document.querySelector('[data-plan-notice]')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('plan:dismiss-notice', { key: 'claude:5h:80:1' })
  })

  it('puts the notice back when dismissing fails', async () => {
    mockHarness(() => ({ ok: false, error: { code: 'INTERNAL', message: 'no' } }) as never)
    planUsage.apply(snap([notice(80)]))
    render(PlanNotices)
    await fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    await waitFor(() => expect(document.querySelector('[data-plan-notice]')).toBeTruthy())
  })
})

describe('Providers setting', () => {
  const values = (on: boolean): AppSettings =>
    ({ 'usage.checkClaudePlanOnLaunch': on }) as unknown as AppSettings

  it('reads the setting and writes it back when toggled', async () => {
    const invoke = mockHarness((channel, req) => {
      if (channel === 'settings:get') return { ok: true, data: values(true) }
      if (channel === 'settings:set')
        return { ok: true, data: { ...values(true), ...(req as object) } }
      return { ok: true, data: {} }
    })
    render(ProvidersSettings)
    const toggle = (await screen.findByRole('switch', {
      name: 'Check Claude plan usage when Arc opens'
    })) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(document.body.textContent).toContain('Sends one very small request')
    await fireEvent.click(toggle)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', {
        'usage.checkClaudePlanOnLaunch': false
      })
    )
  })
})

describe('PlanMeters fixes', () => {
  it('Escape closes a hover-opened popover and "· as of" has spaces', async () => {
    planUsage.apply({
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
              resetsAt,
              observedAt: new Date(2026, 9, 20, 14, 10).getTime(),
              source: 'event'
            }
          ]
        }
      ],
      notices: []
    })
    render(PlanMeters)
    await fireEvent.mouseEnter(document.querySelector('[data-plan-meter-root]')!)
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-plan-limit]')!.textContent).toContain(
      'Resets at 3:40 PM · as of 2:10 PM'
    )
    await fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
