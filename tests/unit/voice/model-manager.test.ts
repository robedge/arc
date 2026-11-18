import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceErrorCode, VoiceModelProgress } from '../../../src/shared/types/voice'
import { MAX_RETRIES, ModelManager } from '../../../src/main/voice/model-manager'
import type { VoiceModelSpec } from '../../../src/main/voice/model-manifest'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const BIG = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'.repeat(20)) // 720 bytes
const SMALL = Buffer.from('tokens go here')
const BASE = 'https://models.test/pin'

const manifest: VoiceModelSpec[] = [
  {
    id: 'alpha',
    kind: 'tts',
    version: 'v1',
    baseUrl: `${BASE}/alpha`,
    files: [
      { path: 'onnx/big.bin', sha256: sha(BIG), bytes: BIG.length },
      { path: 'small.txt', sha256: sha(SMALL), bytes: SMALL.length }
    ]
  },
  {
    id: 'beta',
    kind: 'stt-final',
    version: 'v1',
    baseUrl: `${BASE}/beta`,
    files: [{ path: 'beta.bin', sha256: sha(SMALL), bytes: SMALL.length }]
  }
]

const contents: Record<string, Buffer> = {
  [`${BASE}/alpha/onnx/big.bin`]: BIG,
  [`${BASE}/alpha/small.txt`]: SMALL,
  [`${BASE}/beta/beta.bin`]: SMALL
}

interface Call {
  url: string
  range: string | undefined
}

/** A fetch double that honours Range and can cut the connection after some bytes. */
function server(opts: { dropAfter?: number; ignoreRange?: boolean; corrupt?: Set<string> } = {}) {
  const calls: Call[] = []
  let dropped = false
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const range = (init?.headers as Record<string, string> | undefined)?.['Range']
    calls.push({ url, range })
    let body = contents[url]
    if (!body) return Promise.resolve(new Response(null, { status: 404 }))
    if (opts.corrupt?.has(url)) body = Buffer.alloc(body.length, 1)
    let start = 0
    let status = 200
    if (range && !opts.ignoreRange) {
      start = Number(/bytes=(\d+)-/.exec(range)![1])
      status = 206
    }
    const slice = body.subarray(start)
    const cut = !dropped && opts.dropAfter !== undefined && url.endsWith('big.bin')
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cut && sent) {
          // The first chunk is delivered, then the connection drops.
          dropped = true
          controller.error(new TypeError('terminated'))
          return
        }
        sent = true
        controller.enqueue(new Uint8Array(cut ? slice.subarray(0, opts.dropAfter) : slice))
        if (!cut) controller.close()
      }
    })
    return Promise.resolve(new Response(stream, { status }))
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

describe('ModelManager', () => {
  let root: string
  let progress: VoiceModelProgress[]
  let errors: VoiceErrorCode[]
  const sleeps: number[] = []

  const make = (
    f: typeof fetch,
    extra: Partial<ConstructorParameters<typeof ModelManager>[0]> = {}
  ) =>
    new ModelManager({
      rootDir: root,
      manifest,
      fetch: f,
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      onProgress: (p) => progress.push(p),
      onError: (e) => errors.push(e.code),
      ...extra
    })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'voice-models-'))
    progress = []
    errors = []
    sleeps.length = 0
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports missing, downloads every model, and ends ready with the files in place', async () => {
    const srv = server()
    const manager = make(srv.fetch)
    expect((await manager.status()).map((m) => [m.id, m.state, m.bytes])).toEqual([
      ['alpha', 'missing', 0],
      ['beta', 'missing', 0]
    ])
    await manager.download()
    const status = await manager.status()
    expect(status.map((m) => [m.id, m.state])).toEqual([
      ['alpha', 'ready'],
      ['beta', 'ready']
    ])
    expect(status[0]!.bytes).toBe(BIG.length + SMALL.length)
    expect(readFileSync(join(root, 'alpha@v1', 'onnx/big.bin')).equals(BIG)).toBe(true)
    expect(existsSync(join(root, 'alpha@v1.partial'))).toBe(false)
    expect(progress.at(-1)).toMatchObject({ id: 'beta', state: 'ready' })
    expect(errors).toEqual([])
  })

  it('resumes a dropped connection from the partial file with a Range header', async () => {
    const srv = server({ dropAfter: 100 })
    const manager = make(srv.fetch)
    await manager.download()
    const big = srv.calls.filter((c) => c.url.endsWith('big.bin'))
    expect(big.map((c) => c.range)).toEqual([undefined, 'bytes=100-'])
    expect(sleeps).toEqual([500])
    expect(readFileSync(join(root, 'alpha@v1', 'onnx/big.bin')).equals(BIG)).toBe(true)
    expect((await manager.status()).every((m) => m.state === 'ready')).toBe(true)
  })

  it('resumes from a partial left by an earlier run, and ignores one from another url', async () => {
    const staging = join(root, 'alpha@v1.partial', 'onnx')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'big.bin.partial'), BIG.subarray(0, 300))
    writeFileSync(
      join(staging, 'big.bin.meta'),
      JSON.stringify({ url: `${BASE}/alpha/onnx/big.bin`, bytes: BIG.length })
    )
    const srv = server()
    await make(srv.fetch).download()
    expect(srv.calls.find((c) => c.url.endsWith('big.bin'))!.range).toBe('bytes=300-')

    rmSync(root, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'big.bin.partial'), Buffer.alloc(300, 9))
    writeFileSync(
      join(staging, 'big.bin.meta'),
      JSON.stringify({ url: 'https://other/x', bytes: 1 })
    )
    const again = server()
    await make(again.fetch).download()
    expect(again.calls.find((c) => c.url.endsWith('big.bin'))!.range).toBeUndefined()
    expect(readFileSync(join(root, 'alpha@v1', 'onnx/big.bin')).equals(BIG)).toBe(true)
  })

  it('starts over when the server ignores Range', async () => {
    const srv = server({ dropAfter: 100, ignoreRange: true })
    await make(srv.fetch).download()
    expect(readFileSync(join(root, 'alpha@v1', 'onnx/big.bin')).equals(BIG)).toBe(true)
  })

  it('redownloads once after a checksum mismatch and then succeeds', async () => {
    const url = `${BASE}/alpha/onnx/big.bin`
    const bad = server({ corrupt: new Set([url]) })
    let first = true
    const fetchOnce = ((u: string | URL | Request, init?: RequestInit) => {
      if (String(u) === url && first) {
        first = false
        return bad.fetch(u, init)
      }
      return server().fetch(u, init)
    }) as typeof fetch
    await make(fetchOnce).download()
    expect(errors).toEqual([])
    expect(readFileSync(join(root, 'alpha@v1', 'onnx/big.bin')).equals(BIG)).toBe(true)
  })

  it('fails with model-corrupt after the one redownload also mismatches', async () => {
    const srv = server({ corrupt: new Set([`${BASE}/alpha/onnx/big.bin`]) })
    const manager = make(srv.fetch)
    await manager.download()
    expect(errors).toEqual(['model-corrupt'])
    expect(srv.calls.filter((c) => c.url.endsWith('big.bin'))).toHaveLength(2)
    const status = await manager.status()
    expect(status[0]!.state).toBe('failed')
    expect(existsSync(join(root, 'alpha@v1'))).toBe(false)
    expect(existsSync(join(root, 'alpha@v1.partial', 'onnx/big.bin.partial'))).toBe(false)
    expect(progress.at(-1)).toMatchObject({ id: 'alpha', state: 'failed' })
  })

  it('reports offline after three retries with backoff, then retries cleanly', async () => {
    const down = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed'))
    ) as unknown as typeof fetch
    const manager = make(down)
    await manager.download()
    expect(errors).toEqual(['offline'])
    expect(down).toHaveBeenCalledTimes(MAX_RETRIES + 1)
    expect(sleeps).toEqual([500, 1000, 2000])
    expect((await manager.status())[0]!.state).toBe('failed')

    errors.length = 0
    const online = make(server().fetch)
    await online.download()
    expect(errors).toEqual([])
    expect((await online.status()).every((m) => m.state === 'ready')).toBe(true)
  })

  it('treats an HTTP error as offline', async () => {
    const srv = server()
    const missing = ((_u: string, init?: RequestInit) =>
      srv.fetch('https://models.test/none', init)) as unknown as typeof fetch
    await make(missing).download()
    expect(errors).toEqual(['offline'])
  })

  it('joins a second download call instead of starting another', async () => {
    const srv = server()
    const manager = make(srv.fetch)
    const a = manager.download()
    const b = manager.download()
    expect(b).toBe(a)
    expect(manager.isDownloading).toBe(true)
    await a
    expect(srv.fetch).toHaveBeenCalledTimes(3)
    expect(manager.isDownloading).toBe(false)
  })

  it('throttles progress to one push per 250 ms, always sending the first and last', async () => {
    let t = 0
    const manager = make(server().fetch, { now: () => (t += 10) })
    await manager.download()
    const alpha = progress.filter((p) => p.id === 'alpha')
    expect(alpha[0]).toMatchObject({ state: 'downloading', receivedBytes: 0 })
    expect(alpha.at(-1)).toMatchObject({ state: 'ready', receivedBytes: BIG.length + SMALL.length })
    expect(alpha.length).toBeLessThan(6)
  })

  it('delete removes complete models and partial downloads', async () => {
    const manager = make(server().fetch)
    await manager.download()
    mkdirSync(join(root, 'beta@v1.partial'), { recursive: true })
    await manager.delete()
    expect(existsSync(join(root, 'alpha@v1'))).toBe(false)
    expect(existsSync(join(root, 'beta@v1.partial'))).toBe(false)
    expect((await manager.status()).map((m) => m.state)).toEqual(['missing', 'missing'])
  })

  it('serves a path only for a complete model', async () => {
    const manager = make(server().fetch)
    expect(await manager.readyFilePath(manifest[0]!, 'small.txt')).toBeUndefined()
    await manager.download()
    expect(await manager.readyFilePath(manifest[0]!, 'small.txt')).toBe(
      join(root, 'alpha@v1', 'small.txt')
    )
    expect(await manager.readyFilePath(manifest[0]!, '../beta@v1/beta.bin')).toBeUndefined()
  })

  it('fake mode installs 1 KB stubs, reports ready without the network, and delete clears them', async () => {
    const f = vi.fn() as unknown as typeof fetch
    const manager = make(f, { fake: true })
    const status = await manager.status()
    expect(status.map((m) => m.state)).toEqual(['ready', 'ready'])
    expect(status[0]!.bytes).toBe(2048)
    expect(readFileSync(join(root, 'alpha@v1', 'onnx/big.bin'))).toHaveLength(1024)
    expect(f).not.toHaveBeenCalled()
    await manager.delete()
    expect((await manager.status()).map((m) => m.state)).toEqual(['missing', 'missing'])
    await manager.download()
    expect((await manager.status()).map((m) => m.state)).toEqual(['ready', 'ready'])
    expect(f).not.toHaveBeenCalled()
  })
})
