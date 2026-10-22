import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { BypassReport } from '../../src/shared/types/provider'
import PermissionCard from '../../src/renderer/src/lib/components/ui/attention/PermissionCard.svelte'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { mockHarness } from './helpers'

afterEach(cleanup)

const handlers = { onApprove: () => {}, onDeny: () => {}, onAlwaysAllow: () => {} }

it('shows the server, the tool and the arguments of an MCP call', () => {
  render(PermissionCard, {
    id: 'm1',
    from: 'W1',
    action: 'mcp__claude_ai_Figma__use_figma {"fileKey":"abc"}',
    tool: {
      kind: 'mcp',
      server: 'claude_ai_Figma',
      tool: 'use_figma',
      args: { fileKey: 'abc' }
    },
    ...handlers
  })
  expect(document.querySelector('[data-mcp-server]')!.textContent).toBe('claude_ai_Figma')
  expect(document.querySelector('[data-mcp-tool]')!.textContent).toBe('use_figma')
  expect(document.querySelector('[data-mcp-args]')!.textContent).toContain('"fileKey": "abc"')
  expect(screen.queryByText(/mcp__claude_ai_Figma__use_figma/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Always allow this in this session' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Show/ })).toBeNull()
})

it('truncates long arguments behind a show-more control', async () => {
  render(PermissionCard, {
    id: 'm2',
    from: 'W1',
    action: 'x',
    tool: { kind: 'mcp', server: 's', tool: 't', args: { body: 'z'.repeat(1500) } },
    ...handlers
  })
  const args = document.querySelector('[data-mcp-args]')!
  expect(args.textContent!.length).toBeLessThan(600)
  await fireEvent.click(screen.getByRole('button', { name: 'Show all arguments' }))
  expect(args.textContent).toContain('z'.repeat(1500))
  await fireEvent.click(screen.getByRole('button', { name: 'Show fewer arguments' }))
  expect(args.textContent!.length).toBeLessThan(600)
})

it('says so when an MCP call has no arguments', () => {
  render(PermissionCard, {
    id: 'm3',
    from: 'W1',
    action: 'x',
    tool: { kind: 'mcp', server: 's', tool: 't', args: {} },
    ...handlers
  })
  expect(document.querySelector('[data-mcp-args-empty]')).toBeTruthy()
})

it('shows the reason and the requested access of a permissions request, with no Always allow', () => {
  render(PermissionCard, {
    id: 'c1',
    from: 'W2',
    action: 'Extra access: cache',
    tool: {
      kind: 'permissions',
      reason: 'Needs the build cache',
      read: ['/cache'],
      write: ['/out'],
      network: true
    },
    ...handlers
  })
  expect(document.querySelector('[data-access-reason]')!.textContent).toBe('Needs the build cache')
  expect(screen.getByRole('list', { name: 'Paths to read' }).textContent).toContain('/cache')
  expect(screen.getByRole('list', { name: 'Paths to write' }).textContent).toContain('/out')
  expect(document.querySelector('[data-access-network]')!.textContent).toContain('network')
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
})

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
  invoke = mockHarness((channel) =>
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
