import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import type { BypassReport } from '../../src/shared/types/provider'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { mockHarness } from './helpers'

const report = (patch: Partial<BypassReport> = {}): BypassReport => ({
  claudeHookEvents: [],
  codexAllowPrefixes: [],
  codexRulesCovered: 0,
  ...patch
})

let current: BypassReport

beforeEach(() => {
  current = report()
  providers.reset()
  mockHarness((channel) =>
    channel === 'providers:bypass'
      ? ({ ok: true, data: current } as never)
      : ({ ok: true, data: {} } as never)
  )
})
afterEach(cleanup)

const title = "Your hooks and Codex rules can skip Arc's approvals"

it('shows one list when the roles agree', async () => {
  current = report({
    claudeHookEvents: ['PreToolUse'],
    claudeHookEventsByRole: { brain: ['PreToolUse'], workers: ['PreToolUse'] }
  })
  render(ProvidersSettings)
  await screen.findByRole('region', { name: title })
  expect(document.querySelector('[data-bypass-hooks]')!.textContent).toContain('PreToolUse')
  expect(document.querySelector('[data-bypass-role]')).toBeNull()
})

it('lists the events for Brain and for Workers separately when they differ', async () => {
  current = report({
    claudeHookEvents: ['PreToolUse'],
    claudeHookEventsByRole: { brain: ['PreToolUse'], workers: [] }
  })
  render(ProvidersSettings)
  await screen.findByRole('region', { name: title })
  const brain = document.querySelector('[data-bypass-role="brain"]')!
  const workers = document.querySelector('[data-bypass-role="workers"]')!
  expect(brain.textContent).toContain('Brain')
  expect(brain.textContent).toContain('PreToolUse')
  expect(workers.textContent).toContain('Workers')
  expect(workers.textContent).toContain('None')
  expect(workers.textContent).not.toContain('PreToolUse')
})

it('shows nothing when the hooks are off for both roles and no Codex rule bypasses', async () => {
  current = report({ claudeHookEventsByRole: { brain: [], workers: [] } })
  render(ProvidersSettings)
  await waitFor(() => expect(providers.bypass).not.toBeNull())
  expect(document.querySelector('[data-bypass-warning]')).toBeNull()
})

it('keeps the report’s by-role lists in the store', async () => {
  current = report({
    claudeHookEvents: ['PermissionRequest'],
    claudeHookEventsByRole: { brain: [], workers: ['PermissionRequest'] }
  })
  await providers.loadBypass()
  expect(providers.bypass?.claudeHookEventsByRole).toEqual({
    brain: [],
    workers: ['PermissionRequest']
  })
})
