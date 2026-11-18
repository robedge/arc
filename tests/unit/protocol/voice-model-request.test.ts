import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveVoiceModelRequest } from '../../../src/main/protocol/voice-model-request'
import type { VoiceModelRequestDeps } from '../../../src/main/protocol/voice-model-request'
import type { VoiceModelSpec } from '../../../src/main/voice/model-manifest'

const sha = 'a'.repeat(64)
const manifest: VoiceModelSpec[] = [
  {
    id: 'kokoro',
    kind: 'tts',
    version: 'v1',
    baseUrl: 'https://x.test',
    files: [
      { path: 'onnx/model.onnx', sha256: sha, bytes: 10 },
      { path: 'voices/af_heart.bin', sha256: sha, bytes: 4 }
    ]
  },
  {
    id: 'notready',
    kind: 'stt-final',
    version: 'v1',
    baseUrl: 'https://x.test',
    files: [{ path: 'm.bin', sha256: sha, bytes: 1 }]
  }
]

describe('resolveVoiceModelRequest', () => {
  let dir: string
  let deps: VoiceModelRequestDeps
  const get = (path: string, range?: string, method = 'GET') =>
    resolveVoiceModelRequest({ method, url: `arc-voice-model://${path}`, range }, deps)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voice-req-'))
    mkdirSync(join(dir, 'kokoro', 'onnx'), { recursive: true })
    mkdirSync(join(dir, 'kokoro', 'voices'), { recursive: true })
    writeFileSync(join(dir, 'kokoro', 'onnx', 'model.onnx'), '0123456789')
    writeFileSync(join(dir, 'kokoro', 'voices', 'af_heart.bin'), 'abcd')
    writeFileSync(join(dir, 'secret.txt'), 'secret')
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'kokoro', 'link.bin'))
    deps = {
      manifest,
      // Only the kokoro model is complete; this stands in for ModelManager.readyFilePath.
      resolveFile: (model, rel) =>
        Promise.resolve(model.id === 'kokoro' ? join(dir, 'kokoro', rel) : undefined)
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('serves a listed file of a ready model with its length and no sniffing', async () => {
    const r = await get('kokoro/onnx/model.onnx')
    expect(r.status).toBe(200)
    expect(r.filePath).toBe(join(dir, 'kokoro', 'onnx', 'model.onnx'))
    expect(r.headers).toMatchObject({
      'Content-Length': '10',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff'
    })
  })

  it('refuses every method but GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
      expect((await get('kokoro/onnx/model.onnx', undefined, method)).status).toBe(405)
    }
  })

  it('refuses an unknown model id and a model that is not ready', async () => {
    expect((await get('nope/onnx/model.onnx')).status).toBe(404)
    expect((await get('notready/m.bin')).status).toBe(404)
  })

  it('refuses paths that are not listed files, including traversal and symlinks', async () => {
    for (const path of [
      'kokoro/../secret.txt',
      'kokoro/%2e%2e/secret.txt',
      'kokoro/onnx/%2e%2e/%2e%2e/secret.txt',
      'kokoro/..%2fsecret.txt',
      'kokoro/onnx',
      'kokoro/link.bin',
      'kokoro/onnx/model.onnx/',
      'kokoro/ONNX/model.onnx',
      'kokoro/'
    ]) {
      const r = await get(path)
      expect(r.status, path).toBe(404)
      expect(r.filePath, path).toBeUndefined()
    }
  })

  it('answers a byte range with 206 and Content-Range', async () => {
    const r = await get('kokoro/onnx/model.onnx', 'bytes=2-5')
    expect(r.status).toBe(206)
    expect(r.range).toEqual({ start: 2, end: 5 })
    expect(r.headers['Content-Range']).toBe('bytes 2-5/10')
    expect(r.headers['Content-Length']).toBe('4')
  })

  it('supports open-ended and suffix ranges and clamps the end', async () => {
    expect((await get('kokoro/onnx/model.onnx', 'bytes=6-')).range).toEqual({ start: 6, end: 9 })
    expect((await get('kokoro/onnx/model.onnx', 'bytes=-3')).range).toEqual({ start: 7, end: 9 })
    expect((await get('kokoro/onnx/model.onnx', 'bytes=8-99')).range).toEqual({ start: 8, end: 9 })
  })

  it('answers 416 with the size for a range past the end, and serves whole for a range it ignores', async () => {
    const past = await get('kokoro/onnx/model.onnx', 'bytes=10-')
    expect(past.status).toBe(416)
    expect(past.headers['Content-Range']).toBe('bytes */10')
    expect((await get('kokoro/onnx/model.onnx', 'bytes=5-2')).status).toBe(416)
    expect((await get('kokoro/onnx/model.onnx', 'bytes=0-1,4-5')).status).toBe(200)
    expect((await get('kokoro/onnx/model.onnx', 'items=0-1')).status).toBe(200)
  })

  it('refuses a URL of another scheme', async () => {
    const r = await resolveVoiceModelRequest(
      { method: 'GET', url: 'https://kokoro/onnx/model.onnx' },
      deps
    )
    expect(r.status).toBe(404)
  })
})
