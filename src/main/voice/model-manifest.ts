import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { KOKORO_VOICES, type VoiceModelKind } from '@shared/types/voice'

export interface VoiceModelFile {
  /** Path inside the model folder and on the server, always `/`-separated, no `..`. */
  path: string
  sha256: string
  bytes: number
}

export interface VoiceModelSpec {
  id: string
  kind: VoiceModelKind
  /** Names the folder `<id>@<version>`; bump it when the pinned files change. */
  version: string
  /** Every file is fetched from `${baseUrl}/${file.path}`. Always pinned to a commit, never a branch. */
  baseUrl: string
  files: readonly VoiceModelFile[]
}

const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const ZIPFORMER_REVISION = 'd42f2d9f7ca24806fb667456a18a9f1b60f70d16'
const WHISPER_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'

/** The voices Settings offers (each about 0.5 MB). `af_heart` is the default. */
export { KOKORO_VOICES }

const VOICE_SHA256: Record<(typeof KOKORO_VOICES)[number], string> = {
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc'
}
const VOICE_BYTES = 522_240

/**
 * The pinned speech models. Hashes and sizes were measured on the files themselves (spikes N1 and
 * N2): Kokoro-82M fp32 (the only dtype that is intelligible on WebGPU), the sherpa-onnx streaming
 * Zipformer en-20M int8 files, and Whisper base.en.
 */
export const VOICE_MODELS: readonly VoiceModelSpec[] = [
  {
    id: 'kokoro',
    kind: 'tts',
    version: KOKORO_REVISION.slice(0, 7),
    baseUrl: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_REVISION}`,
    files: [
      {
        path: 'onnx/model.onnx',
        sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
        bytes: 325_532_232
      },
      {
        path: 'config.json',
        sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
        bytes: 44
      },
      {
        path: 'tokenizer.json',
        sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
        bytes: 3497
      },
      {
        path: 'tokenizer_config.json',
        sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
        bytes: 113
      },
      ...KOKORO_VOICES.map((voice) => ({
        path: `voices/${voice}.bin`,
        sha256: VOICE_SHA256[voice],
        bytes: VOICE_BYTES
      }))
    ]
  },
  {
    id: 'zipformer-en-20m',
    kind: 'stt-stream',
    version: ZIPFORMER_REVISION.slice(0, 7),
    baseUrl: `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/${ZIPFORMER_REVISION}`,
    files: [
      {
        path: 'encoder-epoch-99-avg-1.int8.onnx',
        sha256: '3810755ce7c3ab26b42a8bcf39d191308fa27fb0f53358823ba46141d03b7eb3',
        bytes: 42_845_182
      },
      {
        path: 'decoder-epoch-99-avg-1.int8.onnx',
        sha256: '21e2a2acd961b3ac72f55be2f10f1a285e1b0b0ba010d7c0b6eab141411b163c',
        bytes: 539_499
      },
      {
        path: 'joiner-epoch-99-avg-1.int8.onnx',
        sha256: 'e085d73b593cf9b0707f370dbd656d58327d3fe36d80d849202ef81df02cb01e',
        bytes: 259_572
      },
      {
        path: 'tokens.txt',
        sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb',
        bytes: 5048
      }
    ]
  },
  {
    id: 'whisper-base-en',
    kind: 'stt-final',
    version: WHISPER_REVISION.slice(0, 7),
    baseUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REVISION}`,
    files: [
      {
        path: 'ggml-base.en.bin',
        sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
        bytes: 147_964_211
      }
    ]
  }
]

export const modelBytes = (model: VoiceModelSpec): number =>
  model.files.reduce((sum, file) => sum + file.bytes, 0)

/** Download size of every model together (about 520 MB). */
export const VOICE_MODELS_TOTAL_BYTES = VOICE_MODELS.reduce((sum, m) => sum + modelBytes(m), 0)

export const fileUrl = (model: VoiceModelSpec, file: VoiceModelFile): string =>
  `${model.baseUrl}/${file.path}`

const safePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  )

const manifestSchema = z.array(
  z
    .object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      kind: z.enum(['tts', 'stt-stream', 'stt-final']),
      version: z.string().regex(/^[0-9a-z.-]+$/),
      baseUrl: z.string().url(),
      files: z
        .array(
          z
            .object({
              path: safePath,
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
              bytes: z.number().int().nonnegative()
            })
            .strict()
        )
        .min(1)
    })
    .strict()
)

/** Swaps the origin of a URL, keeping its path (and so the pin). */
const withOrigin = (url: string, origin: string): string => {
  const parsed = new URL(url)
  return `${origin.replace(/\/+$/, '')}${parsed.pathname}`
}

/**
 * The manifest to use. Test-only overrides apply only when `HARNESS_E2E=1`:
 * `HARNESS_VOICE_MODEL_MANIFEST` (a JSON file with the same shape, for stub files with their own
 * hashes) and `HARNESS_VOICE_MODEL_BASE_URL` (replaces the origin of every URL). Otherwise the
 * pinned manifest is returned as is.
 */
export function resolveManifest(
  env: NodeJS.ProcessEnv,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8')
): readonly VoiceModelSpec[] {
  if (env['HARNESS_E2E'] !== '1') return VOICE_MODELS
  const manifestPath = env['HARNESS_VOICE_MODEL_MANIFEST']
  const base = manifestPath
    ? (manifestSchema.parse(JSON.parse(readText(manifestPath))) as VoiceModelSpec[])
    : VOICE_MODELS
  const origin = env['HARNESS_VOICE_MODEL_BASE_URL']
  return origin ? base.map((m) => ({ ...m, baseUrl: withOrigin(m.baseUrl, origin) })) : base
}
