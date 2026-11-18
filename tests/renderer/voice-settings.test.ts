// @spec: 016-voice-companion
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type { VoiceModelStatus } from '../../src/shared/types/voice'
import SettingsView from '../../src/renderer/src/lib/components/settings/SettingsView.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { voiceModels } from '../../src/renderer/src/lib/stores/voice-models.svelte'
import { nova, PREVIEW_SENTENCE } from '../../src/renderer/src/lib/stores/nova.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import {
  createFakePlayer,
  createFakeTts,
  setEngines,
  type FakePlayer,
  type FakeTts
} from '../../src/renderer/src/lib/nova/engines'
import { mockArc } from './helpers'

let models: VoiceModelStatus[]

const fresh = (state: VoiceModelStatus['state']): VoiceModelStatus[] => [
  { id: 'kokoro', kind: 'tts', state, bytes: 0, totalBytes: 330_000_000 },
  { id: 'zip', kind: 'stt-stream', state, bytes: 0, totalBytes: 40_282_838 },
  { id: 'whisper', kind: 'stt-final', state, bytes: 0, totalBytes: 150_000_000 }
]

function arc(): ReturnType<typeof mockArc> {
  return mockArc((channel) => {
    if (channel === 'voice:models-status') return { ok: true, data: { models } }
    if (channel === 'voice:delete-models') {
      models = fresh('missing')
      return { ok: true, data: {} }
    }
    return { ok: true, data: {} }
  })
}

async function open(): Promise<void> {
  ui.openSettings('voice')
  render(SettingsView)
  await screen.findByRole('heading', { name: 'Voice' })
}

const calls = (invoke: ReturnType<typeof mockArc>, channel: string): number =>
  invoke.mock.calls.filter((c) => c[0] === channel).length

beforeEach(() => {
  models = fresh('missing')
  voiceModels.seed([])
})
afterEach(() => {
  cleanup()
  setEngines()
  settings.reset()
})

it('lists the three models with size and state, and the rounded total', async () => {
  arc()
  await open()
  const row = await waitFor(() => {
    const r = document.querySelector('[data-voice-model="kokoro"]') as HTMLElement
    expect(r).toBeTruthy()
    return r
  })
  expect(within(row).getByText("Nova's voice")).toBeTruthy()
  expect(row.textContent).toContain('330 MB · Not downloaded')
  expect(screen.getByText('Live words')).toBeTruthy()
  expect(screen.getByText('Speech recognition')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Download voice models (about 520 MB)' })).toBeTruthy()
})

it('downloads only after the confirm, and Cancel starts nothing', async () => {
  const invoke = arc()
  await open()
  const button = await screen.findByRole('button', { name: /Download voice models/ })
  await fireEvent.click(button)
  expect(
    screen.getByText('Arc will download about 520 MB of voice models once. They stay on this Mac.')
  ).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(calls(invoke, 'voice:download-models')).toBe(0)
  await fireEvent.click(screen.getByRole('button', { name: /Download voice models/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await waitFor(() => expect(calls(invoke, 'voice:download-models')).toBe(1))
})

it('shows overall and per-row progress from voice:model-progress events', async () => {
  arc()
  await open()
  await fireEvent.click(await screen.findByRole('button', { name: /Download voice models/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  voiceModels.handleProgress({
    id: 'kokoro',
    receivedBytes: 165_000_000,
    totalBytes: 330_000_000,
    state: 'downloading'
  })
  await waitFor(() => {
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('31')
  })
  const row = document.querySelector('[data-voice-model="kokoro"]') as HTMLElement
  expect(row.textContent).toContain('Downloading 50%')
})

it('offers Retry after an offline failure and downloads again', async () => {
  const invoke = arc()
  await open()
  await fireEvent.click(await screen.findByRole('button', { name: /Download voice models/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  voiceModels.handleProgress({
    id: 'kokoro',
    receivedBytes: 0,
    totalBytes: 330_000_000,
    state: 'failed'
  })
  voiceModels.handleError({ code: 'offline' })
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(
    "Couldn't download the voice models. Check your connection and try again."
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(calls(invoke, 'voice:download-models')).toBe(2))
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['offline', 'model-corrupt'] as const)(
  'hides the progress bar after a %s failure and shows it again on Retry',
  async (code) => {
    arc()
    await open()
    await fireEvent.click(await screen.findByRole('button', { name: /Download voice models/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    voiceModels.handleProgress({
      id: 'kokoro',
      receivedBytes: 62_700_000,
      totalBytes: 330_000_000,
      state: 'downloading'
    })
    expect(await screen.findByRole('progressbar')).toBeTruthy()
    voiceModels.handleError({ code })
    await screen.findByRole('alert')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.body.textContent).not.toContain('Downloading voice models')
    expect(voiceModels.isDownloading).toBe(false)
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('progressbar')).toBeTruthy()
  }
)

it('shows the corrupt-model message', async () => {
  arc()
  await open()
  await screen.findByRole('button', { name: /Download voice models/ })
  voiceModels.handleError({ code: 'model-corrupt' })
  expect((await screen.findByRole('alert')).textContent).toContain(
    "A voice model didn't download correctly. Try again."
  )
})

it('deletes after a confirm and returns the rows to Not downloaded', async () => {
  models = fresh('ready')
  const invoke = arc()
  await open()
  const del = await screen.findByRole('button', { name: 'Delete voice models' })
  expect(document.querySelector('[data-voice-model="kokoro"]')?.textContent).toContain('Ready')
  await fireEvent.click(del)
  expect(calls(invoke, 'voice:delete-models')).toBe(0)
  await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() =>
    expect(document.querySelector('[data-voice-model="kokoro"]')?.textContent).toContain(
      'Not downloaded'
    )
  )
  expect(calls(invoke, 'voice:delete-models')).toBe(1)
})

describe('voice choices and Preview', () => {
  let stored: Record<string, unknown>
  let tts: FakeTts
  let player: FakePlayer
  let invoke: ReturnType<typeof mockArc>

  beforeEach(() => {
    stored = {
      'voice.voiceId': 'af_heart',
      'voice.speed': 1,
      'voice.speakPolicy': 'all',
      'voice.muted': false
    }
    tts = createFakeTts()
    player = createFakePlayer()
    setEngines({ tts, player })
    settings.reset()
    invoke = mockArc((channel, request) => {
      if (channel === 'voice:models-status') return { ok: true, data: { models } }
      if (channel === 'settings:get') return { ok: true, data: { ...stored } }
      if (channel === 'settings:set') {
        Object.assign(stored, request as object)
        return { ok: true, data: { ...stored } }
      }
      return { ok: true, data: {} }
    })
  })

  it('offers the six voices with friendly names and saves the choice', async () => {
    models = fresh('ready')
    await open()
    const select = (await screen.findByRole('combobox', { name: 'Voice' })) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'af_heart',
      'af_bella',
      'af_nicole',
      'am_michael',
      'bf_emma',
      'bm_george'
    ])
    expect(select.options[0]?.textContent).toBe('Heart (American, female)')
    await fireEvent.change(select, { target: { value: 'bf_emma' } })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'voice.voiceId': 'bf_emma' })
    )
  })

  it('saves the speed from a 0.7 to 1.3 slider when it is released', async () => {
    models = fresh('ready')
    await open()
    const slider = (await screen.findByLabelText(/Speed/)) as HTMLInputElement
    expect([slider.min, slider.max, slider.step]).toEqual(['0.7', '1.3', '0.05'])
    await fireEvent.input(slider, { target: { value: '1.15' } })
    expect(document.querySelector('[data-voice-speed-value]')?.textContent).toBe('1.15x')
    await fireEvent.change(slider, { target: { value: '1.15' } })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'voice.speed': 1.15 })
    )
  })

  it('saves the speak policy', async () => {
    models = fresh('ready')
    await open()
    const only = await screen.findByLabelText('Only answers to spoken questions')
    expect((screen.getByLabelText('Speak every answer') as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(only)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'voice.speakPolicy': 'spoken-only' })
    )
  })

  it('offers Short, Normal and Long pauses before Nova answers, Normal by default, and saves the choice', async () => {
    models = fresh('ready')
    await open()
    expect(await screen.findByText('Pause before Nova answers')).toBeTruthy()
    expect(screen.getByText('Nova waits longer when you stop mid-sentence.')).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByLabelText('Normal') as HTMLInputElement).checked).toBe(true)
    )
    await fireEvent.click(screen.getByLabelText('Long'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'voice.endPauseMs': 1500 })
    )
    await fireEvent.click(screen.getByLabelText('Short'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { 'voice.endPauseMs': 700 })
    )
  })

  it('disables Preview until the voice model is ready', async () => {
    await open()
    const preview = await screen.findByRole('button', { name: 'Preview' })
    expect((preview as HTMLButtonElement).disabled).toBe(true)
    voiceModels.handleProgress({ id: 'kokoro', receivedBytes: 1, totalBytes: 1, state: 'ready' })
    await waitFor(() => expect((preview as HTMLButtonElement).disabled).toBe(false))
  })

  it('Preview speaks the sample sentence with the chosen voice and speed', async () => {
    models = fresh('ready')
    stored['voice.voiceId'] = 'bm_george'
    stored['voice.speed'] = 1.2
    await open()
    const preview = await screen.findByRole('button', { name: 'Preview' })
    await waitFor(() => expect((preview as HTMLButtonElement).disabled).toBe(false))
    await waitFor(() => expect(settings.values?.['voice.voiceId']).toBe('bm_george'))
    await fireEvent.click(preview)
    await waitFor(() =>
      expect(tts.calls).toEqual([{ sentence: PREVIEW_SENTENCE, voiceId: 'bm_george', speed: 1.2 }])
    )
    expect(nova.previewing).toBe(true)
    player.finishAll()
    await waitFor(() => expect(nova.previewing).toBe(false))
  })
})
