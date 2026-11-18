import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { VoiceErrorCode, VoiceModelProgress, VoiceModelStatus } from '@shared/types/voice'
import { fileUrl, modelBytes } from './model-manifest'
import type { VoiceModelFile, VoiceModelSpec } from './model-manifest'

export const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 500
const PROGRESS_INTERVAL_MS = 250
const FAKE_FILE_BYTES = 1024

export interface ModelManagerDeps {
  /** `userData/voice-models`. */
  rootDir: string
  manifest: readonly VoiceModelSpec[]
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onProgress?: (progress: VoiceModelProgress) => void
  onError?: (error: { code: VoiceErrorCode }) => void
  /** `HARNESS_VOICE_MODELS=fake`: stub files, no network. */
  fake?: boolean
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
}

/** Raised inside the manager; `code` becomes the `voice:error` event. */
class ModelError extends Error {
  constructor(readonly code: 'offline' | 'model-corrupt') {
    super(code)
  }
}

interface PartialMeta {
  url: string
  bytes: number
}

const partialDirOf = (finalDir: string): string => `${finalDir}.partial`

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * Downloads the pinned speech models into `<rootDir>/<id>@<version>`. A model is written into
 * `<id>@<version>.partial` (each file as `<name>.partial` with a `.meta` file) and the folder is
 * renamed into place only once every file passed its sha256, so a model folder that exists is whole.
 */
export class ModelManager {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private running: Promise<void> | undefined
  private abort: AbortController | undefined
  private readonly failed = new Set<string>()
  private readonly live = new Map<string, number>()
  private readonly lastEmit = new Map<string, number>()
  private fakeReady: Promise<void> | undefined

  readonly manifest: readonly VoiceModelSpec[]

  /** Stub models in use (e2e); the renderer then also swaps in its stub speech engine. */
  get isFake(): boolean {
    return this.deps.fake === true
  }

  constructor(private readonly deps: ModelManagerDeps) {
    this.manifest = deps.manifest
    this.fetchImpl = deps.fetch ?? fetch
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = deps.now ?? Date.now
  }

  /** Folder of a model once it is complete. */
  modelDir(model: VoiceModelSpec): string {
    return join(this.deps.rootDir, `${model.id}@${model.version}`)
  }

  /** Absolute path of a complete model's file, or undefined while the model is not ready. */
  async readyFilePath(model: VoiceModelSpec, relPath: string): Promise<string | undefined> {
    if (!model.files.some((f) => f.path === relPath)) return undefined
    return (await this.isReady(model)) ? join(this.modelDir(model), relPath) : undefined
  }

  /** In fake mode the stubs are installed the first time anything asks, and never again after a delete. */
  async init(): Promise<void> {
    if (!this.deps.fake) return
    this.fakeReady ??= (async () => {
      for (const model of this.deps.manifest) {
        if (!(await this.isReady(model))) await this.installStubs(model)
      }
    })()
    await this.fakeReady
  }

  async status(): Promise<VoiceModelStatus[]> {
    await this.init()
    const out: VoiceModelStatus[] = []
    for (const model of this.deps.manifest) {
      const totalBytes = model.files.reduce((sum, f) => sum + this.expectedBytes(f), 0)
      if (await this.isReady(model)) {
        out.push({ id: model.id, kind: model.kind, state: 'ready', bytes: totalBytes, totalBytes })
        continue
      }
      const bytes = this.live.get(model.id) ?? (await this.partialBytes(model))
      const state = this.running ? 'downloading' : this.failed.has(model.id) ? 'failed' : 'missing'
      out.push({ id: model.id, kind: model.kind, state, bytes, totalBytes })
    }
    return out
  }

  get isDownloading(): boolean {
    return this.running !== undefined
  }

  /**
   * Downloads every model that is not ready. A second call while one runs joins it instead of
   * starting another. Failures are reported through `onError` and `onProgress` (state `failed`).
   */
  download(): Promise<void> {
    this.running ??= this.runDownload().finally(() => {
      this.running = undefined
      this.abort = undefined
    })
    return this.running
  }

  /** Stops any download and removes every model and partial download. */
  async delete(): Promise<void> {
    this.abort?.abort()
    await this.running?.catch(() => undefined)
    for (const model of this.deps.manifest) {
      const dir = this.modelDir(model)
      await rm(dir, { recursive: true, force: true })
      await rm(partialDirOf(dir), { recursive: true, force: true })
      this.failed.delete(model.id)
      this.live.delete(model.id)
    }
    this.deps.log?.info('voice models deleted')
  }

  /** Fake stubs are all 1 KB; real files have their manifest size. */
  private expectedBytes(file: VoiceModelFile): number {
    return this.deps.fake ? FAKE_FILE_BYTES : file.bytes
  }

  private async isReady(model: VoiceModelSpec): Promise<boolean> {
    const dir = this.modelDir(model)
    for (const file of model.files) {
      if ((await sizeOf(join(dir, file.path))) !== this.expectedBytes(file)) return false
    }
    return true
  }

  private async partialBytes(model: VoiceModelSpec): Promise<number> {
    const dir = partialDirOf(this.modelDir(model))
    let total = 0
    for (const file of model.files) {
      total +=
        (await sizeOf(join(dir, file.path))) ??
        (await sizeOf(join(dir, `${file.path}.partial`))) ??
        0
    }
    return total
  }

  private async runDownload(): Promise<void> {
    this.abort = new AbortController()
    const { signal } = this.abort
    this.deps.log?.info('voice model download started')
    for (const model of this.deps.manifest) {
      if (signal.aborted) return
      if (await this.isReady(model)) continue
      this.failed.delete(model.id)
      try {
        if (this.deps.fake) await this.installStubs(model)
        else await this.downloadModel(model, signal)
        this.emitProgress(model, modelBytes(model), 'ready', true)
      } catch (error: unknown) {
        if (signal.aborted) return
        const code = error instanceof ModelError ? error.code : 'offline'
        this.failed.add(model.id)
        this.deps.log?.warn(`voice model ${model.id} failed: ${code}`)
        this.emitProgress(model, this.live.get(model.id) ?? 0, 'failed', true)
        this.deps.onError?.({ code })
        return
      }
    }
    this.deps.log?.info('voice model download finished')
  }

  private async installStubs(model: VoiceModelSpec): Promise<void> {
    const dir = this.modelDir(model)
    await rm(dir, { recursive: true, force: true })
    for (const file of model.files) {
      const target = join(dir, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, Buffer.alloc(FAKE_FILE_BYTES))
    }
  }

  private async downloadModel(model: VoiceModelSpec, signal: AbortSignal): Promise<void> {
    const finalDir = this.modelDir(model)
    const stagingDir = partialDirOf(finalDir)
    await mkdir(stagingDir, { recursive: true })
    const total = modelBytes(model)
    let done = 0
    this.emitProgress(model, done, 'downloading', true)
    for (const file of model.files) {
      await this.downloadFile(model, file, stagingDir, signal, (fileBytes) =>
        this.emitProgress(model, done + fileBytes, 'downloading', false)
      )
      done += file.bytes
    }
    this.emitProgress(model, total, 'downloading', true)
    await rm(finalDir, { recursive: true, force: true })
    await rename(stagingDir, finalDir)
    this.deps.log?.info(`voice model ${model.id} installed, ${total} bytes`)
  }

  /** Download, verify, and on a mismatch delete and download once more. */
  private async downloadFile(
    model: VoiceModelSpec,
    file: VoiceModelFile,
    stagingDir: string,
    signal: AbortSignal,
    onBytes: (received: number) => void
  ): Promise<void> {
    const target = join(stagingDir, file.path)
    await mkdir(dirname(target), { recursive: true })
    // A file verified on an earlier run is kept.
    if ((await sizeOf(target)) === file.bytes && (await sha256Of(target)) === file.sha256) return
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.fetchWithRetries(model, file, `${target}.partial`, signal, onBytes)
      if ((await sha256Of(`${target}.partial`)) === file.sha256) {
        await rename(`${target}.partial`, target)
        await rm(`${target}.meta`, { force: true })
        return
      }
      this.deps.log?.warn(`voice model ${model.id}: checksum mismatch on ${file.path}`)
      await rm(`${target}.partial`, { force: true })
      await rm(`${target}.meta`, { force: true })
    }
    throw new ModelError('model-corrupt')
  }

  private async fetchWithRetries(
    model: VoiceModelSpec,
    file: VoiceModelFile,
    partialPath: string,
    signal: AbortSignal,
    onBytes: (received: number) => void
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fetchOnce(model, file, partialPath, signal, onBytes)
        return
      } catch (error: unknown) {
        if (signal.aborted) throw error
        if (attempt >= MAX_RETRIES) throw new ModelError('offline')
        this.deps.log?.warn(`voice model ${model.id}: retry ${attempt + 1} of ${MAX_RETRIES}`)
        await this.sleep(BACKOFF_BASE_MS * 2 ** attempt)
      }
    }
  }

  /** One request, resuming from the partial file's size with `Range` when there is one. */
  private async fetchOnce(
    model: VoiceModelSpec,
    file: VoiceModelFile,
    partialPath: string,
    signal: AbortSignal,
    onBytes: (received: number) => void
  ): Promise<void> {
    const url = fileUrl(model, file)
    const metaPath = `${partialPath.slice(0, -'.partial'.length)}.meta`
    let offset = (await sizeOf(partialPath)) ?? 0
    if (offset > 0 && !(await this.metaMatches(metaPath, url, file.bytes))) offset = 0
    if (offset > file.bytes) offset = 0
    const meta: PartialMeta = { url, bytes: file.bytes }
    await writeFile(metaPath, JSON.stringify(meta))
    if (offset === file.bytes) {
      onBytes(offset)
      return
    }

    const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {}
    const response = await this.fetchImpl(url, { headers, signal })
    if (response.status === 416) {
      // The server has nothing past our offset: the partial is wrong, start over.
      await rm(partialPath, { force: true })
      throw new Error('range not satisfiable')
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    // A 200 answer to a Range request means the server ignored it: start from the top.
    const resumed = response.status === 206 && offset > 0
    if (!resumed) offset = 0

    const handle = await open(partialPath, resumed ? 'a' : 'w')
    let received = offset
    try {
      onBytes(received)
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await handle.write(value)
        received += value.byteLength
        onBytes(received)
      }
    } finally {
      await handle.close()
    }
    if (received !== file.bytes) throw new Error('short read')
  }

  private async metaMatches(metaPath: string, url: string, bytes: number): Promise<boolean> {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Partial<PartialMeta>
      return meta.url === url && meta.bytes === bytes
    } catch {
      return false
    }
  }

  private emitProgress(
    model: VoiceModelSpec,
    receivedBytes: number,
    state: VoiceModelProgress['state'],
    force: boolean
  ): void {
    this.live.set(model.id, receivedBytes)
    const last = this.lastEmit.get(model.id) ?? Number.NEGATIVE_INFINITY
    const at = this.now()
    if (!force && at - last < PROGRESS_INTERVAL_MS) return
    this.lastEmit.set(model.id, at)
    this.deps.onProgress?.({ id: model.id, receivedBytes, totalBytes: modelBytes(model), state })
  }
}
