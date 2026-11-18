import { join } from 'node:path'
import type { SpeechEngine } from './speech-core'

/** The part of `sherpa-onnx-node` the live stream uses (the package has no type declarations). */
export interface SherpaStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
}

export interface SherpaRecognizer {
  createStream(): SherpaStream
  isReady(stream: SherpaStream): boolean
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text?: string }
}

export interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => SherpaRecognizer
}

/**
 * Layers the streaming Zipformer (live words) over a final-text engine. It is best effort: when the
 * folder is missing, the model will not load or a decode throws, the base engine keeps working and
 * `load` reports `partials: false`. The Zipformer mangles the first word, so it never supplies the
 * final text. Nothing here may log audio or text.
 */
export function withZipformer(
  base: SpeechEngine,
  loadModule: () => Promise<SherpaModule>
): SpeechEngine {
  let recognizer: SherpaRecognizer | undefined
  let stream: SherpaStream | undefined
  return {
    async load(paths) {
      await base.load(paths)
      if (!paths.zipformer) return { partials: false }
      try {
        const sherpa = await loadModule()
        const dir = paths.zipformer
        recognizer = new sherpa.OnlineRecognizer({
          featConfig: { sampleRate: 16_000, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: join(dir, 'encoder-epoch-99-avg-1.int8.onnx'),
              decoder: join(dir, 'decoder-epoch-99-avg-1.int8.onnx'),
              joiner: join(dir, 'joiner-epoch-99-avg-1.int8.onnx')
            },
            tokens: join(dir, 'tokens.txt'),
            numThreads: 2,
            provider: 'cpu',
            debug: 0
          },
          decodingMethod: 'greedy_search',
          enableEndpoint: false
        })
        stream = recognizer.createStream()
        return { partials: true }
      } catch {
        recognizer = undefined
        stream = undefined
        return { partials: false }
      }
    },
    transcribe: (pcm) => base.transcribe(pcm),
    release: () => {
      recognizer = undefined
      stream = undefined
      return base.release()
    },
    streamReset() {
      if (recognizer) stream = recognizer.createStream()
    },
    streamPcm(pcm) {
      if (!recognizer || !stream) return ''
      const samples = new Float32Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768
      stream.acceptWaveform({ samples, sampleRate: 16_000 })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      return recognizer.getResult(stream).text ?? ''
    }
  }
}
