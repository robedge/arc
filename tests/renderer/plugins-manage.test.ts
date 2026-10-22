import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import PluginsSettings from '../../src/renderer/src/lib/components/settings/PluginsSettings.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { plugins } from '../../src/renderer/src/lib/stores/plugins.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import type { PluginRow as Row } from '../../src/shared/types/plugins'
import { mockHarness } from './helpers'

const row = (over: Partial<Row> = {}): Row => ({
  id: 'superpowers@market',
  name: 'superpowers',
  marketplace: 'market',
  version: '5.0.7',
  description: 'Skills for planning',
  enabled: true,
  counts: { commands: 5, skills: 2, agents: 1 },
  hasMcp: false,
  hasHooks: false,
  ...over
})

let rows: Row[]
let reply: (channel: string) => unknown
let invoke: ReturnType<typeof mockHarness>

const calls = (channel: string): unknown[] =>
  invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

beforeEach(() => {
  rows = [row()]
  reply = () => ({ ok: true, data: { opId: 'op1' } })
  invoke = mockHarness((channel) =>
    channel === 'plugins:list' ? ({ ok: true, data: rows } as never) : (reply(channel) as never)
  )
  plugins.reset()
  providers.reset()
  toasts.list = []
})
afterEach(cleanup)

async function openRemoveDialog(): Promise<void> {
  render(PluginsSettings)
  await fireEvent.click(await screen.findByRole('button', { name: 'Remove superpowers' }))
}

it('Remove asks with the exact confirm text', async () => {
  await openRemoveDialog()
  expect(
    screen.getByText('Remove superpowers? Its commands stop working in Arc and in Claude Code.')
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
})

it('Cancel closes the dialog and removes nothing', async () => {
  await openRemoveDialog()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(calls('plugins:uninstall')).toHaveLength(0)
})

it('confirming sends the uninstall for that plugin', async () => {
  await openRemoveDialog()
  const dialog = screen.getByRole('dialog')
  await fireEvent.click(dialog.querySelector('button[type="submit"]')!)
  await waitFor(() => expect(calls('plugins:uninstall')).toEqual([{ id: 'superpowers@market' }]))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('install sends the name and marketplace, shows progress, then clears on done', async () => {
  render(PluginsSettings)
  await screen.findByText('superpowers')
  const name = screen.getByLabelText('Plugin name') as HTMLInputElement
  await fireEvent.input(name, { target: { value: 'tools' } })
  await fireEvent.input(screen.getByLabelText('Marketplace (optional)'), {
    target: { value: 'market' }
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() =>
    expect(calls('plugins:install')).toEqual([{ name: 'tools', marketplace: 'market' }])
  )
  expect(document.querySelector('[data-install-status]')!.textContent).toContain(
    'Installing tools…'
  )
  expect(screen.getByRole('button', { name: 'Install' }).getAttribute('aria-busy')).toBe('true')

  plugins.handleProgress({ opId: 'op1', kind: 'install', target: 'tools', state: 'done' })
  await waitFor(() => expect(name.value).toBe(''))
  expect((screen.getByLabelText('Marketplace (optional)') as HTMLInputElement).value).toBe('')
  expect(document.querySelector('[data-install-status]')!.textContent!.trim()).toBe('')
})

it('install without a name asks for one and sends nothing', async () => {
  render(PluginsSettings)
  await screen.findByText('superpowers')
  await fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  expect(screen.getByText('Enter a plugin name.')).toBeTruthy()
  expect(calls('plugins:install')).toHaveLength(0)
})

it('a failed change shows the CLI message verbatim above the list and leaves the list alone', async () => {
  render(PluginsSettings)
  await screen.findByText('superpowers')
  await fireEvent.input(screen.getByLabelText('Plugin name'), { target: { value: 'nope' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() => expect(calls('plugins:install')).toHaveLength(1))
  const message = 'Plugin "nope" not found\n  in any marketplace'
  plugins.handleProgress({
    opId: 'op1',
    kind: 'install',
    target: 'nope',
    state: 'failed',
    message
  })
  const block = await waitFor(() => {
    const el = document.querySelector('[data-plugin-failure]')
    expect(el).toBeTruthy()
    return el!
  })
  expect(block.textContent).toBe(message)
  expect(block.className).toContain('font-mono')
  expect(
    block.compareDocumentPosition(screen.getByRole('list', { name: 'Installed plugins' }))
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(calls('plugins:list')).toHaveLength(1)
  expect(screen.getByText('superpowers')).toBeTruthy()
  // Cleared by the next action.
  await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  await waitFor(() => expect(document.querySelector('[data-plugin-failure]')).toBeNull())
})

it('every other action is disabled while a change runs', async () => {
  rows = [row({ updateAvailable: '5.1.0' }), row({ id: 'b@market', name: 'b' })]
  render(PluginsSettings)
  await screen.findByRole('button', { name: 'Update superpowers' })
  plugins.handleProgress({ opId: 'x', kind: 'update', target: 'b@market', state: 'running' })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  )
  for (const name of ['Update superpowers', 'Remove superpowers', 'Check for updates']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  }
  expect(screen.getByRole('button', { name: 'Remove b' }).getAttribute('aria-busy')).toBeNull()
  expect(document.querySelector('[data-plugin-status]')!.textContent).toContain('Updating b…')
})

it('Claude Code being unavailable disables install, update, remove and check', async () => {
  providers.set({
    claude: {
      provider: 'claude',
      checkedAt: 1,
      state: 'signed_out',
      message: "Claude Code isn't signed in."
    }
  })
  rows = [row({ updateAvailable: '5.1.0' })]
  render(PluginsSettings)
  await screen.findByRole('button', { name: 'Update superpowers' })
  for (const name of ['Install', 'Update superpowers', 'Remove superpowers', 'Check for updates']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  }
})

it('Check for updates runs, then a new Update available shows after the list reloads', async () => {
  render(PluginsSettings)
  await screen.findByText('superpowers')
  await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  await waitFor(() => expect(calls('plugins:check-updates')).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'Check for updates' }).getAttribute('aria-busy')).toBe(
    'true'
  )
  expect(document.querySelector('[data-plugin-status]')!.textContent).toContain(
    'Checking for updates…'
  )
  rows = [row({ updateAvailable: '5.1.0' })]
  plugins.handleProgress({ opId: 'op1', kind: 'check-updates', target: '', state: 'done' })
  await plugins.load(true)
  expect(await screen.findByText('Update available: 5.1.0')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Check for updates' }).getAttribute('aria-busy')).toBe(
    null
  )
})

it('Update on a flagged row sends the update; every other row offers it in a menu', async () => {
  rows = [row({ updateAvailable: '5.1.0' }), row({ id: 'b@market', name: 'b' })]
  render(PluginsSettings)
  await fireEvent.click(await screen.findByRole('button', { name: 'Update superpowers' }))
  await waitFor(() => expect(calls('plugins:update')).toEqual([{ id: 'superpowers@market' }]))
  plugins.handleProgress({
    opId: 'op1',
    kind: 'update',
    target: 'superpowers@market',
    state: 'done'
  })
  await fireEvent.click(screen.getByRole('button', { name: 'More actions for b' }))
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
  await waitFor(() => expect(calls('plugins:update')).toHaveLength(2))
  expect(calls('plugins:update')[1]).toEqual({ id: 'b@market' })
})

it('PLUGIN_BUSY shows a toast and no failure block', async () => {
  reply = () => ({ ok: false, error: { code: 'PLUGIN_BUSY' } })
  render(PluginsSettings)
  await fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  await waitFor(() =>
    expect(toasts.list.map((t) => t.message)).toContain('Another plugin change is in progress.')
  )
  expect(document.querySelector('[data-plugin-failure]')).toBeNull()
  expect(plugins.op).toBeNull()
})

it('a refused start shows the CLI reason verbatim', async () => {
  reply = () => ({ ok: false, error: { code: 'PLUGIN_FAILED', details: { reason: 'bad: input' } } })
  render(PluginsSettings)
  await fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  await waitFor(() =>
    expect(document.querySelector('[data-plugin-failure]')!.textContent).toBe('bad: input')
  )
  vi.restoreAllMocks()
})
