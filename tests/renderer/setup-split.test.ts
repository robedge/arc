import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import SetupSplit from '../../src/renderer/src/lib/components/sessions/SetupSplit.svelte'
import UsageChip from '../../src/renderer/src/lib/components/sessions/UsageChip.svelte'
import { usage } from '../../src/renderer/src/lib/stores/usage.svelte'
import type { AgentSetup, SessionUsage } from '../../src/shared/types/usage'
import { mockHarness } from './helpers'

const setup = (over: Partial<AgentSetup> = {}): AgentSetup => ({
  arcAdditionsPerRequest: 6200,
  fixedSetupPerRequest: 18_400,
  setupTokens: 92_000,
  arcSetupTokens: 31_000,
  work: 8000,
  ...over
})
const text = (sel: string): string => document.querySelector(sel)?.textContent?.trim() ?? ''
const num = (sel: string): number =>
  Number(document.querySelector(`${sel} [data-tokens]`)?.getAttribute('data-tokens'))

beforeEach(() => {
  usage.reset()
  mockHarness(() => ({ ok: true, data: null }))
})
afterEach(cleanup)

it('SetupSplit shows the three labelled figures with "about"', () => {
  render(SetupSplit, { setup: setup(), inputTotal: 100_000 })
  expect(document.querySelector('[data-setup-split]')).toBeTruthy()
  expect(text('[data-setup-arc]').replace(/\s+/g, ' ')).toBe('about 6.2k per request')
  expect(text('[data-setup-fixed]').replace(/\s+/g, ' ')).toBe('18.4k per request · 92k in all')
  expect(text('[data-setup-work]')).toBe('8k')
  expect(text('[data-setup-split]')).toContain("Arc's additions")
  expect(text('[data-setup-split]')).toContain('Total fixed setup')
  expect(text('[data-setup-split]')).toContain('The work')
  expect(text('[data-setup-split]')).toContain('Everything sent before any work')
  expect(document.querySelector('[data-setup-bar]')?.getAttribute('aria-hidden')).toBe('true')
})

it('SetupSplit: fixed setup in all plus the work equals the input total', () => {
  render(SetupSplit, { setup: setup(), inputTotal: 100_000 })
  expect(num('[data-setup-fixed]')).toBe(18_400) // first token count is per request
  const inAll = Number(
    document.querySelectorAll('[data-setup-fixed] [data-tokens]')[1]?.getAttribute('data-tokens')
  )
  expect(inAll + num('[data-setup-work]')).toBe(num('[data-setup-input]'))
})

it('SetupSplit says Not measured yet when per-request values are null', () => {
  render(SetupSplit, {
    setup: setup({ arcAdditionsPerRequest: null, fixedSetupPerRequest: null }),
    inputTotal: 100_000
  })
  expect(text('[data-setup-fixed]')).toBe('Not measured yet')
  expect(text('[data-setup-arc]')).toBe('Not measured yet')
})

it('TokenCount numbers opt out of the uppercase transform', () => {
  usage.applySession({
    sessionId: 's1',
    total: { input: 6200, cacheWrite: 0, cacheRead: 0, output: 0, total: 6200 },
    setupShare: null,
    arcSetupShare: null,
    byProvider: {},
    partial: false,
    agents: [],
    suggestions: [],
    updatedAt: 1
  })
  render(UsageChip, { sessionId: 's1' })
  const n = document.querySelector('[data-usage-chip] [data-token-count]') as HTMLElement
  expect(n.textContent).toBe('6.2k')
  expect(n.classList.contains('normal-case')).toBe(true)
})

const snap = (over: Partial<SessionUsage>): SessionUsage => ({
  sessionId: 's1',
  total: { input: 100, cacheWrite: 0, cacheRead: 0, output: 0, total: 100 },
  setupShare: 0.18,
  arcSetupShare: 0.06,
  byProvider: {},
  partial: false,
  agents: [
    {
      agentKey: 'brain',
      role: 'brain',
      label: 'Brain',
      provider: 'claude',
      model: 'sonnet',
      recording: 'recorded',
      tokens: { input: 100, cacheWrite: 0, cacheRead: 0, output: 0, total: 100 },
      byModel: [],
      maxCallInput: 0,
      setup: setup({ setupTokens: 18, arcSetupTokens: 6, work: 82 })
    }
  ],
  suggestions: [],
  updatedAt: 1,
  ...over
})

it('panel shows the session setup share line, and hides it when null', async () => {
  usage.applySession(snap({}))
  const { unmount } = render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(document.querySelector('[data-usage-chip]') as HTMLElement)
  expect(text('[data-setup-share]').replace(/\s+/g, ' ')).toBe(
    "Setup: 18% of this session (Arc's additions about 33% of it)"
  )
  expect(document.querySelector('[data-usage-setup="brain"] [data-setup-split]')).toBeTruthy()
  unmount()
  usage.applySession(snap({ setupShare: null, arcSetupShare: null, updatedAt: 2 }))
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(document.querySelector('[data-usage-chip]') as HTMLElement)
  expect(document.querySelector('[data-setup-share]')).toBeNull()
})
