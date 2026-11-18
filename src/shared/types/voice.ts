/** The role a speech model plays (tech spec 2.5). */
export type VoiceModelKind = 'tts' | 'stt-stream' | 'stt-final'

export type VoiceModelState = 'missing' | 'downloading' | 'ready' | 'failed'

export interface VoiceModelStatus {
  id: string
  kind: VoiceModelKind
  state: VoiceModelState
  /** Bytes on disk for this model (complete files plus a partial download). */
  bytes: number
  /** Full download size of this model, so the UI can state it before anything is on disk. */
  totalBytes: number
}

export interface VoiceModelProgress {
  id: string
  receivedBytes: number
  totalBytes: number
  state: VoiceModelState
}

/** Codes of the `voice:error` event. Panel behaviour for each is in tech spec 2.3. */
export type VoiceErrorCode =
  'mic-denied' | 'mic-unavailable' | 'offline' | 'model-corrupt' | 'engine-crashed' | 'tts-failed'

/** The speech engine's lifecycle as the `voice:engine-state` event reports it. */
export type VoiceEngineState = 'off' | 'starting' | 'ready' | 'failed'

/** What macOS says about the microphone (`systemPreferences.getMediaAccessStatus`). */
export type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined'

/** The Kokoro voices Settings offers. `af_heart` is the default. */
export const KOKORO_VOICES = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'am_michael',
  'bf_emma',
  'bm_george'
] as const

export type KokoroVoiceId = (typeof KOKORO_VOICES)[number]

export type VoiceSpeakPolicy = 'all' | 'spoken-only'
