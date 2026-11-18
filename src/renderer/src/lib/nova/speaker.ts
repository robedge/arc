import { splitSentences } from '@shared/spoken-text'
import { SPEECH_SAMPLE_RATE, type Player } from './audio/playback'
import { computeMouthTrack } from './mouth-track'
import type { TtsEngine } from './engines'

export interface SpeakerDeps {
  engine: () => Promise<TtsEngine>
  player: () => Player
  /** Read for each sentence, so a change applies from the next one. */
  voice: () => { voiceId: string; speed: number }
  /** Everything queued has been played. */
  onDone: () => void
  onError: (error: unknown) => void
}

/** Speaks text sentence by sentence, synthesising one sentence ahead of what is playing. */
export class Speaker {
  private generation = 0
  private queue: string[] = []
  private running = false
  private sentences = 0

  constructor(private readonly deps: SpeakerDeps) {}

  /** Adds text behind whatever is already being spoken. */
  speak(text: string): void {
    this.queue.push(...splitSentences(text))
    if (!this.running) void this.run()
  }

  /** Stops playback at once and forgets everything queued. */
  stop(): void {
    this.generation++
    this.queue = []
    this.running = false
    this.deps.player().flush()
  }

  private async run(): Promise<void> {
    const generation = this.generation
    this.running = true
    const player = this.deps.player()
    try {
      const engine = await this.deps.engine()
      const synth = (sentence: string): Promise<Float32Array> => {
        const { voiceId, speed } = this.deps.voice()
        return engine.synth(sentence, voiceId, speed)
      }
      const takeNext = (): Promise<Float32Array> | undefined => {
        const sentence = this.queue.shift()
        if (sentence === undefined) return undefined
        const pending = synth(sentence)
        // Rejections surface where the result is awaited; this only avoids an early unhandled one.
        pending.catch(() => undefined)
        return pending
      }
      let ahead = takeNext()
      while (ahead) {
        let previous: Promise<void> | undefined
        const plays: Promise<void>[] = []
        while (ahead) {
          const pcm = await ahead
          if (generation !== this.generation) return
          // The mouth track is ready before the sentence plays, so the face follows the audio clock.
          const track = computeMouthTrack(pcm, SPEECH_SAMPLE_RATE, { seed: ++this.sentences })
          const play = player.play(pcm, track)
          plays.push(play)
          // Start the next sentence now; it synthesises while this one plays.
          ahead = takeNext()
          // Not before the previous sentence has finished: only one sentence ahead.
          if (previous) await previous
          if (generation !== this.generation) return
          previous = play
        }
        await Promise.all(plays)
        if (generation !== this.generation) return
        // An answer queued while the last sentence played joins the same run.
        ahead = takeNext()
      }
      if (generation !== this.generation) return
      this.running = false
      this.deps.onDone()
    } catch (error: unknown) {
      if (generation !== this.generation) return
      this.stop()
      this.deps.onError(error)
    }
  }
}
