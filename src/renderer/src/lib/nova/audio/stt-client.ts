import type { SttClient } from './listen-types'

/** The speech recogniser in the main process, over the `voice:*` channels. One utterance at a time. */
export class IpcSttClient implements SttClient {
  utteranceId: string | null = null
  private seq = 0
  /** Resolves true once main accepted `begin`; every chunk and the end wait on it, in order. */
  private started: Promise<boolean> = Promise.resolve(false)

  begin(preRoll: readonly Int16Array[]): void {
    const id = crypto.randomUUID()
    this.utteranceId = id
    this.seq = 0
    this.started = window.arc
      .invoke('voice:begin-utterance', { utteranceId: id })
      .then((result) => result.ok)
      .catch(() => false)
    for (const chunk of preRoll) this.push(chunk)
  }

  push(chunk: Int16Array): void {
    const id = this.utteranceId
    if (id === null) return
    const seq = this.seq++
    const samples = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength
    ) as ArrayBuffer
    void this.started.then((ok) => {
      if (ok) window.arc.send('voice:pcm', { utteranceId: id, seq, samples })
    })
  }

  async end(): Promise<string> {
    const id = this.utteranceId
    this.utteranceId = null
    if (id === null) return ''
    // Registered after every chunk above, so the end reaches main after the audio.
    if (!(await this.started)) throw new Error('utterance did not start')
    const result = await window.arc.invoke('voice:end-utterance', { utteranceId: id })
    if (!result.ok) throw new Error(result.error.code)
    return result.data.text
  }

  cancel(): void {
    const id = this.utteranceId
    this.utteranceId = null
    if (id === null) return
    void this.started.then((ok) => {
      if (ok) void window.arc.invoke('voice:cancel-utterance', { utteranceId: id })
    })
  }
}
