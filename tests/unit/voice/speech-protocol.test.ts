import { describe, expect, it } from 'vitest'
import { fromWorkerSchema, toWorkerSchema } from '../../../src/main/voice/speech-protocol'
import { sendSchemas, VOICE_PCM_MAX_BYTES } from '../../../src/shared/ipc/contract'

describe('speech protocol, main to worker', () => {
  it('accepts each message of the protocol', () => {
    const messages = [
      { type: 'init', modelPaths: { whisper: '/m/ggml-base.en.bin' } },
      { type: 'begin', utteranceId: 'u1' },
      { type: 'pcm', utteranceId: 'u1', seq: 0, samples: new ArrayBuffer(3200) },
      { type: 'end', utteranceId: 'u1' },
      { type: 'cancel', utteranceId: 'u1' },
      { type: 'shutdown' }
    ]
    for (const m of messages) expect(toWorkerSchema.safeParse(m).success, m.type).toBe(true)
  })

  it('refuses an unknown type, a missing id and a bad chunk', () => {
    const bad = [
      { type: 'dance' },
      { type: 'begin' },
      { type: 'begin', utteranceId: '' },
      { type: 'pcm', utteranceId: 'u', seq: -1, samples: new ArrayBuffer(2) },
      { type: 'pcm', utteranceId: 'u', seq: 1.5, samples: new ArrayBuffer(2) },
      { type: 'pcm', utteranceId: 'u', seq: 0, samples: new ArrayBuffer(VOICE_PCM_MAX_BYTES + 2) },
      { type: 'pcm', utteranceId: 'u', seq: 0, samples: new ArrayBuffer(3) },
      { type: 'pcm', utteranceId: 'u', seq: 0, samples: new Int16Array(4) },
      { type: 'init', modelPaths: {} },
      null
    ]
    for (const m of bad) expect(toWorkerSchema.safeParse(m).success, JSON.stringify(m)).toBe(false)
  })
})

describe('speech protocol, partial text', () => {
  it('init may name the Zipformer folder, and nothing else', () => {
    const init = { type: 'init', modelPaths: { whisper: '/w.bin', zipformer: '/z' } }
    expect(toWorkerSchema.safeParse(init).success).toBe(true)
    expect(
      toWorkerSchema.safeParse({ type: 'init', modelPaths: { whisper: '/w', extra: '/x' } }).success
    ).toBe(false)
    expect(
      toWorkerSchema.safeParse({ type: 'init', modelPaths: { whisper: '/w', zipformer: '' } })
        .success
    ).toBe(false)
  })

  it('accepts a partial with its utterance id and text, and refuses one without either', () => {
    expect(
      fromWorkerSchema.safeParse({ type: 'partial', utteranceId: 'u', text: 'open the' }).success
    ).toBe(true)
    expect(fromWorkerSchema.safeParse({ type: 'partial', utteranceId: 'u' }).success).toBe(false)
    expect(fromWorkerSchema.safeParse({ type: 'partial', text: 'x' }).success).toBe(false)
  })

  it('ready may say partials are off', () => {
    expect(fromWorkerSchema.safeParse({ type: 'ready', partials: false }).success).toBe(true)
  })
})

describe('speech protocol, worker to main', () => {
  it('accepts ready, final and error', () => {
    expect(fromWorkerSchema.safeParse({ type: 'ready' }).success).toBe(true)
    expect(fromWorkerSchema.safeParse({ type: 'final', utteranceId: 'u', text: '' }).success).toBe(
      true
    )
    expect(
      fromWorkerSchema.safeParse({ type: 'error', utteranceId: 'u', code: 'engine-crashed' })
        .success
    ).toBe(true)
    expect(fromWorkerSchema.safeParse({ type: 'error', code: 'model-corrupt' }).success).toBe(true)
  })

  it('refuses a code outside the protocol and a final without text', () => {
    expect(fromWorkerSchema.safeParse({ type: 'error', code: 'mic-denied' }).success).toBe(false)
    expect(fromWorkerSchema.safeParse({ type: 'final', utteranceId: 'u' }).success).toBe(false)
  })
})

describe('voice:pcm send schema', () => {
  const ok = { utteranceId: 'u1', seq: 0, samples: new ArrayBuffer(3200) }
  it('accepts a 100 ms chunk and exactly one second', () => {
    expect(sendSchemas['voice:pcm'].safeParse(ok).success).toBe(true)
    const full = { ...ok, samples: new ArrayBuffer(VOICE_PCM_MAX_BYTES) }
    expect(sendSchemas['voice:pcm'].safeParse(full).success).toBe(true)
  })
  it('refuses more than a second, empty, odd-sized, typed arrays and extra fields', () => {
    const s = sendSchemas['voice:pcm']
    expect(s.safeParse({ ...ok, samples: new ArrayBuffer(VOICE_PCM_MAX_BYTES + 2) }).success).toBe(
      false
    )
    expect(s.safeParse({ ...ok, samples: new ArrayBuffer(0) }).success).toBe(false)
    expect(s.safeParse({ ...ok, samples: new ArrayBuffer(3201) }).success).toBe(false)
    expect(s.safeParse({ ...ok, samples: new Int16Array(10) }).success).toBe(false)
    expect(s.safeParse({ ...ok, seq: 0.5 }).success).toBe(false)
    expect(s.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })
})
