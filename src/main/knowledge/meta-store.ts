import { access, copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic-write'

export interface MetaSection {
  folder: string
  name: string
  kind: string
}

export interface Meta {
  version: 1
  sections: MetaSection[]
  items: Record<string, { description: string }>
  updatedAt: number
  /** Unknown top-level fields written by other versions are preserved. */
  [extra: string]: unknown
}

export interface MetaLogger {
  warn: (...args: unknown[]) => void
}

export interface MetaStoreDeps {
  log: MetaLogger
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class MetaStore {
  private readonly log: MetaLogger
  private readonly now: () => number
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(deps: MetaStoreDeps) {
    this.log = deps.log
    this.now = deps.now ?? Date.now
  }

  metaDir(root: string): string {
    return join(root, '.arc')
  }

  metaPath(root: string): string {
    return join(this.metaDir(root), 'meta.json')
  }

  private defaults(): Meta {
    return { version: 1, sections: [], items: {}, updatedAt: this.now() }
  }

  /** Renames the pre-rename `.harness` metadata dir to `.arc` when `.arc` is absent. */
  private async migrateLegacyDir(root: string): Promise<void> {
    const legacy = join(root, '.harness')
    try {
      await access(legacy)
      await access(this.metaDir(root)).then(
        () => undefined,
        async () => rename(legacy, this.metaDir(root))
      )
    } catch {
      // no legacy dir (or it cannot be renamed): fall through to defaults
    }
  }

  /** Reads meta.json; missing gives defaults, corrupt is copied to meta.json.bak and gives defaults. */
  async read(root: string): Promise<Meta> {
    await this.migrateLegacyDir(root)
    const path = this.metaPath(root)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.defaults()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!isRecord(parsed)) {
      this.log.warn(`corrupt meta.json at ${path}; backing up and using defaults`)
      await copyFile(path, `${path}.bak`).catch(() => undefined)
      return this.defaults()
    }
    return {
      ...parsed,
      version: 1,
      sections: Array.isArray(parsed['sections']) ? (parsed['sections'] as MetaSection[]) : [],
      items: isRecord(parsed['items']) ? (parsed['items'] as Meta['items']) : {},
      updatedAt: typeof parsed['updatedAt'] === 'number' ? parsed['updatedAt'] : this.now()
    }
  }

  /** Atomically writes meta.json, keeping any unknown top-level fields already on disk. */
  async write(root: string, meta: Meta): Promise<void> {
    const existing = await this.read(root)
    const merged: Meta = { ...existing, ...meta, version: 1, updatedAt: this.now() }
    await mkdir(this.metaDir(root), { recursive: true })
    await atomicWriteFile(this.metaPath(root), JSON.stringify(merged, null, 2) + '\n')
  }

  /** Read-modify-write, serialized per root so concurrent updates do not lose each other. */
  updateMeta(root: string, mutator: (meta: Meta) => void | Meta): Promise<Meta> {
    const previous = this.queues.get(root) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const meta = await this.read(root)
        const next = mutator(meta) ?? meta
        await this.write(root, next)
        return next
      })
    this.queues.set(root, run)
    return run
  }
}
