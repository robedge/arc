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
  createFakeListen,
  createFakePlayer,
  createFakeTts,
  setEngines,
  type FakeListen,
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

const snapshot = (): SessionSnapshot => ({
  header,
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

let tts: FakeTts
let player: FakePlayer
let listen: FakeListen
let invoke: ReturnType<typeof mockArc>
let micStatus: string
let askGranted: boolean
let openError: 'VOICE_MODEL_MISSING' | null
let nextId: number

beforeEach(() => {
  tts = createFakeTts()
  player = createFakePlayer()
  listen = createFakeListen()
  setEngines({ tts, player, listen: listen.engines })
  nextId = 100
  micStatus = 'granted'
  askGranted = true
  openError = null
  settings.reset()
  voiceModels.seed([])
  invoke = mockArc((channel) => {
    switch (channel) {
      case 'sessions:open':
        return { ok: true, data: snapshot() }
      case 'settings:get':
        return {
          ok: true,
          data: { 'voice.muted': false, 'voice.speakPolicy': 'all', 'voice.endPauseMs': 500 }
        }
      case 'voice:models-status':
        return {
          ok: true,
          data: {
            fake: true,
            models: [{ id: 'kokoro', kind: 'tts', state: 'ready', bytes: 1, totalBytes: 1 }]
          }
        }
      case 'voice:mic-status':
        return { ok: true, data: { status: micStatus } }
      case 'voice:ask-mic':
        return { ok: true, data: { granted: askGranted } }
      case 'voice:open':
        return openError
          ? { ok: false, error: { code: openError, message: '' } }
          : { ok: true, data: {} }
      case 'sessions:send-message':
        return { ok: true, data: { messageId: nextId++ } }
      default:
        return { ok: true, data: {} }
    }
  })
  nova.silenceMs = 10_000
})
afterEach(() => {
  cleanup()
  activeSession.close()
  nova.close()
  setEngines()
})

const novaState = (): string | null =>
  document.querySelector('[data-nova-state]')?.getAttribute('data-nova-state') ?? null

async function openPanel(): Promise<void> {
  await activeSession.open('s1')
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  await waitFor(() => expect(voiceModels.ttsReady).toBe(true))
  await waitFor(() => expect(settings.values).not.toBeNull())
  await tick()
}

async function startConversation(): Promise<void> {
  await openPanel()
  await fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
  await waitFor(() => expect(novaState()).toBe('listening'))
}

/** The detector hears silence; finished-sounding words were heard, so the short hold (50 ms here) applies. */
function endSpeech(): void {
  const id = listen.stt.utteranceId
  if (id) {
    const handler = (window.arc.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'voice:partial')
      .at(-1)?.[1] as ((e: { utteranceId: string; text: string }) => void) | undefined
    handler?.({ utteranceId: id, text: 'done' })
  }
  listen.speechEnd()
}

/** The user says something and pauses; resolves once the recognised text came back. */
async function say(text: string): Promise<void> {
  listen.stt.transcript = text
  listen.mic.emit()
  listen.speechStart()
  await tick()
  listen.mic.emit()
  endSpeech()
}

const calls = (channel: string): unknown[] =>
  invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

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

async function brainAnswers(content: string): Promise<void> {
  activeSession.brainState = 'thinking'
  await tick()
  activeSession.messages = [...activeSession.messages, brainMessage(content)]
  activeSession.brainState = 'idle'
  await tick()
}

it('Start conversation checks the microphone, opens the engine and shows Listening with a level meter', async () => {
  await startConversation()
  expect(calls('voice:mic-status')).toHaveLength(1)
  expect(calls('voice:open')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'End conversation' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  listen.mic.setLevel(0.6)
  await waitFor(() =>
    expect(
      screen.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow')
    ).toBe('60')
  )
})

it('asks macOS for the microphone the first time', async () => {
  micStatus = 'not-determined'
  await startConversation()
  expect(calls('voice:ask-mic')).toHaveLength(1)
})

it('sends the recognised words as a spoken message, shows them, and goes Thinking', async () => {
  await startConversation()
  await say('What are the workers doing?')
  await waitFor(() => expect(novaState()).toBe('thinking'))
  expect(calls('sessions:send-message')).toEqual([
    { sessionId: 's1', text: 'What are the workers doing?', spoken: true }
  ])
  expect(document.querySelector('[data-nova-transcript]')?.textContent?.trim()).toBe(
    'What are the workers doing?'
  )
  const user = activeSession.messages.find((m) => m.role === 'user')
  expect(user?.spoken).toBe(true)
  // The pre-roll goes out ahead of the speech.
  expect(listen.stt.begins[0]!.preRollChunks).toBeGreaterThan(0)
})

it('marks a spoken user message in the chat with an accessible mic marker', async () => {
  await startConversation()
  await say('Check the build')
  await waitFor(() => expect(document.querySelector('[data-spoken-marker]')).not.toBeNull())
  expect(screen.getByRole('img', { name: 'Spoken' })).toBeTruthy()
})

it('speaks the answer, then listens again without a click', async () => {
  await startConversation()
  await say('Status?')
  await waitFor(() => expect(novaState()).toBe('thinking'))
  await brainAnswers('Two workers are running.')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  await waitFor(() => {
    player.finishAll()
    expect(novaState()).toBe('listening')
  })
  expect(nova.conversation).toBe(true)
})

it('does not start a turn from sound picked up while Nova speaks', async () => {
  await startConversation()
  await say('Status?')
  await waitFor(() => expect(novaState()).toBe('thinking'))
  await brainAnswers('Two workers are running.')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  const before = listen.stt.begins.length
  listen.speechStart()
  endSpeech()
  await tick()
  expect(listen.stt.begins).toHaveLength(before)
  expect(novaState()).toBe('speaking')
  player.finishAll()
})

it('says sorry and listens again when nothing was recognised, sending nothing', async () => {
  await startConversation()
  await say('')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  expect(tts.sentences).toEqual(["Sorry, I didn't catch that."])
  expect(calls('sessions:send-message')).toHaveLength(0)
  await waitFor(() => {
    player.finishAll()
    expect(novaState()).toBe('listening')
  })
})

it('returns to Idle after ten seconds with no speech', async () => {
  nova.silenceMs = 40
  await startConversation()
  await waitFor(() => expect(novaState()).toBe('idle'))
  expect(nova.conversation).toBe(false)
  expect(listen.mic.closed).toBe(true)
  expect(calls('voice:close')).toHaveLength(1)
  expect(calls('sessions:send-message')).toHaveLength(0)
  // Start conversation resumes.
  expect(screen.getByRole('button', { name: 'Start conversation' })).toBeTruthy()
})

it('Cancel discards the turn and goes Idle', async () => {
  await startConversation()
  listen.mic.emit()
  listen.speechStart()
  await tick()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(novaState()).toBe('idle')
  expect(listen.stt.cancels).toBe(1)
  endSpeech()
  await tick()
  expect(calls('sessions:send-message')).toHaveLength(0)
})

it('End conversation releases the microphone and goes Idle', async () => {
  await startConversation()
  await fireEvent.click(screen.getByRole('button', { name: 'End conversation' }))
  expect(novaState()).toBe('idle')
  expect(listen.mic.closed).toBe(true)
  expect(listen.vadDestroyed).toBe(true)
  expect(calls('voice:close')).toHaveLength(1)
})

it('closing the panel releases the microphone', async () => {
  await startConversation()
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(listen.mic.closed).toBe(true)
})

it('shows how to allow the microphone when access was denied, and still speaks typed answers', async () => {
  micStatus = 'denied'
  await openPanel()
  await fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
  await waitFor(() =>
    expect(
      document.querySelector('[data-nova-mic-denied]')?.textContent?.replace(/\s+/g, ' ')
    ).toContain(
      "Arc can't hear you. Allow microphone access in System Settings > Privacy & Security > Microphone."
    )
  )
  expect(novaState()).toBe('idle')
  await fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
  expect(calls('voice:open-mic-settings')).toHaveLength(1)
  expect(calls('voice:open')).toHaveLength(0)
  await brainAnswers('Typed answers are still spoken.')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  expect(tts.sentences).toEqual(['Typed answers are still spoken.'])
  player.finishAll()
})

it('shows "No microphone found." when there is no input device, and still speaks typed answers', async () => {
  listen.failMic('unavailable')
  await openPanel()
  await fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
  await waitFor(() =>
    expect(document.querySelector('[data-nova-no-mic]')?.textContent).toContain(
      'No microphone found.'
    )
  )
  expect(novaState()).toBe('idle')
  expect(calls('voice:close')).toHaveLength(1)
  await brainAnswers('Still here.')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  expect(tts.sentences).toEqual(['Still here.'])
  player.finishAll()
})

it('shows the download prompt when the speech model is missing', async () => {
  openError = 'VOICE_MODEL_MISSING'
  await openPanel()
  await fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
  await waitFor(() => expect(document.querySelector('[data-nova-model-missing]')).not.toBeNull())
  expect(novaState()).toBe('idle')
  expect(listen.mic.closed).toBe(false)
})

/** The `voice:partial` handler the store registered with the bridge. */
function partialHandler(): (event: { utteranceId: string; text: string }) => void {
  const call = (window.arc.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === 'voice:partial')
    .at(-1)
  return call![1] as (event: { utteranceId: string; text: string }) => void
}
const transcriptText = (): string =>
  document.querySelector('[data-nova-transcript]')?.textContent?.trim() ?? ''

it('shows the live words of the turn, then the final text', async () => {
  await startConversation()
  listen.mic.emit()
  listen.speechStart()
  await tick()
  const id = listen.stt.utteranceId!
  partialHandler()({ utteranceId: id, text: 'what are' })
  await waitFor(() => expect(transcriptText()).toBe('what are'))
  expect(document.querySelector('[data-nova-transcript]')?.getAttribute('aria-live')).toBe('off')
  partialHandler()({ utteranceId: id, text: 'what are the workers' })
  await waitFor(() => expect(transcriptText()).toBe('what are the workers'))
  listen.stt.transcript = 'What are the workers doing?'
  endSpeech()
  await waitFor(() => expect(transcriptText()).toBe('What are the workers doing?'))
  expect(document.querySelector('[data-nova-transcript]')?.getAttribute('aria-live')).toBe('polite')
})

it("shows the streaming model's uppercase partials in lowercase and keeps the final text as it is", async () => {
  await startConversation()
  listen.mic.emit()
  listen.speechStart()
  await tick()
  const id = listen.stt.utteranceId!
  partialHandler()({ utteranceId: id, text: "S OPEN THE SETTING'S PANEL" })
  await waitFor(() => expect(transcriptText()).toBe("s open the setting's panel"))
  listen.stt.transcript = 'Open the Settings panel.'
  endSpeech()
  await waitFor(() => expect(transcriptText()).toBe('Open the Settings panel.'))
})

it('ignores partials for other utterances and ones with no utterance open', async () => {
  await startConversation()
  partialHandler()({ utteranceId: 'fake-utterance-1', text: 'too early' })
  await tick()
  expect(transcriptText()).toBe('')
  listen.mic.emit()
  listen.speechStart()
  await tick()
  partialHandler()({ utteranceId: 'someone-else', text: 'stale words' })
  await tick()
  expect(transcriptText()).toBe('')
})

it('talking over Nova stops her, starts a new turn with the pre-roll and sends what was said', async () => {
  await startConversation()
  await say('First question')
  await waitFor(() => expect(novaState()).toBe('thinking'))
  await brainAnswers('Here is a long answer about the workers.')
  await waitFor(() => expect(novaState()).toBe('speaking'))
  const begins = listen.stt.begins.length
  const flushes = player.flushes
  listen.mic.emit()
  listen.bargeIn()
  await waitFor(() => expect(novaState()).toBe('listening'))
  expect(player.flushes).toBeGreaterThan(flushes)
  expect(listen.stt.begins).toHaveLength(begins + 1)
  expect(listen.stt.begins.at(-1)!.preRollChunks).toBeGreaterThan(0)
  listen.stt.transcript = 'Stop, do this instead'
  endSpeech()
  await waitFor(() => expect(novaState()).toBe('thinking'))
  expect(calls('sessions:send-message').at(-1)).toEqual({
    sessionId: 's1',
    text: 'Stop, do this instead',
    spoken: true
  })
})

it('a barge-in while Nova is not speaking changes nothing', async () => {
  await startConversation()
  listen.bargeIn()
  await tick()
  expect(novaState()).toBe('listening')
  expect(listen.stt.begins).toHaveLength(0)
})
