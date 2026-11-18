/** Messages between `tts-engine.ts` and `tts.worker.ts`. Never carries text back, only audio. */
export type TtsWorkerRequest =
  | { id: number; type: 'load' }
  | { id: number; type: 'synth'; text: string; voice: string; speed: number }

export type TtsWorkerResponse =
  | { id: number; ok: true; backend: 'webgpu' | 'wasm' }
  | { id: number; ok: true; audio: Float32Array }
  | { id: number; ok: false; error: string }
