// @spec: 016-voice-companion
import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { nova } from '../../src/renderer/src/lib/stores/nova.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { voiceModels } from '../../src/renderer/src/lib/stores/voice-models.svelte'
import {
  createFakePlayer,
  createFakeTts,
  setEngines,
  type FakePlayer,
  type FakeTts
} from '../../src/renderer/src/lib/nova/engines'
import type {
  SessionHeader as Header,
  SessionMessage,
  SessionSnapshot
} from '../../src/shared/types/session'
import { mockArc } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  skipApprovals: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

const snapshot = (id: string): SessionSnapshot => ({
  header: { ...header, id },
  messages: [],
  events: [],
  workers: [],
  plan: null,
  attention: [],
  knowledgeSuggestions: [],
  brainState: 'idle',
  changedFileCount: 0,
  seq: 0
})

let stored: Record<string, unknown>
let tts: FakeTts
let player: FakePlayer
let invoke: ReturnType<typeof mockArc>
let nextId: number

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
  nextId = 1
  settings.reset()
  voiceModels.seed([])
  invoke = mockArc((channel, request) => {
    if (channel === 'sessions:open') {
      return { ok: true, data: snapshot((request as { sessionId: string }).sessionId) }
    }
    if (channel === 'settings:get') return { ok: true, data: { ...stored } }
    if (channel === 'settings:set') {
      Object.assign(stored, request as object)
      return { ok: true, data: { ...stored } }
    }
    if (channel === 'voice:models-status') {
      return {
        ok: true,
        data: {
          fake: true,
          models: [{ id: 'kokoro', kind: 'tts', state: 'ready', bytes: 1, totalBytes: 1 }]
        }
      }
    }
    return { ok: true, data: {} }
  })
})
afterEach(() => {
  cleanup()
  activeSession.close()
  nova.close()
  setEngines()
})

async function openPanel(): Promise<void> {
  await activeSession.open('s1')
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  await waitFor(() => expect(voiceModels.ttsReady).toBe(true))
  await waitFor(() => expect(settings.values).not.toBeNull())
  await tick()
}

const novaState = (): string | null =>
  document.querySelector('[data-nova-state]')?.getAttribute('data-nova-state') ?? null

function brainMessage(content: string): SessionMessage {
  return {
    id: nextId++,
    sessionId: 's1',
    role: 'brain',
    content,
    state: 'complete',
    planId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

/** The brain starts a turn, then ends it at `end` with these finished messages. */
async function brainTurn(contents: string[], end: 'idle' | 'waiting' = 'idle'): Promise<void> {
  activeSession.brainState = 'thinking'
  await tick()
  activeSession.messages = [...activeSession.messages, ...contents.map(brainMessage)]
  activeSession.brainState = end
  await tick()
}

/** Lets every queued sentence finish playing. */
async function playOut(): Promise<void> {
  await waitFor(() => {
    player.finishAll()
    expect(novaState()).toBe('idle')
  })
}

it('shows Thinking, then Speaking with the short answer, then Idle', async () => {
  await openPanel()
  activeSession.brainState = 'thinking'
  await tick()
  expect(novaState()).toBe('thinking')
  activeSession.messages = [
    brainMessage('The sync bug is fixed.\n\n```ts\nconst x = 1\n```\n\nAll tests pass.')
  ]
  activeSession.brainState = 'idle'
  await tick()
  await waitFor(() => expect(novaState()).toBe('speaking'))
  expect(document.querySelector('[data-nova-state]')?.textContent?.trim()).toBe('Speaking')
  await waitFor(() => expect(tts.sentences.length).toBeGreaterThan(0))
  await playOut()
  expect(tts.sentences).toEqual([
    'The sync bug is fixed.',
    'All tests pass.',
    'The details are in the chat.'
  ])
  // Stub models expose what was said, with no audio.
  expect(document.querySelector('[data-nova-state]')?.getAttribute('data-nova-last-spoken')).toBe(
    'The sync bug is fixed. All tests pass. The details are in the chat.'
  )
})

it('speaks when the brain stops at waiting for a plan decision', async () => {
  await openPanel()
  await brainTurn(['Here is my plan for the sync fix.'], 'waiting')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  expect(tts.sentences).toEqual(['Here is my plan for the sync fix.'])
  await playOut()
})

it('skips stopped messages', async () => {
  await openPanel()
  activeSession.brainState = 'thinking'
  await tick()
  activeSession.messages = [{ ...brainMessage('Cut off mid'), state: 'stopped' }]
  activeSession.brainState = 'idle'
  await tick()
  expect(novaState()).toBe('idle')
  expect(tts.sentences).toEqual([])
})

it('does not speak a turn that was already running when the panel opened', async () => {
  await activeSession.open('s1')
  activeSession.brainState = 'thinking'
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  await waitFor(() => expect(voiceModels.ttsReady).toBe(true))
  activeSession.messages = [brainMessage('Started before the panel.')]
  activeSession.brainState = 'idle'
  await tick()
  expect(novaState()).toBe('idle')
  expect(tts.sentences).toEqual([])
})

it('Stop ends speech at once and returns to Idle', async () => {
  await openPanel()
  await brainTurn(['First sentence. Second sentence. Third sentence.'])
  await waitFor(() => expect(novaState()).toBe('speaking'))
  await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(novaState()).toBe('idle')
  expect(player.flushes).toBeGreaterThan(0)
  const spoken = tts.sentences.length
  await tick()
  expect(player.active).toBe(0)
  expect(tts.sentences.length).toBe(spoken)
})

it('Mute stops speech, saves voice.muted, silences later answers and survives reopening', async () => {
  await openPanel()
  await brainTurn(['Talking now.'])
  await waitFor(() => expect(novaState()).toBe('speaking'))
  const mute = screen.getByRole('button', { name: 'Mute' })
  expect(mute.getAttribute('aria-pressed')).toBe('false')
  await fireEvent.click(mute)
  expect(novaState()).toBe('idle')
  expect(mute.getAttribute('aria-pressed')).toBe('true')
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:set', { 'voice.muted': true }))

  const before = tts.sentences.length
  await brainTurn(['This stays quiet.'])
  expect(novaState()).toBe('idle')
  expect(tts.sentences.length).toBe(before)

  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  settings.reset()
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')).toBe('true')
  )
})

it('speaks a typed answer under "Speak every answer"', async () => {
  await openPanel()
  await brainTurn(['Typed answer here.'])
  await waitFor(() => expect(tts.sentences).toEqual(['Typed answer here.']))
  await playOut()
})

it('does not speak a typed answer under "Only answers to spoken questions"', async () => {
  stored['voice.speakPolicy'] = 'spoken-only'
  await openPanel()
  await brainTurn(['Typed answer here.'])
  expect(novaState()).toBe('idle')
  expect(tts.sentences).toEqual([])
})

it('speaks the answer to a turn marked spoken even under "Only answers to spoken questions"', async () => {
  stored['voice.speakPolicy'] = 'spoken-only'
  await openPanel()
  nova.markNextTurnSpoken()
  await brainTurn(['You asked aloud.'])
  await waitFor(() => expect(tts.sentences).toEqual(['You asked aloud.']))
  await playOut()
})

it('uses the voice and speed saved in Settings, and a change applies from the next answer', async () => {
  stored['voice.voiceId'] = 'bm_george'
  stored['voice.speed'] = 1.2
  await openPanel()
  await brainTurn(['First answer.'])
  await waitFor(() =>
    expect(tts.calls).toEqual([{ sentence: 'First answer.', voiceId: 'bm_george', speed: 1.2 }])
  )
  await playOut()
  // The user picks another voice and speed in Settings between the answers.
  await settings.save({ 'voice.voiceId': 'bf_emma', 'voice.speed': 0.8 })
  await brainTurn(['Second answer.'])
  await waitFor(() => expect(tts.calls).toHaveLength(2))
  expect(tts.calls[0]).toEqual({ sentence: 'First answer.', voiceId: 'bm_george', speed: 1.2 })
  expect(tts.calls[1]).toEqual({ sentence: 'Second answer.', voiceId: 'bf_emma', speed: 0.8 })
  await playOut()
})

it('closing the panel stops speech', async () => {
  await openPanel()
  await brainTurn(['Some words to say.'])
  await waitFor(() => expect(novaState()).toBe('speaking'))
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(player.flushes).toBeGreaterThan(0)
})

it('shows the banner and keeps the chat working when the voice fails', async () => {
  setEngines({ tts: createFakeTts({ failSynth: true }), player })
  await openPanel()
  await brainTurn(['This cannot be spoken.'])
  const banner = await screen.findByText(
    "Nova can't speak right now. Answers still appear in the chat."
  )
  expect(banner).toBeTruthy()
  expect(novaState()).toBe('idle')
  expect(activeSession.messages.map((m) => m.content)).toEqual(['This cannot be spoken.'])
})

it('shows the banner when the voice cannot load', async () => {
  setEngines({ tts: createFakeTts({ failWarm: true }), player })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await openPanel()
  expect(
    await screen.findByText("Nova can't speak right now. Answers still appear in the chat.")
  ).toBeTruthy()
  // Only the error name is logged, never text.
  for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain('This')
  warn.mockRestore()
})
