import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type {
  ProviderModels,
  ProviderStatus,
  ProviderStatusMap
} from '../../src/shared/types/provider'
import App from '../../src/renderer/src/App.svelte'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import { models } from '../../src/renderer/src/lib/stores/models.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'

const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider: 'codex',
  state: 'ok',
  version: '0.162.1',
  message: '',
  checkedAt: 1,
  latestVersion: '0.170.0',
  updateAvailable: true,
  updateCommand: 'codex update',
  ...over
})

const lists = (codex: string[]): ProviderModels => ({
  claude: [],
  cursor: [],
  codex: codex.map((m, i) => ({
    ref: { provider: 'codex', model: m },
    label: m,
    tier: 'deep',
    isDefault: i === 0
  }))
})

let handlers: Record<string, (e: unknown) => void>
let invoke: ReturnType<typeof vi.fn>
let modelData: ProviderModels
let statusData: ProviderStatusMap

beforeEach(() => {
  handlers = {}
  modelData = lists(['gpt-5.5'])
  statusData = {}
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'providers:models') return { ok: true, data: modelData }
    if (channel === 'providers:get') return { ok: true, data: statusData }
    if (channel === 'providers:dismiss-update') return { ok: true, data: statusData }
    if (channel === 'plan:get') return { ok: true, data: { plans: [], notices: [] } }
    return { ok: true, data: [] }
  })
  Object.defineProperty(window, 'harness', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((channel: string, cb: (e: unknown) => void) => {
        handlers[channel] = cb
        return () => {}
      }),
      getPathForFile: vi.fn(() => '')
    }
  })
  providers.reset()
  models.reset()
  ui.view = 'main'
})
afterEach(cleanup)

const push = (map: ProviderStatusMap): void => handlers['providers:changed']!(map)
const calls = (channel: string): number => invoke.mock.calls.filter((c) => c[0] === channel).length

it('the Providers row shows current -> latest with the command, even once dismissed', async () => {
  statusData = { codex: status({ updateDismissed: true }) }
  render(ProvidersSettings)
  await waitFor(() =>
    expect(document.querySelector('[data-provider-update]')!.textContent).toContain(
      'Update available: 0.162.1 → 0.170.0'
    )
  )
  expect(document.querySelector('[data-provider-update-command]')!.textContent).toBe('codex update')
  expect(screen.getByRole('button', { name: 'Copy codex update' })).toBeTruthy()
})

it('shows no update row when none is available', async () => {
  statusData = { codex: status({ updateAvailable: false }) }
  render(ProvidersSettings)
  await waitFor(() => expect(document.querySelector('[data-provider="codex"]')).toBeTruthy())
  expect(document.querySelector('[data-provider-update]')).toBeNull()
})

it('shows one notice per undismissed update, and Dismiss sends the version', async () => {
  render(App)
  push({ codex: status() })
  expect((await screen.findByText(/Codex 0\.170\.0 is available/)).textContent).toContain(
    'codex update'
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss Codex update notice' }))
  expect(invoke).toHaveBeenCalledWith('providers:dismiss-update', {
    provider: 'codex',
    version: '0.170.0'
  })
})

it('hides the notice once the update is dismissed', async () => {
  render(App)
  push({ codex: status({ updateDismissed: true }) })
  await waitFor(() => expect(providers.statuses.codex).toBeTruthy())
  expect(screen.queryByText(/is available/)).toBeNull()
})

it('Open Settings from the notice opens Settings', async () => {
  render(App)
  push({ codex: status() })
  await fireEvent.click(await screen.findByRole('button', { name: 'Open Settings' }))
  expect(ui.view).toBe('settings')
})

it('Restart now relaunches', async () => {
  render(App)
  push({ codex: status({ restartRequired: true, restartReason: 'Codex moved.' }) })
  const dialog = await screen.findByRole('dialog', {
    name: 'Restart Arc to finish updating Codex'
  })
  expect(dialog.textContent).toContain('Codex moved.')
  await fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
  expect(invoke).toHaveBeenCalledWith('app:relaunch', {})
})

it('Later and Escape hide the modal until restart is newly required again', async () => {
  render(App)
  const need = status({ restartRequired: true, restartReason: 'Codex moved.' })
  push({ codex: need })
  await fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  push({ codex: need })
  await waitFor(() => expect(providers.statuses.codex).toBeTruthy())
  expect(screen.queryByRole('dialog')).toBeNull()
  push({ codex: status() })
  push({ codex: need })
  const dialog = await screen.findByRole('dialog')
  await fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(calls('app:relaunch')).toBe(0)
})

it('refetches models on providers:changed so pickers update without a reload', async () => {
  render(App)
  await waitFor(() => expect(models.lists.codex.map((m) => m.label)).toEqual(['gpt-5.5']))
  const before = calls('providers:models')
  modelData = lists(['gpt-5.5', 'gpt-6'])
  push({ codex: status({ updateAvailable: false }) })
  await waitFor(() => expect(models.lists.codex.map((m) => m.label)).toEqual(['gpt-5.5', 'gpt-6']))
  expect(calls('providers:models')).toBe(before + 1)
})
