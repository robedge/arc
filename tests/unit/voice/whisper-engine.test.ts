import { describe, expect, it, vi } from 'vitest'
import { ModelLoadError } from '../../../src/main/voice/speech-core'
import { createWhisperEngine } from '../../../src/main/voice/whisper-engine'
import type { WhisperContext, WhisperModule } from '../../../src/main/voice/whisper-engine'

function fakeContext(result = ' hi '): WhisperContext & { calls: ArrayBuffer[] } {
  const calls: ArrayBuffer[] = []
  return {
    calls,
    transcribeData: (audio) => {
      calls.push(audio)
      return { promise: Promise.resolve({ result }) }
    }
  }
}

describe('whisper engine', () => {
  it('loads on the GPU, then warms up so the first utterance is not slow', async () => {
    const ctx = fakeContext()
    const initWhisper = vi.fn(() => Promise.resolve(ctx))
    const engine = createWhisperEngine(() => Promise.resolve({ initWhisper } as WhisperModule))
    await engine.load({ whisper: '/m.bin' })
    expect(initWhisper).toHaveBeenCalledTimes(1)
    expect(initWhisper).toHaveBeenCalledWith({ filePath: '/m.bin', useGpu: true })
    expect(ctx.calls).toHaveLength(1) // the warm-up
  })

  it('falls back to the CPU when the GPU cannot be used', async () => {
    const ctx = fakeContext()
    const initWhisper = vi
      .fn()
      .mockRejectedValueOnce(new Error('no metal'))
      .mockResolvedValueOnce(ctx)
    const engine = createWhisperEngine(() => Promise.resolve({ initWhisper } as WhisperModule))
    await engine.load({ whisper: '/m.bin' })
    expect(initWhisper.mock.calls.map((c) => (c[0] as { useGpu: boolean }).useGpu)).toEqual([
      true,
      false
    ])
  })

  it('reports a model that neither the GPU nor the CPU can load', async () => {
    const engine = createWhisperEngine(() =>
      Promise.resolve({ initWhisper: () => Promise.reject(new Error('bad')) })
    )
    await expect(engine.load({ whisper: '/m.bin' })).rejects.toBeInstanceOf(ModelLoadError)
  })

  it('loads once and sends the exact PCM16 bytes of each utterance', async () => {
    const ctx = fakeContext('hello')
    const initWhisper = vi.fn(() => Promise.resolve(ctx))
    const engine = createWhisperEngine(() => Promise.resolve({ initWhisper } as WhisperModule))
    await engine.load({ whisper: '/m.bin' })
    const pcm = new Int16Array([1, 2, 3, 4]).subarray(1, 3)
    await expect(engine.transcribe(pcm)).resolves.toBe('hello')
    await engine.transcribe(pcm)
    expect(initWhisper).toHaveBeenCalledTimes(1)
    expect([...new Int16Array(ctx.calls[1]!)]).toEqual([2, 3])
  })
})
