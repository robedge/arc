import { describe, expect, it, vi } from 'vitest'
import type { SpeechEngine } from '../../../src/main/voice/speech-core'
import { withZipformer } from '../../../src/main/voice/zipformer-engine'
import type { SherpaModule, SherpaStream } from '../../../src/main/voice/zipformer-engine'

const base = (): SpeechEngine => ({
  load: vi.fn(() => Promise.resolve()),
  transcribe: () => Promise.resolve('whisper'),
  release: () => Promise.resolve()
})

function sherpa() {
  const fed: Float32Array[] = []
  let ready = 0
  const created: SherpaStream[] = []
  const config: unknown[] = []
  const mod: SherpaModule = {
    OnlineRecognizer: class {
      constructor(c: unknown) {
        config.push(c)
      }
      createStream(): SherpaStream {
        const s = { acceptWaveform: (i: { samples: Float32Array }) => fed.push(i.samples) }
        created.push(s)
        return s
      }
      isReady(): boolean {
        return ready-- > 0
      }
      decode(): void {}
      getResult(): { text?: string } {
        return { text: 'HELLO' }
      }
    }
  }
  return { mod, fed, created, config, setReady: (n: number) => (ready = n) }
}

describe('zipformer engine', () => {
  it('feeds Float32 samples, decodes while ready and returns the text', async () => {
    const s = sherpa()
    const engine = withZipformer(base(), () => Promise.resolve(s.mod))
    await expect(engine.load({ whisper: '/w', zipformer: '/z' })).resolves.toEqual({
      partials: true
    })
    s.setReady(2)
    expect(engine.streamPcm?.(new Int16Array([16384, -32768]))).toBe('HELLO')
    expect([...(s.fed[0] ?? [])]).toEqual([0.5, -1])
    expect(JSON.stringify(s.config[0])).toContain('/z/encoder-epoch-99-avg-1.int8.onnx')
  })

  it('starts a new stream on reset', async () => {
    const s = sherpa()
    const engine = withZipformer(base(), () => Promise.resolve(s.mod))
    await engine.load({ whisper: '/w', zipformer: '/z' })
    engine.streamReset?.()
    expect(s.created).toHaveLength(2)
  })

  it('works with Whisper alone without a folder or when the model will not load', async () => {
    const none = withZipformer(base(), () => Promise.reject(new Error('x')))
    await expect(none.load({ whisper: '/w' })).resolves.toEqual({ partials: false })
    expect(none.streamPcm?.(new Int16Array(4))).toBe('')
    const broken = withZipformer(base(), () => Promise.reject(new Error('x')))
    await expect(broken.load({ whisper: '/w', zipformer: '/z' })).resolves.toEqual({
      partials: false
    })
    await expect(broken.transcribe(new Int16Array(1))).resolves.toBe('whisper')
  })
})
