import { BargeInDetector } from './barge-in'
import {
  VAD_REDEMPTION_MS,
  type Vad,
  type VadCallbacks,
  type VadOptions,
  type Mic
} from './listen-types'

/** Silero VAD v5 thresholds (N3): speech above 0.5, back to silence below 0.35. */
export const VAD_POSITIVE = 0.5
export const VAD_NEGATIVE = 0.35
export const VAD_MIN_SPEECH_MS = 250
/** The detector keeps this much audio from before the speech began; the pre-roll sent on starts from the mic buffer. */
export const VAD_PRE_SPEECH_PAD_MS = 500

/**
 * Wraps `@ricky0123/vad-web`. Its worklet, Silero model and onnxruntime WASM are served from the app
 * itself (`vad/` next to the page); nothing loads from a CDN.
 */
export async function createVad(
  mic: Mic,
  callbacks: VadCallbacks,
  options: VadOptions
): Promise<Vad> {
  const bargeIn = new BargeInDetector()
  const stream = mic.stream
  if (!stream || !mic.context) throw new Error('vad needs a live microphone')
  const { MicVAD } = await import('@ricky0123/vad-web')
  const base = new URL('./vad/', location.href).href
  const vad = await MicVAD.new({
    model: 'v5',
    audioContext: mic.context,
    baseAssetPath: base,
    onnxWASMBasePath: base,
    // The mic owns the stream and the context; the detector only listens to them.
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    positiveSpeechThreshold: VAD_POSITIVE,
    negativeSpeechThreshold: VAD_NEGATIVE,
    redemptionMs: VAD_REDEMPTION_MS,
    minSpeechMs: VAD_MIN_SPEECH_MS,
    preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
    ortConfig: (ort) => {
      ort.env.logLevel = 'error'
      ort.env.wasm.numThreads = 1
    },
    // Fires at the first speech frame, so a short "um" during a pause resumes the held utterance.
    onSpeechStart: () => callbacks.onSpeechResume(),
    // `onSpeechRealStart` only fires once the speech lasted `minSpeechMs`, so a click is no turn.
    onSpeechRealStart: () => callbacks.onSpeechStart(),
    onSpeechEnd: () => callbacks.onSpeechEnd(),
    // While Nova speaks, a higher bar (0.65 held for 400 ms) tells the user from Nova's own echo (N3).
    onFrameProcessed: (probabilities) => {
      if (!options.bargeInActive()) bargeIn.reset()
      else if (bargeIn.push(probabilities.isSpeech)) callbacks.onBargeIn()
    },
    startOnLoad: false
  })
  await vad.start()
  return { destroy: () => vad.destroy() }
}
