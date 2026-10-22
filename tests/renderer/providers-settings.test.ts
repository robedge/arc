import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { ProviderStatus, ProviderStatusMap } from '../../src/shared/types/provider'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import SettingsView from '../../src/renderer/src/lib/components/settings/SettingsView.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { mockHarness } from './helpers'

function status(p: Partial<ProviderStatus> & Pick<ProviderStatus, 'provider'>): ProviderStatus {
  return { state: 'ok', message: '', checkedAt: 1, ...p }
}

let initial: ProviderStatusMap
let checkResult: () => Promise<unknown> | unknown

beforeEach(() => {
  initial = {}
  checkResult = () => ({ ok: true, data: {} })
  providers.reset()
  mockHarness((channel) =>
    channel === 'providers:get' ? ({ ok: true, data: initial } as never) : (checkResult() as never)
  )
})
afterEach(cleanup)

const text = (provider: string): string =>
  document.querySelector(`[data-provider="${provider}"] [data-provider-status]`)!.textContent!

it('shows signed in for both providers with versions and no command', async () => {
  initial = {
    claude: status({ provider: 'claude', version: '2.1.302' }),
    codex: status({ provider: 'codex', version: '0.162.1', account: { kind: 'chatgpt' } })
  }
  render(ProvidersSettings)
  await waitFor(() => expect(text('codex')).toBe('Codex · signed in'))
  expect(text('claude')).toBe('Claude · signed in')
  expect(screen.getByText('0.162.1')).toBeTruthy()
  expect(document.querySelector('[data-provider-command]')).toBeNull()
})

it('shows the message and login command for a signed-out Codex', async () => {
  initial = {
    codex: status({
      provider: 'codex',
      state: 'signed_out',
      message: "Codex isn't signed in.",
      loginCommand: 'codex login'
    })
  }
  render(ProvidersSettings)
  await waitFor(() => expect(text('codex')).toBe('Codex · not signed in'))
  expect(screen.getByText("Codex isn't signed in.")).toBeTruthy()
  expect(document.querySelector('[data-provider-command]')!.textContent).toBe('codex login')
})

it.each([
  ['missing', 'Codex · not installed'],
  ['unsupported', 'Codex · needs an update'],
  ['error', 'Codex · could not check']
] as const)('labels the %s state', async (state, label) => {
  initial = { codex: status({ provider: 'codex', state, message: 'Details.' }) }
  render(ProvidersSettings)
  await waitFor(() => expect(text('codex')).toBe(label))
  expect(screen.getByText('Details.')).toBeTruthy()
})

it('labels an API key account as not the subscription', async () => {
  initial = { codex: status({ provider: 'codex', account: { kind: 'api_key' } }) }
  render(ProvidersSettings)
  await waitFor(() => expect(text('codex')).toBe('Codex · API key (not your subscription)'))
})

it('says checking before the first result', () => {
  render(ProvidersSettings)
  expect(text('codex')).toBe('Codex · checking…')
})

it('copy writes the command to the clipboard and confirms', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  initial = {
    codex: status({
      provider: 'codex',
      state: 'signed_out',
      message: 'x',
      loginCommand: 'codex login'
    })
  }
  render(ProvidersSettings)
  await fireEvent.click(await screen.findByRole('button', { name: 'Copy codex login' }))
  expect(writeText).toHaveBeenCalledWith('codex login')
  await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
})

it('a failing clipboard shows a fallback hint instead of throwing', async () => {
  const writeText = vi.fn(async () => {
    throw new Error('denied')
  })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  initial = {
    codex: status({
      provider: 'codex',
      state: 'signed_out',
      message: 'x',
      loginCommand: 'codex login'
    })
  }
  render(ProvidersSettings)
  await fireEvent.click(await screen.findByRole('button', { name: 'Copy codex login' }))
  await waitFor(() => expect(screen.getByText('Select the command and copy it.')).toBeTruthy())
})

it('Check again invokes providers:check for that provider and shows the result', async () => {
  initial = {
    codex: status({
      provider: 'codex',
      state: 'signed_out',
      message: 'x',
      loginCommand: 'codex login'
    })
  }
  const invoke = mockHarness((channel) =>
    channel === 'providers:get'
      ? ({ ok: true, data: initial } as never)
      : ({ ok: true, data: { codex: status({ provider: 'codex' }) } } as never)
  )
  render(ProvidersSettings)
  await waitFor(() => expect(text('codex')).toBe('Codex · not signed in'))
  await fireEvent.click(screen.getByRole('button', { name: 'Check Codex again' }))
  expect(invoke).toHaveBeenCalledWith('providers:check', { provider: 'codex' })
  await waitFor(() => expect(text('codex')).toBe('Codex · signed in'))
})

it('the row is busy while checking and other rows are not', async () => {
  let resolve!: (v: unknown) => void
  checkResult = () => new Promise((r) => (resolve = r))
  render(ProvidersSettings)
  await fireEvent.click(screen.getByRole('button', { name: 'Check Codex again' }))
  expect(screen.getByRole('button', { name: 'Check Codex again' }).getAttribute('aria-busy')).toBe(
    'true'
  )
  expect(
    screen.getByRole('button', { name: 'Check Claude again' }).getAttribute('aria-busy')
  ).toBeNull()
  resolve({ ok: true, data: {} })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check Codex again' }).getAttribute('aria-busy')
    ).toBeNull()
  )
})

it('Providers is first in the Settings nav and the default page', async () => {
  ui.openSettings()
  render(SettingsView)
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  const items = Array.from(nav.querySelectorAll('li button')).map((b) => b.textContent)
  expect(items).toEqual(['Providers', 'Plugins', 'Agent loading'])
  expect(screen.getByRole('button', { name: 'Providers' }).getAttribute('aria-current')).toBe(
    'page'
  )
  expect(screen.getByRole('heading', { name: 'Providers' })).toBeTruthy()
})

it('shows a Cursor row third, with its intro copy', async () => {
  initial = { cursor: status({ provider: 'cursor', version: '2026.10.19-6bbf2c4' }) }
  render(ProvidersSettings)
  await waitFor(() => expect(text('cursor')).toBe('Cursor · signed in'))
  const ids = Array.from(document.querySelectorAll('[data-provider]')).map((e) =>
    e.getAttribute('data-provider')
  )
  expect(ids).toEqual(['claude', 'codex', 'cursor'])
  expect(screen.getByText('2026.10.19-6bbf2c4')).toBeTruthy()
  expect(screen.getByText(/Claude, Codex and Cursor tools/)).toBeTruthy()
})

it.each([
  ['signed_out', 'Cursor · not signed in', 'agent login'],
  ['missing', 'Cursor · not installed', undefined],
  ['unsupported', 'Cursor · needs an update', undefined],
  ['error', 'Cursor · could not check', undefined]
] as const)('labels the Cursor %s state', async (state, label, command) => {
  initial = {
    cursor: status({
      provider: 'cursor',
      state,
      message: 'Details.',
      ...(command ? { loginCommand: command } : {})
    })
  }
  render(ProvidersSettings)
  await waitFor(() => expect(text('cursor')).toBe(label))
  expect(screen.getByText('Details.')).toBeTruthy()
  const shown = document.querySelector('[data-provider="cursor"] [data-provider-command]')
  expect(shown?.textContent ?? undefined).toBe(command)
})

it('Check Cursor again checks only Cursor', async () => {
  const invoke = mockHarness((channel) =>
    channel === 'providers:get' || channel === 'providers:bypass'
      ? ({ ok: true, data: {} } as never)
      : ({ ok: true, data: { cursor: status({ provider: 'cursor' }) } } as never)
  )
  render(ProvidersSettings)
  await fireEvent.click(screen.getByRole('button', { name: 'Check Cursor again' }))
  expect(invoke).toHaveBeenCalledWith('providers:check', { provider: 'cursor' })
  await waitFor(() => expect(text('cursor')).toBe('Cursor · signed in'))
})
