import { describe, expect, it } from 'vitest'
import {
  KOKORO_VOICES,
  VOICE_MODELS,
  VOICE_MODELS_TOTAL_BYTES,
  fileUrl,
  resolveManifest
} from '../../../src/main/voice/model-manifest'

describe('voice model manifest', () => {
  it('pins every file to a commit with a sha256 and a size', () => {
    for (const model of VOICE_MODELS) {
      expect(model.baseUrl).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}$/)
      for (const file of model.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(file.bytes).toBeGreaterThan(0)
        expect(file.path.split('/')).not.toContain('..')
      }
    }
  })

  it('lists Kokoro fp32 with the default voice, the Zipformer and Whisper base.en, about 520 MB', () => {
    expect(VOICE_MODELS.map((m) => [m.id, m.kind])).toEqual([
      ['kokoro', 'tts'],
      ['zipformer-en-20m', 'stt-stream'],
      ['whisper-base-en', 'stt-final']
    ])
    expect(KOKORO_VOICES).toContain('af_heart')
    const kokoro = VOICE_MODELS[0]!
    expect(kokoro.baseUrl.endsWith('1939ad2a8e416c0acfeecc08a694d14ef25f2231')).toBe(true)
    expect(kokoro.files.map((f) => f.path)).toContain('onnx/model.onnx')
    expect(fileUrl(kokoro, kokoro.files[0]!)).toBe(
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx'
    )
    expect(VOICE_MODELS_TOTAL_BYTES / 1_000_000).toBeGreaterThan(515)
    expect(VOICE_MODELS_TOTAL_BYTES / 1_000_000).toBeLessThan(525)
  })

  it('replaces the origin only in e2e, keeping the pinned path', () => {
    const base = 'http://127.0.0.1:4545'
    expect(resolveManifest({ HARNESS_VOICE_MODEL_BASE_URL: base })).toBe(VOICE_MODELS)
    const e2e = resolveManifest({ HARNESS_E2E: '1', HARNESS_VOICE_MODEL_BASE_URL: base })
    expect(e2e[0]!.baseUrl).toBe(
      `${base}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231`
    )
    expect(resolveManifest({ HARNESS_E2E: '1' })).toBe(VOICE_MODELS)
  })

  it('takes a replacement manifest file only in e2e, and validates it', () => {
    const stub = JSON.stringify([
      {
        id: 'stub',
        kind: 'tts',
        version: '1',
        baseUrl: 'http://127.0.0.1:1/p',
        files: [{ path: 'a.bin', sha256: 'b'.repeat(64), bytes: 3 }]
      }
    ])
    const read = (): string => stub
    expect(resolveManifest({ HARNESS_VOICE_MODEL_MANIFEST: '/x.json' }, read)).toBe(VOICE_MODELS)
    expect(
      resolveManifest({ HARNESS_E2E: '1', HARNESS_VOICE_MODEL_MANIFEST: '/x.json' }, read)[0]!.id
    ).toBe('stub')
    expect(() =>
      resolveManifest({ HARNESS_E2E: '1', HARNESS_VOICE_MODEL_MANIFEST: '/x.json' }, () =>
        stub.replace('a.bin', '../a.bin')
      )
    ).toThrow()
  })
})
