import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { BypassReport } from '../../src/shared/types/provider'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { mockArc } from './helpers'

afterEach(cleanup)

const report = (patch: Partial<BypassReport> = {}): BypassReport => ({
  claudeHookEvents: [],
  codexAllowPrefixes: [],
  codexRulesCovered: 0,
  ...patch
})

let current: BypassReport
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  current = report()
  providers.reset()
  invoke = mockArc((channel) =>
    channel === 'providers:bypass'
      ? ({ ok: true, data: current } as never)
      : ({ ok: true, data: {} } as never)
  )
})

const title = "Your hooks and Codex rules can skip Arc's approvals"

it('shows nothing on the Providers page when the report is empty', async () => {
  render(ProvidersSettings)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('providers:bypass', {}))
  await new Promise((r) => setTimeout(r, 0))
  expect(screen.queryByText(title)).toBeNull()
  expect(document.querySelector('[data-bypass-warning]')).toBeNull()
})

it('lists the hook events and prefixes, and how many rules Arc covers', async () => {
  current = report({
    claudeHookEvents: ['PreToolUse'],
    codexAllowPrefixes: ['git commit', 'git merge'],
    codexRulesCovered: 7
  })
  render(ProvidersSettings)
  const region = await screen.findByRole('region', { name: title })
  expect(region.textContent).toContain('PreToolUse')
  expect(region.textContent).toContain('git commit')
  expect(region.textContent).toContain('git merge')
  expect(document.querySelector('[data-bypass-covered]')!.textContent).toContain(
    "Arc's own rules already cover 7 of your Codex allow rules."
  )
})

it('keeps 26 prefixes in a wrapping list', async () => {
  current = report({
    codexAllowPrefixes: Array.from({ length: 26 }, (_, i) => `tool-${i} run`)
  })
  render(ProvidersSettings)
  const list = await screen.findByRole('list', { name: 'Codex allow rules Arc does not cover' })
  expect(list.querySelectorAll('li')).toHaveLength(26)
  expect(list.className).toContain('flex-wrap')
})

it('Check again asks main for the report again', async () => {
  render(ProvidersSettings)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('providers:bypass', {}))
  const calls = (): number => invoke.mock.calls.filter((c) => c[0] === 'providers:bypass').length
  expect(screen.queryByText(title)).toBeNull()
  current = report({ claudeHookEvents: ['PermissionRequest'] })
  const before = calls()
  await waitFor(() => expect(providers.bypassBusy).toBe(false))
  await providers.loadBypass()
  expect(calls()).toBe(before + 1)
  const button = await screen.findByRole('button', { name: 'Check hooks and Codex rules again' })
  current = report({ claudeHookEvents: ['PreToolUse'] })
  await fireEvent.click(button)
  await waitFor(() => expect(calls()).toBe(before + 2))
  await waitFor(() =>
    expect(document.querySelector('[data-bypass-hooks]')!.textContent).toContain('PreToolUse')
  )
})
