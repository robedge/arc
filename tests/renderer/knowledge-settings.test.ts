import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type { AppSettings } from '../../src/shared/types/provider'
import SettingsView from '../../src/renderer/src/lib/components/settings/SettingsView.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockArc } from './helpers'

const LABEL = 'Suggest knowledge updates'

const values = (on: boolean | undefined): AppSettings =>
  (on === undefined ? {} : { 'knowledge.suggestOnFinish': on }) as unknown as AppSettings

let stored: AppSettings
let failSave: boolean

function arc(): ReturnType<typeof mockArc> {
  return mockArc((channel, req) => {
    if (channel === 'settings:get') return { ok: true, data: stored }
    if (channel === 'settings:set') {
      if (failSave) return { ok: false, error: { code: 'INTERNAL' } }
      stored = { ...stored, ...(req as object) }
      return { ok: true, data: stored }
    }
    return { ok: true, data: {} }
  })
}

async function open(): Promise<HTMLInputElement> {
  ui.openSettings('knowledge')
  render(SettingsView)
  return (await screen.findByRole('switch', { name: LABEL })) as HTMLInputElement
}

beforeEach(() => {
  stored = values(true)
  failSave = false
  settings.reset()
})
afterEach(cleanup)

describe('Knowledge settings', () => {
  it('lists Knowledge after Agent loading and shows heading, switch and help', async () => {
    arc()
    await open()
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
    const labels = nav.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(labels.indexOf('Knowledge')).toBe(labels.indexOf('Agent loading') + 1)
    expect(nav.getByRole('button', { name: 'Knowledge' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { name: 'Knowledge' })).toBeTruthy()
    expect(document.body.textContent?.replace(/\s+/g, ' ')).toContain(
      'When on, the brain may offer new and updated notes after it finishes a request. When off, it suggests only when you ask it in the chat. Suggestions already waiting stay.'
    )
  })

  it('opens from the navigation button', async () => {
    arc()
    ui.openSettings()
    render(SettingsView)
    await fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))
    expect(await screen.findByRole('switch', { name: LABEL })).toBeTruthy()
  })

  it('is on when true or missing, off when false', async () => {
    for (const [value, on] of [
      [true, true],
      [undefined, true],
      [false, false]
    ] as const) {
      stored = values(value)
      settings.reset()
      arc()
      const toggle = await open()
      await waitFor(() => expect(toggle.checked).toBe(on))
      cleanup()
    }
  })

  it('saves false when turned off and true when turned on', async () => {
    const invoke = arc()
    const toggle = await open()
    await fireEvent.click(toggle)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'knowledge.suggestOnFinish': false })
    )
    await fireEvent.click(toggle)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'knowledge.suggestOnFinish': true })
    )
  })

  it('follows a settings:changed push', async () => {
    arc()
    const toggle = await open()
    await waitFor(() => expect(toggle.checked).toBe(true))
    settings.apply(values(false))
    await waitFor(() => expect(toggle.checked).toBe(false))
  })

  it('puts the switch back and shows the error when the save fails', async () => {
    arc()
    const toggle = await open()
    await waitFor(() => expect(toggle.checked).toBe(true))
    failSave = true
    await fireEvent.click(toggle)
    await waitFor(() => expect(toggle.checked).toBe(true))
    expect(settings.error).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('is a named switch reachable by keyboard', async () => {
    arc()
    const toggle = await open()
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.tabIndex).toBeGreaterThanOrEqual(0)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
  })
})
