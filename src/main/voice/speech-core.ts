import { cleanTranscript } from './transcript-filter'
import { toWorkerSchema } from './speech-protocol'
import type { FromWorker, ToWorker } from './speech-protocol'

/** What the speech process needs from an engine; Whisper in production, a stub in e2e and tests. */
export interface SpeechEngine {
  /** Loads the model; the first load can take several seconds. Rejects with `ModelLoadError` for a bad file. */
  load(modelPaths: { whisper: string; zipformer?: string }): Promise<void | { partials: boolean }>
  /** Mono Int16 at 16 kHz in, the recognised text out ('' when none). */
  transcribe(pcm: Int16Array): Promise<string>
  release(): Promise<void>
  /** Starts a fresh live stream (at begin, end and cancel). Only an engine with a streaming model has it. */
  streamReset?(): void
  /** Feeds a chunk to the live stream and returns the words heard so far. */
  streamPcm?(pcm: Int16Array): string
}

export class ModelLoadError extends Error {
  override readonly name = 'ModelLoadError'
}

export interface SpeechCoreDeps {
  engine: SpeechEngine
  post: (message: FromWorker) => void
  /** Ends the process (`process.exit`); the core calls it on `shutdown`. */
  exit: (code: number) => void
  /** The clock for the partial gap; tests pass their own. */
  now?: () => number
  /** The least time between two partials (150 ms; the fake worker uses 0 so its partials are deterministic). */
  partialGapMs?: number
}

export const PARTIAL_GAP_MS = 150

/** Audio whose loudest sample is below this (about -66 dBFS) holds no speech; Whisper would invent words for it. */
const SILENCE_PEAK = 16

const isSilent = (pcm: Int16Array): boolean => pcm.every((s) => Math.abs(s) < SILENCE_PEAK)

/** The longest utterance kept (two minutes); later audio of the same utterance is dropped. */
const MAX_UTTERANCE_SAMPLES = 16_000 * 120

/**
 * The speech process without its transport: messages go in through `receive`, answers come out
 * through `post`. Messages run one at a time in arrival order, so audio that arrives while the
 * model is still loading waits for it instead of being lost.
 */
export function createSpeechCore(deps: SpeechCoreDeps): { receive: (raw: unknown) => void } {
  const { engine, post, exit } = deps
  const now = deps.now ?? Date.now
  const partialGapMs = deps.partialGapMs ?? PARTIAL_GAP_MS
  let lastPartialAt = Number.NEGATIVE_INFINITY
  let lastPartial = ''

  /** A new stream for the next utterance; a stream that fails only costs the partials. */
  function resetStream(): void {
    lastPartialAt = Number.NEGATIVE_INFINITY
    lastPartial = ''
    try {
      engine.streamReset?.()
    } catch {
      // No partials this time.
    }
  }

  function livePartial(utteranceId: string, samples: Int16Array): void {
    if (!engine.streamPcm) return
    let heard: string
    try {
      heard = engine.streamPcm(samples).replace(/\s+/g, ' ').trim()
    } catch {
      return
    }
    const at = now()
    if (!heard || heard === lastPartial || at - lastPartialAt < partialGapMs) return
    lastPartial = heard
    lastPartialAt = at
    post({ type: 'partial', utteranceId, text: heard })
  }
  const utterances = new Map<string, Int16Array[]>()
  const sizes = new Map<string, number>()
  let chain: Promise<void> = Promise.resolve()
  let loaded = false

  async function handle(message: ToWorker): Promise<void> {
    switch (message.type) {
      case 'init':
        try {
          const result = await engine.load(message.modelPaths)
          loaded = true
          post(result && !result.partials ? { type: 'ready', partials: false } : { type: 'ready' })
        } catch (error: unknown) {
          post({
            type: 'error',
            code: error instanceof ModelLoadError ? 'model-corrupt' : 'engine-crashed'
          })
        }
        return
      case 'begin':
        utterances.set(message.utteranceId, [])
        sizes.set(message.utteranceId, 0)
        resetStream()
        return
      case 'pcm': {
        const chunks = utterances.get(message.utteranceId)
        if (!chunks) return
        const samples = new Int16Array(message.samples.slice(0))
        const total = (sizes.get(message.utteranceId) ?? 0) + samples.length
        if (total > MAX_UTTERANCE_SAMPLES) return
        chunks.push(samples)
        sizes.set(message.utteranceId, total)
        livePartial(message.utteranceId, samples)
        return
      }
      case 'cancel':
        utterances.delete(message.utteranceId)
        sizes.delete(message.utteranceId)
        resetStream()
        return
      case 'end': {
        const chunks = utterances.get(message.utteranceId)
        utterances.delete(message.utteranceId)
        sizes.delete(message.utteranceId)
        resetStream()
        if (!chunks) return
        if (!loaded) {
          post({ type: 'error', utteranceId: message.utteranceId, code: 'engine-crashed' })
          return
        }
        try {
          const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0))
          let at = 0
          for (const c of chunks) {
            pcm.set(c, at)
            at += c.length
          }
          const text = isSilent(pcm) ? '' : cleanTranscript(await engine.transcribe(pcm))
          post({ type: 'final', utteranceId: message.utteranceId, text })
        } catch {
          post({ type: 'error', utteranceId: message.utteranceId, code: 'engine-crashed' })
        }
        return
      }
      case 'shutdown':
        try {
          await engine.release()
        } finally {
          exit(0)
        }
        return
    }
  }

  return {
    receive(raw) {
      const parsed = toWorkerSchema.safeParse(raw)
      if (!parsed.success) return
      // A throw inside `handle` must not break the chain for the messages behind it.
      chain = chain.then(() => handle(parsed.data)).catch(() => undefined)
    }
  }
}
