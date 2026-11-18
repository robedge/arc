import { createSpeechCore } from './speech-core'
import type { SpeechCoreDeps, SpeechEngine } from './speech-core'

/** Below this RMS (as a fraction of full scale) the stub hears nothing, so e2e can test "didn't catch that". */
const DEFAULT_SILENCE_RMS = 0.02
const DEFAULT_TRANSCRIPT = 'What are the workers doing right now?'

type Env = Readonly<Record<string, string | undefined>>

function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (const s of pcm) sum += (s / 32768) ** 2
  return Math.sqrt(sum / pcm.length)
}

/**
 * Deterministic stand-in for Whisper. Returns `HARNESS_FAKE_TRANSCRIPT` (an empty value is honoured)
 * unless the audio is quieter than `HARNESS_FAKE_SILENCE_RMS` (default 0.02), when it returns ''.
 */
export function createFakeEngine(env: Env): SpeechEngine {
  const transcript = env['HARNESS_FAKE_TRANSCRIPT'] ?? DEFAULT_TRANSCRIPT
  const threshold = Number(env['HARNESS_FAKE_SILENCE_RMS'] ?? DEFAULT_SILENCE_RMS)
  const words = transcript.split(/\s+/).filter(Boolean)
  let heard = 0
  return {
    load: () => Promise.resolve(),
    streamReset: () => {
      heard = 0
    },
    // One more word per audible chunk, so an e2e can assert the order the words appear in.
    streamPcm: (pcm) => {
      if (rms(pcm) >= threshold) heard = Math.min(heard + 1, words.length)
      return words.slice(0, heard).join(' ')
    },
    transcribe: (pcm) => Promise.resolve(rms(pcm) < threshold ? '' : transcript),
    release: () => Promise.resolve()
  }
}

/** `begin` with this utterance id makes the fake worker die with exit code 1 (the crash tests). */
export const FAKE_CRASH_UTTERANCE = '__crash__'

/** The fake speech process: the real core around the stub engine, plus the crash command. */
export function createFakeWorker(deps: {
  env: Env
  post: SpeechCoreDeps['post']
  exit: SpeechCoreDeps['exit']
}): { receive: (raw: unknown) => void } {
  const core = createSpeechCore({
    engine: createFakeEngine(deps.env),
    post: deps.post,
    exit: deps.exit,
    partialGapMs: 0
  })
  return {
    receive(raw) {
      const m = raw as { type?: unknown; utteranceId?: unknown } | null
      if (m?.type === 'begin' && m.utteranceId === FAKE_CRASH_UTTERANCE) {
        deps.exit(1)
        return
      }
      core.receive(raw)
    }
  }
}
