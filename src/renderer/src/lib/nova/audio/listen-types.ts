/** The microphone, voice detector and recogniser Nova listens with, as interfaces so tests can fake them. */

/** Mono Int16 at 16 kHz, 100 ms per chunk. */
export const MIC_SAMPLE_RATE = 16_000
export const MIC_CHUNK_SAMPLES = 1_600
export const MIC_CHUNK_MS = 100
/**
 * Audio sent ahead of the moment the detector reports speech: the detector's 500 ms of pre-speech
 * padding plus the 250 ms of speech it needs before it reports a start. The recognisers need about
 * 0.5 s of audio before the first word.
 */
export const PRE_ROLL_MS = 750
export const PRE_ROLL_CHUNKS = Math.ceil(PRE_ROLL_MS / MIC_CHUNK_MS)

export type MicFailure = 'denied' | 'unavailable' | 'failed'

export class MicError extends Error {
  constructor(readonly reason: MicFailure) {
    super(reason)
    this.name = 'MicError'
  }
}

export interface Mic {
  /** The raw stream, which the voice detector listens to. */
  readonly stream: MediaStream | null
  /** The audio context both the capture and the detector run in (null for a fake). */
  readonly context: AudioContext | null
  /** Current input level, 0..1. */
  level(): number
  /** Called with every 100 ms chunk. Returns an unsubscribe function. */
  onChunk(listener: (chunk: Int16Array) => void): () => void
  /** The most recent chunks, oldest first (at most `count`). */
  recent(count: number): Int16Array[]
  /** Stops the capture and releases the microphone. */
  close(): void
}

export interface VadCallbacks {
  /** Real speech began (not a click or a cough). */
  onSpeechStart(): void
  /** Speech may have started again (fires before `onSpeechStart`, even for a short "um"): resumes a held utterance. */
  onSpeechResume(): void
  /** Silence began, after `VAD_REDEMPTION_MS`. The listener decides how long to wait before the turn ends. */
  onSpeechEnd(): void
  /** Sustained, confident speech while `VadOptions.bargeInActive()` was true (the user talks over Nova). */
  onBargeIn(): void
}

export interface Vad {
  destroy(): Promise<void>
}

/** How long the detector waits before it reports that silence began; it no longer ends the turn. */
export const VAD_REDEMPTION_MS = 450

export interface VadOptions {
  /** True while Nova speaks: only then are frames checked for a barge-in. */
  bargeInActive(): boolean
}

export interface SttClient {
  /** The id of the utterance in progress (null when none), to match `voice:partial` events. */
  readonly utteranceId: string | null
  /** Starts an utterance; the `preRoll` chunks go out first. */
  begin(preRoll: readonly Int16Array[]): void
  push(chunk: Int16Array): void
  /** Ends the utterance. Resolves with the recognised text, '' when nothing was understood. */
  end(): Promise<string>
  /** Throws the utterance away. */
  cancel(): void
}

export interface ListenEngines {
  openMic(): Promise<Mic>
  createVad(mic: Mic, callbacks: VadCallbacks, options: VadOptions): Promise<Vad>
  stt: SttClient
}

/** The newest `capacity` chunks. */
export class ChunkRing {
  private chunks: Int16Array[] = []
  constructor(private readonly capacity: number) {}

  push(chunk: Int16Array): void {
    this.chunks.push(chunk)
    if (this.chunks.length > this.capacity) this.chunks.shift()
  }

  recent(count: number): Int16Array[] {
    return this.chunks.slice(-count)
  }
}

/** 0..1 for the level indicator: speech sits around 0.05 to 0.3 RMS, so scale it up. */
export function levelFromRms(rms: number): number {
  return Math.max(0, Math.min(1, rms * 4))
}
