import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import App from '../../src/renderer/src/App.svelte'
import PluginsSettings from '../../src/renderer/src/lib/components/settings/PluginsSettings.svelte'
import PluginRow from '../../src/renderer/src/lib/components/settings/PluginRow.svelte'
import { eventStyle } from '../../src/renderer/src/lib/components/sessions/event-kinds'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { plugins } from '../../src/renderer/src/lib/stores/plugins.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { PluginRow as Row } from '../../src/shared/types/plugins'
import { mockHarness } from './helpers'

const row = (over: Partial<Row> = {}): Row => ({
  id: 'superpowers@market',
  name: 'superpowers',
  marketplace: 'market',
  version: '5.0.7',
  description: 'Skills for planning',
  enabled: true,
  source: 'github.com/example/superpowers',
  counts: { commands: 5, skills: 2, agents: 1 },
  hasMcp: false,
  hasHooks: false,
  ...over
})

let list: () => unknown

beforeEach(() => {
  list = () => ({ ok: true, data: [row()] })
  mockHarness((channel) =>
    channel === 'plugins:list'
      ? (list() as never)
      : channel === 'plan:get'
        ? ({ ok: true, data: { plans: [], notices: [] } } as never)
        : ({ ok: true, data: [] } as never)
  )
  plugins.reset()
  providers.reset()
  ui.view = 'main'
})
afterEach(cleanup)

it('gear opens Settings on Providers, then Plugins; Back and Escape return', async () => {
  render(App)
  expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(ui.view).toBe('settings')
  expect(screen.getByRole('button', { name: 'Providers' }).getAttribute('aria-current')).toBe(
    'page'
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
  expect(await screen.findByText('superpowers')).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(ui.view).toBe('main')
  await fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  await fireEvent.keyDown(window, { key: 'Escape' })
  expect(ui.view).toBe('main')
})

it('the gear sits in the title bar outside the drag area', () => {
  render(App)
  const gear = screen.getByRole('button', { name: 'Settings' })
  expect(gear.closest('[data-titlebar]')).toBeTruthy()
  expect(gear.closest('.no-drag')).toBeTruthy()
})

it('a row shows version, source tooltip and counts without zero parts', () => {
  render(PluginRow, { plugin: row() })
  expect(screen.getByText('5.0.7').className).toContain('font-mono')
  expect(screen.getByText('market').getAttribute('title')).toBe('github.com/example/superpowers')
  expect(screen.getByText('5 commands · 2 skills · 1 agent')).toBeTruthy()
})

it('counts omit zero parts and say No commands when all are zero', () => {
  render(PluginRow, { plugin: row({ counts: { commands: 1, skills: 0, agents: 0 } }) })
  expect(screen.getByText('1 command')).toBeTruthy()
  cleanup()
  render(PluginRow, { plugin: row({ counts: { commands: 0, skills: 0, agents: 0 } }) })
  expect(screen.getByText('No commands')).toBeTruthy()
})

it('shows the update badge as text, and no badge for MCP servers or hooks (Arc agents load them)', () => {
  render(PluginRow, { plugin: row({ hasMcp: true, hasHooks: true, updateAvailable: '5.1.0' }) })
  expect(screen.queryByText('MCP server not available in Arc')).toBeNull()
  expect(screen.queryByText('Hooks are not run in Arc')).toBeNull()
  expect(screen.getAllByText(/./, { selector: '[data-badge]' }).map((b) => b.textContent)).toEqual([
    'Update available: 5.1.0'
  ])
})

it('shows no badges for a plain plugin', () => {
  const { container } = render(PluginRow, { plugin: row() })
  expect(container.querySelectorAll('[data-badge]')).toHaveLength(0)
})

it('a disabled plugin is dimmed and says it is turned off in Claude Code', () => {
  const { container } = render(PluginRow, { plugin: row({ enabled: false }) })
  expect(screen.getByText('Turned off in Claude Code')).toBeTruthy()
  expect(container.querySelector('li')!.className).toContain('opacity-60')
})

it('the page carries both notes and the signed-out banner', async () => {
  providers.set({
    claude: {
      provider: 'claude',
      checkedAt: 1,
      state: 'signed_out',
      message: "Claude Code isn't signed in."
    }
  })
  render(PluginsSettings)
  expect(
    screen.getByText(
      'These are the same plugins Claude Code uses in the terminal, so changes here apply there too.'
    )
  ).toBeTruthy()
  expect(screen.getByText('Changes apply to agents started afterwards.')).toBeTruthy()
  expect(screen.getByText("Claude Code isn't signed in.")).toBeTruthy()
  await screen.findByText('superpowers')
})

it('has loading and empty states', async () => {
  list = () => ({ ok: true, data: [] })
  render(PluginsSettings)
  expect(screen.getByText('Loading plugins…')).toBeTruthy()
  expect(await screen.findByText('No plugins installed')).toBeTruthy()
})

it('an error shows the CLI message verbatim in mono', async () => {
  list = () => ({
    ok: false,
    error: { code: 'PLUGIN_FAILED', details: { reason: 'boom: bad\n  manifest' } }
  })
  render(PluginsSettings)
  await waitFor(() => expect(document.querySelector('[data-plugin-error]')).toBeTruthy())
  const el = document.querySelector('[data-plugin-error]')!
  expect(el.textContent).toBe('boom: bad\n  manifest')
  expect(el.className).toContain('font-mono')
  expect(within(document.body).getByText("Couldn't load your plugins.")).toBeTruthy()
})

it('repo-settings events have an info style', () => {
  const style = eventStyle('repo-settings')
  expect(style?.icon).toBe('info')
  expect(style?.label).toBe('Repository settings')
})
