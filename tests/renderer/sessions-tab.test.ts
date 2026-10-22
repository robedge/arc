import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionsTab from '../../src/renderer/src/lib/components/sessions/SessionsTab.svelte'
import CliBanner from '../../src/renderer/src/lib/components/sessions/CliBanner.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import type { CliStatus } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const MISSING =
  "Claude Code isn't installed. Install it from claude.com/claude-code, then click Retry."
const SIGNED_OUT =
  "Claude Code isn't signed in. Open Terminal, run claude, and sign in, then click Retry."
const ERROR = "Couldn't check Claude Code. Click Retry. Details are in the logs."

beforeEach(() => {
  providers.reset()
  mockHarness(() => ({ ok: true, data: { state: 'ok', message: '' } }))
})
afterEach(cleanup)

it('SessionsTab shows the empty state and a disabled New Session button', () => {
  render(SessionsTab)
  expect(
    screen.getByText('No sessions yet. Start one to ask the brain about this group.')
  ).toBeTruthy()
  expect((screen.getByRole('button', { name: 'New Session' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  expect(screen.getByRole('tabpanel', { name: 'Sessions' })).toBeTruthy()
})

it.each([
  ['missing', MISSING],
  ['signed_out', SIGNED_OUT],
  ['error', ERROR]
] as const)('CliBanner shows the %s text', (state, message) => {
  providers.set({ claude: { provider: 'claude', checkedAt: 1, state, message } })
  render(CliBanner)
  expect(screen.getByText(message)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})

it('CliBanner renders nothing when ok or unknown', () => {
  providers.set({
    claude: { provider: 'claude', checkedAt: 1, state: 'ok', version: '1.0.0', message: '' }
  })
  const { container } = render(CliBanner)
  expect(container.querySelector('[data-kind]')).toBeNull()
  providers.reset()
  expect(container.querySelector('[data-kind]')).toBeNull()
})

it('Retry invokes providers:check, shows busy, then updates from the result', async () => {
  let resolve!: (v: unknown) => void
  const invoke = mockHarness(() => new Promise((r) => (resolve = r)) as never)
  providers.set({
    claude: { provider: 'claude', checkedAt: 1, state: 'missing', message: MISSING }
  })
  render(CliBanner)
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(invoke).toHaveBeenCalledWith('providers:check', { provider: 'claude' })
  expect(screen.getByRole('button', { name: 'Retry' }).getAttribute('aria-busy')).toBe('true')
  const next: CliStatus = { state: 'signed_out', message: SIGNED_OUT }
  resolve({ ok: true, data: { claude: { provider: 'claude', checkedAt: 1, ...next } } })
  await waitFor(() => expect(screen.getByText(SIGNED_OUT)).toBeTruthy())
  expect(screen.queryByText(MISSING)).toBeNull()
})
