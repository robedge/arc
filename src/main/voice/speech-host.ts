import { AppErrorException } from '@shared/errors'
import type { VoiceEngineState, VoiceErrorCode } from '@shared/types/voice'
import { fromWorkerSchema } from './speech-protocol'
import type { ToWorker } from './speech-protocol'

/** One forked speech process, as the host sees it (a `utilityProcess` in the app, a loopback in tests). */
export interface SpeechWorkerHandle {
  postMessage(message: ToWorker): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

export interface SpeechHostDeps {
  fork: () => SpeechWorkerHandle
  /** The Whisper model file, or undefined while that model is not ready. */
  whisperModelPath: () => Promise<string | undefined>
  /** The Zipformer folder, or undefined while that model is not ready (the engine then gives no partials). */
  zipformerModelPath: () => Promise<string | undefined>
  emitState: (state: VoiceEngineState) => void
  /** Words heard so far in an open utterance; the text must never be logged. */
  emitPartial: (partial: { utteranceId: string; text: string }) => void
  emitError: (error: { code: VoiceErrorCode; utteranceId?: string }) => void
  /** Codes and lifecycle only; never audio, text or paths. */
  log: { debug: (message: string) => void; warn: (message: string) => void }
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  idleMs?: number
  startTimeoutMs?: number
}

export const SPEECH_IDLE_MS = 60_000
/** The first Whisper load compiles Metal shaders (about 6 s); this only catches a load that never ends. */
export const SPEECH_START_TIMEOUT_MS = 30_000
/** Crashes the host restarts after on its own; the next one is reported as `engine-crashed`. */
const MAX_AUTO_RESTARTS = 1

interface PendingEnd {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

/**
 * Supervises the speech utility process: forked on `open` (or on the first utterance after an idle
 * stop), stopped after 60 s without activity, on `close` and at quit, and restarted once when it
 * dies. Requests arriving while the model loads are posted at once; the worker runs them in order.
 */
export class SpeechHost {
  private worker: SpeechWorkerHandle | undefined
  private state: VoiceEngineState = 'off'
  private restarts = 0
  private starting: Promise<void> | undefined
  private readonly active = new Set<string>()
  private readonly pendingEnds = new Map<string, PendingEnd>()
  private idleTimer: unknown
  private startTimer: unknown
  private readonly idleMs: number
  private readonly startTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: SpeechHostDeps) {
    this.idleMs = deps.idleMs ?? SPEECH_IDLE_MS
    this.startTimeoutMs = deps.startTimeoutMs ?? SPEECH_START_TIMEOUT_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
  }

  get engineState(): VoiceEngineState {
    return this.state
  }

  /** Starts the engine if it is not running. Error `VOICE_MODEL_MISSING` while Whisper is not ready. */
  async open(): Promise<void> {
    if (this.state === 'failed') this.restarts = 0
    await this.ensureRunning()
    this.touch()
  }

  /** Stops the engine; a transcription still waiting is refused. */
  close(): void {
    this.stop('off')
  }

  dispose(): void {
    this.stop('off')
  }

  async beginUtterance(utteranceId: string): Promise<void> {
    await this.ensureRunning()
    this.active.add(utteranceId)
    this.send({ type: 'begin', utteranceId })
    this.touch()
  }

  /** Dropped when no engine is running (an utterance that was cut off by a stop). */
  pcm(utteranceId: string, seq: number, samples: ArrayBuffer): void {
    if (!this.worker || !this.active.has(utteranceId)) return
    this.send({ type: 'pcm', utteranceId, seq, samples })
    this.touch()
  }

  endUtterance(utteranceId: string): Promise<string> {
    if (!this.worker || !this.active.has(utteranceId)) {
      return Promise.reject(new AppErrorException('INTERNAL'))
    }
    this.active.delete(utteranceId)
    return new Promise<string>((resolve, reject) => {
      this.pendingEnds.set(utteranceId, { resolve, reject })
      this.send({ type: 'end', utteranceId })
      this.touch()
    })
  }

  cancelUtterance(utteranceId: string): void {
    this.active.delete(utteranceId)
    if (this.worker) this.send({ type: 'cancel', utteranceId })
    this.touch()
  }

  private async ensureRunning(): Promise<void> {
    if (this.worker) return
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    await this.starting
  }

  private async start(): Promise<void> {
    const modelPath = await this.deps.whisperModelPath()
    if (!modelPath) throw new AppErrorException('VOICE_MODEL_MISSING')
    // A missing or broken streaming model only costs the live words, never the engine.
    const zipformer = await this.deps.zipformerModelPath().catch(() => undefined)
    if (!zipformer) this.deps.log.debug('speech partials off: zipformer not ready')
    this.fork(modelPath, zipformer)
  }

  private fork(modelPath: string, zipformer: string | undefined): void {
    const worker = this.deps.fork()
    this.worker = worker
    this.setState('starting')
    worker.onMessage((raw) => {
      if (this.worker === worker) this.onWorkerMessage(raw)
    })
    worker.onExit((code) => {
      if (this.worker === worker) this.onWorkerExit(code)
    })
    this.startTimer = this.setTimer(() => this.onStartTimeout(worker), this.startTimeoutMs)
    worker.postMessage({
      type: 'init',
      modelPaths: { whisper: modelPath, ...(zipformer ? { zipformer } : {}) }
    })
  }

  private onWorkerMessage(raw: unknown): void {
    const parsed = fromWorkerSchema.safeParse(raw)
    if (!parsed.success) {
      this.deps.log.warn('speech worker sent an invalid message')
      return
    }
    const message = parsed.data
    switch (message.type) {
      case 'ready':
        if (message.partials === false) this.deps.log.debug('speech partials off: zipformer failed')
        this.clearStartTimer()
        this.setState('ready')
        return
      case 'partial':
        // Only while the utterance is open: one that has ended or been cancelled shows no more words.
        if (this.active.has(message.utteranceId)) {
          this.deps.emitPartial({ utteranceId: message.utteranceId, text: message.text })
        }
        return
      case 'final': {
        const pending = this.pendingEnds.get(message.utteranceId)
        this.pendingEnds.delete(message.utteranceId)
        this.restarts = 0
        pending?.resolve(message.text)
        this.touch()
        return
      }
      case 'error': {
        this.deps.log.warn(`speech worker error ${message.code}`)
        if (message.utteranceId) {
          this.settleEnd(message.utteranceId)
          this.deps.emitError({ code: message.code, utteranceId: message.utteranceId })
          return
        }
        // A model that will not load is not retried: the same file fails the same way.
        this.stop('failed')
        this.deps.emitError({ code: message.code })
        return
      }
    }
  }

  private onWorkerExit(code: number): void {
    this.deps.log.warn(`speech worker exited with code ${code}`)
    this.worker = undefined
    this.clearStartTimer()
    this.clearIdleTimer()
    this.refuseAll()
    if (this.restarts < MAX_AUTO_RESTARTS) {
      this.restarts += 1
      this.deps.log.debug('restarting the speech worker')
      this.starting = this.start()
        .catch(() => {
          this.setState('failed')
          this.deps.emitError({ code: 'engine-crashed' })
        })
        .finally(() => {
          this.starting = undefined
        })
      return
    }
    this.setState('failed')
    this.deps.emitError({ code: 'engine-crashed' })
  }

  private onStartTimeout(worker: SpeechWorkerHandle): void {
    if (this.worker !== worker || this.state !== 'starting') return
    this.deps.log.warn('speech worker did not become ready in time')
    this.stop('failed')
    this.deps.emitError({ code: 'engine-crashed' })
  }

  /** Stops the process on purpose: not a crash, so there is no restart. */
  private stop(next: 'off' | 'failed'): void {
    const worker = this.worker
    this.worker = undefined
    this.clearStartTimer()
    this.clearIdleTimer()
    this.refuseAll()
    if (worker) {
      try {
        worker.postMessage({ type: 'shutdown' })
      } catch {
        // already gone
      }
      worker.kill()
    }
    this.setState(next)
  }

  private refuseAll(): void {
    this.active.clear()
    for (const id of [...this.pendingEnds.keys()]) this.settleEnd(id)
  }

  private settleEnd(utteranceId: string): void {
    const pending = this.pendingEnds.get(utteranceId)
    this.pendingEnds.delete(utteranceId)
    pending?.reject(new AppErrorException('INTERNAL'))
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message)
  }

  private setState(next: VoiceEngineState): void {
    if (this.state === next) return
    this.state = next
    this.deps.emitState(next)
  }

  /** Any activity restarts the idle clock; it only runs while nothing is being said or transcribed. */
  private touch(): void {
    this.clearIdleTimer()
    if (!this.worker || this.active.size > 0 || this.pendingEnds.size > 0) return
    this.idleTimer = this.setTimer(() => {
      this.deps.log.debug('stopping the idle speech worker')
      this.stop('off')
    }, this.idleMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer)
    this.idleTimer = undefined
  }

  private clearStartTimer(): void {
    if (this.startTimer !== undefined) this.clearTimer(this.startTimer)
    this.startTimer = undefined
  }
}
