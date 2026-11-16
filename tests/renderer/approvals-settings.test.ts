// @spec: 015-skip-all-approvals
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type { AppSettings } from '../../src/shared/types/provider'
import SettingsView from '../../src/renderer/src/lib/components/settings/SettingsView.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockArc } from './helpers'

const LABEL = 'Skip all approvals by default'

let stored: AppSettings

function arc(): ReturnType<typeof mockArc> {
  return mockArc((channel, req) => {
    if (channel === 'settings:get') return { ok: true, data: stored }
    if (channel === 'settings:set') {
      stored = { ...stored, ...(req as object) }
      return { ok: true, data: stored }
    }
    return { ok: true, data: {} }
  })
}

async function open(): Promise<HTMLInputElement> {
  ui.openSettings('approvals')
  render(SettingsView)
  return (await screen.findByRole('switch', { name: LABEL })) as HTMLInputElement
}

const sets = (invoke: ReturnType<typeof mockArc>): unknown[] =>
  invoke.mock.calls.filter((c) => c[0] === 'settings:set').map((c) => c[1])

beforeEach(() => {
  stored = { 'approvals.skipAllByDefault': false } as unknown as AppSettings
  settings.reset()
})
afterEach(cleanup)

it('lists an Approvals page with the switch off', async () => {
  arc()
  const toggle = await open()
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getByRole('button', { name: 'Approvals' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('heading', { name: 'Approvals' })).toBeTruthy()
  expect(toggle.checked).toBe(false)
})

it('turning on opens the dialog and saves only after confirm', async () => {
  const invoke = arc()
  const toggle = await open()
  await fireEvent.click(toggle)
  expect(screen.getByRole('heading', { name: 'Skip all approvals?' })).toBeTruthy()
  expect(screen.getByText(/^Every new session will start with Skip all approvals on/)).toBeTruthy()
  expect(toggle.checked).toBe(false)
  expect(sets(invoke)).toEqual([])
  await fireEvent.click(screen.getByRole('button', { name: 'Skip all approvals' }))
  await waitFor(() => expect(sets(invoke)).toEqual([{ 'approvals.skipAllByDefault': true }]))
  await waitFor(() => expect(toggle.checked).toBe(true))
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
})

it('Cancel leaves it off and saves nothing', async () => {
  const invoke = arc()
  const toggle = await open()
  await fireEvent.click(toggle)
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  expect(toggle.checked).toBe(false)
  expect(sets(invoke)).toEqual([])
})

it('turning off saves straight away with no dialog', async () => {
  stored = { 'approvals.skipAllByDefault': true } as unknown as AppSettings
  const invoke = arc()
  const toggle = await open()
  await waitFor(() => expect(toggle.checked).toBe(true))
  await fireEvent.click(toggle)
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  await waitFor(() => expect(sets(invoke)).toEqual([{ 'approvals.skipAllByDefault': false }]))
})
