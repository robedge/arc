import type { BrainState } from '@shared/types/session'
import type { VoiceSpeakPolicy } from '@shared/types/voice'

export type NovaMode = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface MachineState {
  mode: NovaMode
  muted: boolean
  policy: VoiceSpeakPolicy
  /** A brain turn started while the panel was open and has not settled yet. */
  turnActive: boolean
  /** The running turn answers something the user said aloud. */
  turnSpoken: boolean
  /** The next turn to start answers something the user said aloud. */
  pendingSpoken: boolean
  /** Start conversation was clicked and End conversation has not been (hands-free listening). */
  conversation: boolean
  /** What is happening with the user's current speech while listening. */
  utterance: Utterance
}

/** `capturing`: the user is speaking. `processing`: they paused and the words are being recognised. */
export type Utterance = 'none' | 'capturing' | 'processing'

export const NOT_UNDERSTOOD = "Sorry, I didn't catch that."
export const ATTENTION_ANNOUNCEMENT = 'I need your attention on something.'
export const BRAIN_ERROR_ANNOUNCEMENT = 'Something went wrong. The details are in the chat.'
/** How long Nova listens with no speech before it goes back to Idle. */
export const SILENCE_MS = 10_000

export type MachineEvent =
  | { type: 'brainThinking' }
  /** `text` is the shaped answer ('' when there is nothing to say). */
  | { type: 'brainSettled'; text: string }
  | { type: 'speakDone' }
  | { type: 'stop' }
  | { type: 'mute'; muted: boolean }
  | { type: 'policy'; policy: VoiceSpeakPolicy }
  /** The next turn answers a spoken message (Slice 5). */
  | { type: 'markSpoken' }
  | { type: 'close' }
  /** The microphone and speech engine are ready: listening begins. */
  | { type: 'start' }
  /** The voice detector heard the user start (only counts while listening). */
  | { type: 'speechStart' }
  /** The user paused; the words are being recognised. */
  | { type: 'speechEnd' }
  /** The user talked over Nova (sustained speech while it speaks): stop it and listen. */
  | { type: 'bargeIn' }
  /** The recognised words (never empty: that is `empty`). */
  | { type: 'final'; text: string }
  /** Nothing was recognised. `speak` is false when Nova cannot speak (no voice model). */
  | { type: 'empty'; speak: boolean }
  /** The recognised words could not be sent to the brain. */
  | { type: 'sendFailed' }
  /** Cancel while listening: discard the turn and go Idle. */
  | { type: 'cancel' }
  /** End conversation. */
  | { type: 'end' }
  | { type: 'silenceTimeout' }
  /** One or more new Needs attention items arrived while the panel was open (one event per batch). */
  | { type: 'attentionNew' }
  /** A new brain `error` or `brain-stopped` entry arrived while the panel was open (one event per batch). */
  | { type: 'brainError' }

export type MachineEffect =
  | { type: 'speak'; text: string }
  | { type: 'stopSpeech' }
  /** Send the recognised words to the brain as a spoken message. */
  | { type: 'send'; text: string }
  /** Start capturing a turn now, with the audio from just before (the user is already talking). */
  | { type: 'beginUtterance' }
  /** Throw away the audio of the turn in progress. */
  | { type: 'cancelUtterance' }
  /** Release the microphone and stop the speech engine. */
  | { type: 'endConversation' }

export interface Transition {
  state: MachineState
  effects: MachineEffect[]
}

export function initialState(config: { muted: boolean; policy: VoiceSpeakPolicy }): MachineState {
  return {
    mode: 'idle',
    muted: config.muted,
    policy: config.policy,
    turnActive: false,
    turnSpoken: false,
    pendingSpoken: false,
    conversation: false,
    utterance: 'none'
  }
}

/** Where Nova rests when it is not busy: listening during a conversation, otherwise idle. */
function rest(state: MachineState): NovaMode {
  return state.conversation ? 'listening' : 'idle'
}

/** What a brain-state change means for Nova: a turn started, or it settled (idle or waiting for the user). */
export function brainTurnChange(prev: BrainState, next: BrainState): 'started' | 'settled' | null {
  if (prev !== 'thinking' && next === 'thinking') return 'started'
  if (prev === 'thinking' && (next === 'idle' || next === 'waiting')) return 'settled'
  return null
}

const SILENT: MachineEffect[] = []

/** Effects that drop the half-heard turn and, when a conversation ran, release the microphone. */
function teardown(state: MachineState): MachineEffect[] {
  return [
    ...(state.mode === 'speaking' ? ([{ type: 'stopSpeech' }] as const) : []),
    ...(state.utterance !== 'none' ? ([{ type: 'cancelUtterance' }] as const) : []),
    ...(state.conversation ? ([{ type: 'endConversation' }] as const) : [])
  ]
}

/** Says an alert unless muted: queued behind an answer being spoken, otherwise Nova speaks it now. */
function announce(state: MachineState, text: string): Transition {
  if (state.muted) return { state, effects: SILENT }
  if (state.mode === 'speaking') return { state, effects: [{ type: 'speak', text }] }
  return {
    state: {
      ...state,
      // A running turn keeps its place: speakDone returns to Thinking when it is still active.
      mode: state.mode === 'thinking' ? 'thinking' : 'speaking',
      utterance: 'none'
    },
    effects: [
      ...(state.utterance !== 'none' ? ([{ type: 'cancelUtterance' }] as const) : []),
      { type: 'speak', text }
    ]
  }
}

export function transition(state: MachineState, event: MachineEvent): Transition {
  switch (event.type) {
    case 'attentionNew':
      return announce(state, ATTENTION_ANNOUNCEMENT)
    case 'brainError':
      return announce(state, BRAIN_ERROR_ANNOUNCEMENT)
    case 'markSpoken':
      return { state: { ...state, pendingSpoken: true }, effects: SILENT }
    case 'brainThinking':
      return {
        state: {
          ...state,
          // A typed turn does not pull a listening conversation into Thinking.
          mode:
            state.mode === 'speaking' || (state.mode === 'listening' && !state.pendingSpoken)
              ? state.mode
              : 'thinking',
          turnActive: true,
          turnSpoken: state.pendingSpoken,
          pendingSpoken: false
        },
        effects: SILENT
      }
    case 'brainSettled': {
      if (!state.turnActive) return { state, effects: SILENT }
      const done = { ...state, turnActive: false, turnSpoken: false }
      const gated = state.muted || (state.policy === 'spoken-only' && !state.turnSpoken)
      if (gated || event.text.trim() === '') {
        return {
          state: { ...done, mode: state.mode === 'speaking' ? 'speaking' : rest(state) },
          effects: SILENT
        }
      }
      return {
        state: { ...done, mode: 'speaking', utterance: 'none' },
        effects: [
          ...(state.utterance !== 'none' ? ([{ type: 'cancelUtterance' }] as const) : []),
          { type: 'speak', text: event.text }
        ]
      }
    }
    case 'speakDone':
      return {
        state: {
          ...state,
          mode:
            state.mode === 'speaking' ? (state.turnActive ? 'thinking' : rest(state)) : state.mode
        },
        effects: SILENT
      }
    case 'stop':
      if (state.mode === 'speaking') {
        return {
          state: { ...state, mode: rest(state), turnActive: false },
          effects: [{ type: 'stopSpeech' }]
        }
      }
      if (state.mode === 'thinking') {
        return { state: { ...state, mode: rest(state), turnActive: false }, effects: SILENT }
      }
      return { state, effects: SILENT }
    case 'mute': {
      const next = { ...state, muted: event.muted }
      if (event.muted && state.mode === 'speaking') {
        return { state: { ...next, mode: rest(state) }, effects: [{ type: 'stopSpeech' }] }
      }
      return { state: next, effects: SILENT }
    }
    case 'policy':
      return { state: { ...state, policy: event.policy }, effects: SILENT }
    case 'start':
      return {
        state: {
          ...state,
          conversation: true,
          utterance: 'none',
          mode: state.mode === 'idle' ? 'listening' : state.mode
        },
        effects: SILENT
      }
    case 'speechStart':
      if (state.mode !== 'listening' || state.utterance !== 'none')
        return { state, effects: SILENT }
      return { state: { ...state, utterance: 'capturing' }, effects: SILENT }
    case 'bargeIn':
      if (state.mode !== 'speaking' || !state.conversation || state.muted)
        return { state, effects: SILENT }
      return {
        state: {
          ...state,
          mode: 'listening',
          utterance: 'capturing',
          turnActive: false,
          turnSpoken: false
        },
        effects: [{ type: 'stopSpeech' }, { type: 'beginUtterance' }]
      }
    case 'speechEnd':
      if (state.mode !== 'listening' || state.utterance !== 'capturing') {
        return { state, effects: SILENT }
      }
      return { state: { ...state, utterance: 'processing' }, effects: SILENT }
    case 'final':
      if (state.mode !== 'listening' || state.utterance === 'none')
        return { state, effects: SILENT }
      return {
        state: { ...state, mode: 'thinking', utterance: 'none' },
        effects: [{ type: 'send', text: event.text }]
      }
    case 'sendFailed':
      return {
        state: {
          ...state,
          mode: state.mode === 'thinking' && !state.turnActive ? rest(state) : state.mode,
          pendingSpoken: false
        },
        effects: SILENT
      }
    case 'empty':
      if (state.mode !== 'listening' || state.utterance === 'none')
        return { state, effects: SILENT }
      if (event.speak && !state.muted) {
        return {
          state: { ...state, mode: 'speaking', utterance: 'none' },
          effects: [{ type: 'speak', text: NOT_UNDERSTOOD }]
        }
      }
      return { state: { ...state, utterance: 'none' }, effects: SILENT }
    case 'cancel':
      if (state.mode !== 'listening') return { state, effects: SILENT }
      return {
        state: { ...state, mode: 'idle', conversation: false, utterance: 'none' },
        effects: teardown(state)
      }
    case 'silenceTimeout':
      if (state.mode !== 'listening' || state.utterance !== 'none')
        return { state, effects: SILENT }
      return {
        state: { ...state, mode: 'idle', conversation: false },
        effects: teardown(state)
      }
    case 'end':
      return {
        state: {
          ...state,
          mode: 'idle',
          conversation: false,
          utterance: 'none',
          turnActive: false,
          turnSpoken: false,
          pendingSpoken: false
        },
        effects: teardown(state)
      }
    case 'close':
      return {
        state: {
          ...state,
          mode: 'idle',
          conversation: false,
          utterance: 'none',
          turnActive: false,
          turnSpoken: false,
          pendingSpoken: false
        },
        effects: teardown(state)
      }
    default:
      return assertNever(event)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled event ${JSON.stringify(value)}`)
}
