// Runs in the AudioWorklet scope: batches the 16 kHz mono input into 100 ms Int16 chunks.
// The audio context itself runs at 16 kHz, so the browser does the resampling.
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const CHUNK_SAMPLES = 1600

class MicChunker extends AudioWorkletProcessor {
  private buffer = new Int16Array(CHUNK_SAMPLES)
  private filled = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]!))
      this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      if (this.filled === CHUNK_SAMPLES) {
        const out = this.buffer
        this.port.postMessage(out.buffer, [out.buffer])
        this.buffer = new Int16Array(CHUNK_SAMPLES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('arc-mic-chunker', MicChunker)

export {}
