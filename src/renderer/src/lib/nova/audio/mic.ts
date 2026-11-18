import workletUrl from './mic-worklet.ts?worker&url'
import {
  ChunkRing,
  MIC_SAMPLE_RATE,
  MicError,
  PRE_ROLL_CHUNKS,
  levelFromRms,
  type Mic
} from './listen-types'

/** Never `echoCancellation: 'all'`: plain `true` is what keeps Nova's own voice out of the mic (N3). */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
}

function failureOf(error: unknown): MicError {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return new MicError('denied')
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return new MicError('unavailable')
  }
  return new MicError('failed')
}

/** Opens the microphone: a 16 kHz mono Int16 chunk stream, a pre-roll buffer and a level meter. */
export async function openMic(): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
  } catch (error) {
    throw failureOf(error)
  }
  const context = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => undefined)
  }
  try {
    await context.audioWorklet.addModule(workletUrl)
    await context.resume()
  } catch {
    release()
    throw new MicError('failed')
  }

  const source = context.createMediaStreamSource(stream)
  const chunker = new AudioWorkletNode(context, 'arc-mic-chunker')
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  // The worklet's output is silent; it only has to be connected for the browser to pull the graph.
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(chunker)
  source.connect(analyser)
  chunker.connect(mute)
  mute.connect(context.destination)

  const ring = new ChunkRing(PRE_ROLL_CHUNKS + 2)
  const listeners = new Set<(chunk: Int16Array) => void>()
  chunker.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    const chunk = new Int16Array(event.data)
    ring.push(chunk)
    for (const listener of listeners) listener(chunk)
  }
  const samples = new Float32Array(analyser.fftSize)

  return {
    stream,
    context,
    level() {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const v of samples) sum += v * v
      return levelFromRms(Math.sqrt(sum / samples.length))
    },
    onChunk(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recent: (count) => ring.recent(count),
    close() {
      listeners.clear()
      chunker.port.onmessage = null
      source.disconnect()
      chunker.disconnect()
      release()
    }
  }
}
