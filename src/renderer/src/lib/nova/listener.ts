import { holdMs } from './end-of-turn'
import {
  MicError,
  VAD_REDEMPTION_MS,
  PRE_ROLL_CHUNKS,
  type ListenEngines,
  type Mic,
  type Vad
} from './audio/listen-types'

export interface ListenerHooks {
  /** True while a new turn may begin: Nova is listening and no earlier turn is being recognised. */
  canStart(): boolean
  /** True while Nova speaks in a running conversation and is not muted. */
  canBargeIn(): boolean
  onSpeechStart(): void
  /** The user talked over Nova; the turn is already capturing when this returns. */
  onBargeIn(): void
  onSpeechEnd(): void
  /** The recognised words; '' when nothing was understood or recognition failed. */
  onFinal(text: string): void
  /** Microphone level 0..1, about every 50 ms while the microphone is open. */
  onLevel(level: number): void
}

const LEVEL_POLL_MS = 50

/** Owns the microphone, the voice detector and the current utterance for one conversation. */
export class Listener {
  private mic: Mic | null = null
  private vad: Vad | null = null
  private unsubscribe: (() => void) | null = null
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private capturing = false
  /** Silence began and the turn is held open: when, and the timer that ends it. */
  private silenceSince: number | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /** The live words of the current utterance, which pick the hold. */
  private partial = ''
  /** Bumped whenever the current utterance is dropped, so a late recognition result is ignored. */
  private turn = 0
  private generation = 0

  constructor(
    private readonly engines: () => ListenEngines,
    private readonly hooks: ListenerHooks,
    private readonly endPauseMs: () => number
  ) {}

  /** Opens the microphone and starts the detector. Throws `MicError`. Returns false if `stop()` ran meanwhile. */
  async start(): Promise<boolean> {
    this.stop()
    const generation = this.generation
    const engines = this.engines()
    const mic = await engines.openMic()
    if (generation !== this.generation) {
      mic.close()
      return false
    }
    this.mic = mic
    this.unsubscribe = mic.onChunk((chunk) => {
      if (this.capturing) engines.stt.push(chunk)
    })
    this.levelTimer = setInterval(() => this.hooks.onLevel(mic.level()), LEVEL_POLL_MS)
    try {
      const vad = await engines.createVad(
        mic,
        {
          onSpeechStart: () => this.speechStart(),
          onSpeechResume: () => this.resume(),
          onSpeechEnd: () => this.speechEnd(),
          onBargeIn: () => this.bargeIn()
        },
        { bargeInActive: () => this.hooks.canBargeIn() }
      )
      if (generation !== this.generation) {
        await vad.destroy()
        return false
      }
      this.vad = vad
      return true
    } catch (error) {
      if (generation === this.generation) this.stop()
      throw error instanceof MicError ? error : new MicError('failed')
    }
  }

  stop(): void {
    this.generation++
    this.cancelUtterance()
    if (this.levelTimer !== null) clearInterval(this.levelTimer)
    this.levelTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    const vad = this.vad
    this.vad = null
    void vad?.destroy().catch(() => undefined)
    this.mic?.close()
    this.mic = null
    this.hooks.onLevel(0)
  }

  /** Drops the turn being captured; a result still on its way is ignored. */
  cancelUtterance(): void {
    this.turn++
    this.clearHold()
    this.partial = ''
    if (this.capturing) this.engines().stt.cancel()
    this.capturing = false
  }

  private bargeIn(): void {
    if (this.capturing || !this.hooks.canBargeIn()) return
    // The hook stops Nova and asks for `beginUtterance()`; the turn then runs like any other.
    this.hooks.onBargeIn()
  }

  /** Starts a turn now, with the audio from just before (the user is already talking). */
  beginUtterance(): void {
    const mic = this.mic
    if (!mic || this.capturing) return
    this.capturing = true
    this.partial = ''
    this.engines().stt.begin(mic.recent(PRE_ROLL_CHUNKS))
  }

  private speechStart(): void {
    const mic = this.mic
    if (!mic || this.capturing || !this.hooks.canStart()) return
    this.capturing = true
    this.partial = ''
    this.engines().stt.begin(mic.recent(PRE_ROLL_CHUNKS))
    this.hooks.onSpeechStart()
  }

  /** The live words so far; a late partial during a pause can change how long the pause is held. */
  onPartial(text: string): void {
    this.partial = text
    if (this.silenceSince !== null) this.scheduleHold()
  }

  /** Speech again before the hold ran out: the same utterance goes on. */
  private resume(): void {
    this.clearHold()
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    this.holdTimer = null
    this.silenceSince = null
  }

  /** The detector heard silence start: keep the utterance open and wait, longer if the words sound unfinished. */
  private speechEnd(): void {
    if (!this.capturing) return
    this.silenceSince = Date.now() - VAD_REDEMPTION_MS
    this.scheduleHold()
  }

  private scheduleHold(): void {
    if (this.silenceSince === null) return
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    const deadline = this.silenceSince + holdMs(this.partial, this.endPauseMs())
    this.holdTimer = setTimeout(() => this.endTurn(), Math.max(0, deadline - Date.now()))
  }

  private endTurn(): void {
    this.clearHold()
    if (!this.capturing) return
    this.capturing = false
    const turn = this.turn
    this.hooks.onSpeechEnd()
    this.engines()
      .stt.end()
      .then(
        (text) => text,
        () => ''
      )
      .then((text) => {
        if (turn === this.turn) this.hooks.onFinal(text)
      })
  }
}
