import { createSpeechCore } from './speech-core'
import { createWhisperEngine } from './whisper-engine'
import type { WhisperModule } from './whisper-engine'
import { withZipformer } from './zipformer-engine'
import type { SherpaModule } from './zipformer-engine'

// The utility-process entry: Whisper (final text) and the sherpa-onnx Zipformer (live words) behind the speech core. Native addons load here, never in the
// renderer or the main process.

const core = createSpeechCore({
  engine: withZipformer(
    createWhisperEngine(async () => {
      // The addon is CommonJS: depending on the bundler its exports sit on the namespace or on `default`.
      const mod = (await import('@fugood/whisper.node')) as unknown as Partial<WhisperModule> & {
        default?: WhisperModule
      }
      return (mod.default ?? mod) as WhisperModule
    }),
    async () => {
      const mod = (await import('sherpa-onnx-node')) as unknown as Partial<SherpaModule> & {
        default?: SherpaModule
      }
      return (mod.default ?? mod) as SherpaModule
    }
  ),
  post: (message) => process.parentPort.postMessage(message),
  exit: (code) => process.exit(code)
})
process.parentPort.on('message', (event) => core.receive(event.data))
