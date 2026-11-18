import type { TtsEngine } from '../engines'
import type { TtsWorkerRequest, TtsWorkerResponse } from './tts-protocol'

const WARM_SENTENCE = 'Hello there.'

interface Pending {
  resolve: (response: TtsWorkerResponse) => void
  reject: (error: Error) => void
}

type NewRequest = TtsWorkerRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never

/** Talks to the Kokoro module worker. The worker is created on first use, so a muted app never loads it. */
export class WorkerTtsEngine implements TtsEngine {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private warming: Promise<void> | undefined

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<TtsWorkerResponse>) => {
      const entry = this.pending.get(event.data.id)
      if (!entry) return
      this.pending.delete(event.data.id)
      entry.resolve(event.data)
    }
    worker.onerror = () => this.failAll(new Error('tts worker failed'))
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
    this.worker?.terminate()
    this.worker = undefined
    this.warming = undefined
  }

  private request(message: NewRequest): Promise<TtsWorkerResponse> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ ...message, id } as TtsWorkerRequest)
    })
  }

  /** Loads the model and runs a throwaway synth so the first real sentence is not slow. */
  warm(): Promise<void> {
    this.warming ??= (async () => {
      const loaded = await this.request({ type: 'load' })
      if (!loaded.ok) throw new Error(loaded.error)
      const synth = await this.request({
        type: 'synth',
        text: WARM_SENTENCE,
        voice: 'af_heart',
        speed: 1
      })
      if (!synth.ok) throw new Error(synth.error)
    })().catch((error: unknown) => {
      this.warming = undefined
      throw error
    })
    return this.warming
  }

  async synth(sentence: string, voiceId: string, speed: number): Promise<Float32Array> {
    await this.warm()
    const response = await this.request({ type: 'synth', text: sentence, voice: voiceId, speed })
    if (!response.ok) throw new Error(response.error)
    if (!('audio' in response)) throw new Error('tts returned no audio')
    return response.audio
  }

  dispose(): void {
    this.failAll(new Error('tts disposed'))
  }
}
