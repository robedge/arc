import type { MouthSample, MouthTrack } from '../mouth-track'
import { CLOSED, MOUTH_LEAD_S } from '../mouth-track'

/** Plays 24 kHz mono speech. Kokoro's output rate; the fake engine uses it too. */
export const SPEECH_SAMPLE_RATE = 24000

export interface Player {
  /** Queues a buffer behind what is playing; resolves when it has played, or when `flush()` cut it off. */
  play(pcm: Float32Array, track?: MouthTrack): Promise<void>
  /** Stops everything that is playing or queued. */
  flush(): void
  /** RMS of what is playing now, 0 to 1 (drives the face and glow in later slices). */
  readonly level: number
  /**
   * Where the mouth should be right now, read from the track of whatever is audible and shifted by
   * `MOUTH_LEAD_S` so it anticipates the sound. Undefined when nothing with a track is playing
   * (the face then falls back to `level`).
   */
  mouth?(): MouthSample | undefined
}

interface Queued {
  source: AudioBufferSourceNode
  resolve: () => void
  startAt: number
  duration: number
  track: MouthTrack | undefined
}

/** One `AudioContext` for the whole app, a queue of buffer sources and an analyser for the level. */
export class Playback implements Player {
  private context: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private samples: Float32Array<ArrayBuffer> | undefined
  private nextStart = 0
  private readonly queued = new Set<Queued>()

  private ensure(): { context: AudioContext; analyser: AnalyserNode } {
    if (!this.context || !this.analyser) {
      this.context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE })
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.context.destination)
      this.samples = new Float32Array(this.analyser.fftSize)
    }
    return { context: this.context, analyser: this.analyser }
  }

  play(pcm: Float32Array, track?: MouthTrack): Promise<void> {
    const { context, analyser } = this.ensure()
    if (context.state === 'suspended') void context.resume()
    const buffer = context.createBuffer(1, pcm.length, SPEECH_SAMPLE_RATE)
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(analyser)
    const startAt = Math.max(context.currentTime, this.nextStart)
    this.nextStart = startAt + buffer.duration
    return new Promise<void>((resolve) => {
      const entry: Queued = { source, resolve, startAt, duration: buffer.duration, track }
      this.queued.add(entry)
      source.onended = () => {
        this.queued.delete(entry)
        resolve()
      }
      source.start(startAt)
    })
  }

  flush(): void {
    for (const entry of this.queued) {
      entry.source.onended = null
      try {
        entry.source.stop()
      } catch {
        // Already stopped.
      }
      entry.source.disconnect()
      entry.resolve()
    }
    this.queued.clear()
    this.nextStart = 0
  }

  mouth(): MouthSample | undefined {
    const context = this.context
    if (!context || this.queued.size === 0) return undefined
    // What is audible now left the context `outputLatency` ago; the lead then runs the mouth ahead of it.
    const heard = context.currentTime - (context.outputLatency || 0)
    const t = heard + MOUTH_LEAD_S
    let tracked = false
    for (const entry of this.queued) {
      if (!entry.track) continue
      tracked = true
      if (t >= entry.startAt && t < entry.startAt + entry.duration) {
        return entry.track.sample(t - entry.startAt)
      }
    }
    return tracked ? CLOSED : undefined
  }

  get level(): number {
    if (!this.analyser || !this.samples || this.queued.size === 0) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const v of this.samples) sum += v * v
    return Math.min(1, Math.sqrt(sum / this.samples.length))
  }
}
