import { Playback, SPEECH_SAMPLE_RATE, type Player } from './audio/playback'
import { IpcSttClient } from './audio/stt-client'
import {
  ChunkRing,
  MIC_CHUNK_SAMPLES,
  MicError,
  PRE_ROLL_CHUNKS,
  type ListenEngines,
  type Mic,
  type MicFailure,
  type SttClient,
  type Vad,
  type VadCallbacks
} from './audio/listen-types'

/** Text to speech. `synth` returns 24 kHz mono samples for one sentence. */
export interface TtsEngine {
  warm(): Promise<void>
  synth(sentence: string, voiceId: string, speed: number): Promise<Float32Array>
  dispose(): void
}

export interface FakeTtsOptions {
  /** Milliseconds of work per sentence (default 0). */
  delayMs?: number
  /** Makes `warm()` reject, to exercise the failure path. */
  failWarm?: boolean
  /** Makes `synth()` reject. */
  failSynth?: boolean
}

export interface FakeTts extends TtsEngine {
  /** Every sentence synthesised, in order, with the voice and speed it used. */
  readonly calls: { sentence: string; voiceId: string; speed: number }[]
  readonly sentences: string[]
}

/**
 * Deterministic speech-like sound per sentence, as long as before (40 ms per character, up to 6 s):
 * syllables of about 170 ms with their own loudness, alternating a low (open vowel) and a bright
 * (spread vowel) timbre, a short gap between syllables and a clear pause of at least 200 ms after
 * every third, so the face has something to open and close on. Fake engine only.
 */
export function toneFor(sentence: string): Float32Array {
  const ms = Math.min(6000, 250 + sentence.length * 40)
  const samples = new Float32Array(Math.round((SPEECH_SAMPLE_RATE * ms) / 1000))
  const rate = SPEECH_SAMPLE_RATE
  const f0 = 130
  let seed = 7
  for (let i = 0; i < sentence.length; i++) seed = (seed * 31 + sentence.charCodeAt(i)) >>> 0
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  let at = 0.04
  let syllable = 0
  while (at < ms / 1000 - 0.2) {
    const len = 0.14 + rand() * 0.07
    const amp = 0.08 + rand() * 0.14
    // Low formant near 700 Hz, or high near 2400 Hz.
    const formant = syllable % 2 === 0 ? 700 : 2400
    const from = Math.round(at * rate)
    const n = Math.min(Math.round(len * rate), samples.length - from)
    for (let i = 0; i < n; i++) {
      const w = Math.sin((Math.PI * i) / n) ** 2
      let v = 0
      for (let h = 1; h * f0 < 4000; h++) {
        const d = (h * f0 - formant) / 450
        v += Math.exp(-d * d) * Math.sin((2 * Math.PI * h * f0 * (from + i)) / rate)
      }
      samples[from + i] = (samples[from + i] ?? 0) + 0.35 * amp * w * v
    }
    syllable++
    at += len + (syllable % 3 === 0 ? 0.22 : 0.035)
  }
  return samples
}

export function createFakeTts(options: FakeTtsOptions = {}): FakeTts {
  const calls: FakeTts['calls'] = []
  return {
    calls,
    get sentences() {
      return calls.map((c) => c.sentence)
    },
    async warm() {
      if (options.failWarm) throw new Error('fake warm failure')
    },
    async synth(sentence, voiceId, speed) {
      if (options.failSynth) throw new Error('fake synth failure')
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      calls.push({ sentence, voiceId, speed })
      return toneFor(sentence)
    },
    dispose() {}
  }
}

export interface FakePlayer extends Player {
  /** Buffers handed to `play()` that have not finished. */
  readonly active: number
  /** Number of `flush()` calls. */
  readonly flushes: number
  /** Ends everything that is playing, as if it played out. */
  finishAll(): void
}

/** A player that plays nothing and holds each buffer until `finishAll()` (jsdom has no audio). */
export function createFakePlayer(): FakePlayer {
  let resolvers: (() => void)[] = []
  let flushes = 0
  return {
    play() {
      return new Promise<void>((resolve) => resolvers.push(resolve))
    },
    flush() {
      flushes++
      this.finishAll()
    },
    finishAll() {
      const done = resolvers
      resolvers = []
      for (const resolve of done) resolve()
    },
    get active() {
      return resolvers.length
    },
    get flushes() {
      return flushes
    },
    level: 0
  }
}

export interface FakeMic extends Mic {
  /** Sets the level `level()` reports. */
  setLevel(level: number): void
  /** Delivers one 100 ms chunk of `value` (and keeps it in the pre-roll buffer). */
  emit(value?: number): void
  readonly closed: boolean
}

export function createFakeMic(): FakeMic {
  const ring = new ChunkRing(PRE_ROLL_CHUNKS + 2)
  const listeners = new Set<(chunk: Int16Array) => void>()
  let level = 0
  let closed = false
  return {
    stream: null,
    context: null,
    level: () => level,
    setLevel(next) {
      level = next
    },
    onChunk(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recent: (count) => ring.recent(count),
    emit(value = 1000) {
      const chunk = new Int16Array(MIC_CHUNK_SAMPLES).fill(value)
      ring.push(chunk)
      for (const listener of listeners) listener(chunk)
    },
    close() {
      closed = true
      listeners.clear()
    },
    get closed() {
      return closed
    }
  }
}

export interface FakeStt extends SttClient {
  /** What `end()` resolves with next ('' for nothing understood). */
  transcript: string
  /** Makes `end()` reject, as a crashed engine would. */
  failEnd: boolean
  readonly begins: { preRollChunks: number }[]
  readonly pushed: number[]
  readonly ends: number
  readonly cancels: number
}

export function createFakeStt(): FakeStt {
  const begins: FakeStt['begins'] = []
  const pushed: number[] = []
  let ends = 0
  let cancels = 0
  let utteranceId: string | null = null
  let count = 0
  const stt: FakeStt = {
    get utteranceId() {
      return utteranceId
    },
    transcript: 'What are the workers doing?',
    failEnd: false,
    begins,
    pushed,
    get ends() {
      return ends
    },
    get cancels() {
      return cancels
    },
    begin(preRoll) {
      utteranceId = `fake-utterance-${++count}`
      begins.push({ preRollChunks: preRoll.length })
      for (const chunk of preRoll) pushed.push(chunk.length)
    },
    push(chunk) {
      pushed.push(chunk.length)
    },
    async end() {
      utteranceId = null
      ends++
      if (stt.failEnd) throw new Error('fake recognition failure')
      return stt.transcript
    },
    cancel() {
      utteranceId = null
      cancels++
    }
  }
  return stt
}

export interface FakeListen {
  engines: ListenEngines
  mic: FakeMic
  stt: FakeStt
  /** Fires the detector's callbacks, as speech and a pause would. */
  speechStart(): void
  /** Speech began again (the detector's earliest signal). */
  speechResume(): void
  speechEnd(): void
  /** Fires the detector's barge-in (sustained speech over Nova). */
  bargeIn(): void
  /** Makes the next `openMic()` fail. */
  failMic(reason: MicFailure | null): void
  readonly vadDestroyed: boolean
}

/** A microphone, voice detector and recogniser that are driven by the test. */
export function createFakeListen(): FakeListen {
  const mic = createFakeMic()
  const stt = createFakeStt()
  let callbacks: VadCallbacks | undefined
  let failure: MicFailure | null = null
  let destroyed = false
  return {
    mic,
    stt,
    engines: {
      async openMic() {
        if (failure) throw new MicError(failure)
        return mic
      },
      async createVad(_mic, cb): Promise<Vad> {
        callbacks = cb
        destroyed = false
        return {
          async destroy() {
            destroyed = true
            callbacks = undefined
          }
        }
      },
      stt
    },
    speechStart: () => callbacks?.onSpeechStart(),
    speechResume: () => callbacks?.onSpeechResume(),
    speechEnd: () => callbacks?.onSpeechEnd(),
    bargeIn: () => callbacks?.onBargeIn(),
    failMic(reason) {
      failure = reason
    },
    get vadDestroyed() {
      return destroyed
    }
  }
}

let tts: TtsEngine | undefined
let player: Player | undefined
let listen: ListenEngines | undefined

/** The speech engine: the Kokoro worker, or a tone generator when the main process reports stub models (e2e). */
export async function getTtsEngine(fake: boolean): Promise<TtsEngine> {
  if (tts) return tts
  if (fake) {
    tts = createFakeTts()
  } else {
    const { WorkerTtsEngine } = await import('./audio/tts-engine')
    tts = new WorkerTtsEngine()
  }
  return tts
}

export function getPlayer(): Player {
  player ??= new Playback()
  return player
}

/** The microphone, voice detector and recogniser (the real ones load only when a conversation starts). */
export function getListenEngines(): ListenEngines {
  listen ??= {
    openMic: async () => (await import('./audio/mic')).openMic(),
    createVad: async (mic, callbacks, options) =>
      (await import('./audio/vad')).createVad(mic, callbacks, options),
    stt: new IpcSttClient()
  }
  return listen
}

/** Tests inject their own engines; call with no arguments to reset. */
export function setEngines(
  engines: { tts?: TtsEngine; player?: Player; listen?: ListenEngines } = {}
): void {
  tts?.dispose()
  tts = engines.tts
  player = engines.player
  listen = engines.listen
}
