import { ModelLoadError } from './speech-core'
import type { SpeechEngine } from './speech-core'

export interface WhisperContext {
  transcribeData(
    audio: ArrayBuffer,
    options?: { language?: string }
  ): { promise: Promise<{ result: string }> }
  release?: () => Promise<void>
}

export interface WhisperModule {
  initWhisper(options: { filePath: string; useGpu?: boolean }): Promise<WhisperContext>
}

/** Half a second of silence: enough to build the Metal kernels, which otherwise cost the first utterance ~0.6 s. */
const WARM_UP_SAMPLES = 8000

/**
 * Whisper behind the speech core. The model is loaded once per process, on the GPU (Metal) where it
 * can be (about 0.1 s per utterance against 0.6-1.1 s on the CPU, measured on an M1 Pro), else on the CPU.
 * Nothing here may log audio or text.
 */
export function createWhisperEngine(loadModule: () => Promise<WhisperModule>): SpeechEngine {
  let context: WhisperContext | undefined
  return {
    async load({ whisper }) {
      const lib = await loadModule()
      for (const useGpu of [true, false]) {
        try {
          context = await lib.initWhisper({ filePath: whisper, useGpu })
          break
        } catch {
          // Try the CPU next; after that the file itself is the problem.
        }
      }
      if (!context) throw new ModelLoadError('whisper model could not be loaded')
      await context.transcribeData(new Int16Array(WARM_UP_SAMPLES).buffer, { language: 'en' })
        .promise
    },
    async transcribe(pcm) {
      if (!context) throw new Error('engine not loaded')
      // The addon wants the PCM16 little-endian bytes; a Float32 buffer gives an empty result.
      const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
      return (await context.transcribeData(bytes, { language: 'en' }).promise).result
    },
    async release() {
      await context?.release?.()
      context = undefined
    }
  }
}
