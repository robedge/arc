// Kokoro in a module worker (spec 016, spike N2). Models come from arc-voice-model:, never the network.
import { env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
import ortMjs from '@ort/ort-wasm-simd-threaded.jsep.mjs?url'
import ortWasm from '@ort/ort-wasm-simd-threaded.jsep.wasm?url'
import type { TtsWorkerRequest, TtsWorkerResponse } from './tts-protocol'

const MODEL_ID = 'kokoro'
const MODEL_BASE = `arc-voice-model://${MODEL_ID}/`

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = 'arc-voice-model://'
env.useBrowserCache = false
const wasm = env.backends.onnx.wasm as { wasmPaths: unknown; numThreads?: number }
wasm.wasmPaths = {
  mjs: new URL(ortMjs, self.location.href).href,
  wasm: new URL(ortWasm, self.location.href).href
}

// kokoro-js hardcodes a huggingface.co URL for voice files; serve them from the local protocol.
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const voice = /huggingface\.co\/.*\/resolve\/main\/(voices\/.+)$/.exec(url)
  return voice ? realFetch(MODEL_BASE + voice[1], init) : realFetch(input, init)
}) as typeof fetch

const post = (message: TtsWorkerResponse, transfer: Transferable[] = []): void =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(
    message,
    transfer
  )

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

let tts: KokoroTTS | undefined
let loading: Promise<'webgpu' | 'wasm'> | undefined

/** WebGPU fp32 first. fp16 and the quantised files are garbled on WebGPU (N2), so fp32 is the only dtype shipped. */
async function load(): Promise<'webgpu' | 'wasm'> {
  if (await hasWebGpu()) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'webgpu' })
      return 'webgpu'
    } catch {
      // Fall through to the degraded single-thread WASM backend.
    }
  }
  // No cross-origin isolation on a file:// page, so ORT runs one thread: intelligible but slow.
  wasm.numThreads = 1
  tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'wasm' })
  return 'wasm'
}

self.onmessage = async (event: MessageEvent<TtsWorkerRequest>): Promise<void> => {
  const request = event.data
  try {
    if (request.type === 'load') {
      loading ??= load()
      post({ id: request.id, ok: true, backend: await loading })
      return
    }
    loading ??= load()
    await loading
    if (!tts) throw new Error('tts not loaded')
    const result = await tts.generate(request.text, {
      // The settings schema only allows the Kokoro voice names.
      voice: request.voice as 'af_heart',
      speed: request.speed
    })
    const audio = result.audio as Float32Array
    post({ id: request.id, ok: true, audio }, [audio.buffer])
  } catch (error: unknown) {
    loading = undefined
    post({ id: request.id, ok: false, error: error instanceof Error ? error.name : 'error' })
  }
}
