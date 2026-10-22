import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ProviderId } from '@shared/types/provider'

/** How long a looked-up latest version stays fresh. */
export const LATEST_VERSION_TTL_MS = 6 * 60 * 60 * 1000
/** The registry lookup gives up after this long. */
export const LATEST_VERSION_TIMEOUT_MS = 5000

/** Where each provider's newest version is looked up; Cursor has no registry (its source is `agent about`, see `LatestVersionsDeps.sources`). */
const REGISTRY_URLS: Record<ProviderId, string | undefined> = {
  claude: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
  codex: 'https://registry.npmjs.org/@openai/codex/latest',
  cursor: undefined
}

interface ParsedVersion {
  core: number[]
  pre: string[] | undefined
}

/** Cursor's `2026.10.19-6bbf2c4`: the suffix is a build hash, not a prerelease, so only the date counts. */
const CURSOR_STYLE = /^\d{4}\.\d+\.\d+-[0-9a-f]+$/

function parse(version: string): ParsedVersion {
  const trimmed = version.trim().replace(/^v/, '')
  if (CURSOR_STYLE.test(trimmed)) {
    return { core: (trimmed.split('-')[0] ?? '').split('.').map(Number), pre: undefined }
  }
  const [main = '', ...rest] = trimmed.split('+')[0]?.split('-') ?? []
  const core = main.split('.').map((part) => Number.parseInt(part, 10) || 0)
  return { core, pre: rest.length > 0 ? rest.join('-').split('.') : undefined }
}

function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : undefined
    const ny = /^\d+$/.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * Semver-ish compare: numeric segments, so `0.9.0` is below `0.10.0`. A prerelease tag counts only
 * when both versions have one; otherwise only the numbers decide. Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const m = x.core[i] ?? 0
    const n = y.core[i] ?? 0
    if (m !== n) return m < n ? -1 : 1
  }
  if (x.pre && y.pre) return comparePre(x.pre, y.pre)
  return 0
}

/** True when `latest` is newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

const BREW_NAMES: Record<ProviderId, string | undefined> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: undefined
}

/**
 * The command to show for an update. A binary whose real path goes through Homebrew's `Cellar`
 * (formula) or `Caskroom` (cask) is brew-managed: `brew upgrade <name>` or `brew upgrade --cask
 * <name>`. Everything else, including an npm install under the Homebrew prefix, uses the tool's own
 * `<cli> update`. `realPath` is the binary after symlinks are resolved.
 */
export function updateCommandFor(provider: ProviderId, realPath: string | undefined): string {
  const name = BREW_NAMES[provider]
  if (name !== undefined) {
    if (realPath?.includes('/Caskroom/')) return `brew upgrade --cask ${name}`
    if (realPath?.includes('/Cellar/')) return `brew upgrade ${name}`
  }
  return provider === 'cursor' ? 'agent update' : `${provider} update`
}

const cacheSchema = z.looseObject({
  latest: z
    .looseObject({
      claude: z.object({ version: z.string(), fetchedAt: z.number() }).optional(),
      codex: z.object({ version: z.string(), fetchedAt: z.number() }).optional(),
      cursor: z.object({ version: z.string(), fetchedAt: z.number() }).optional()
    })
    .optional()
})

type LatestEntry = { version: string; fetchedAt: number }

export interface LatestVersionsDeps {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** `userData/provider-cache.json`; without it the lookups are cached in memory only. */
  cachePath?: string | undefined
  env?: NodeJS.ProcessEnv
  isPackaged: boolean
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
  log?: { debug: (message: string, ...rest: unknown[]) => void }
  /** A provider's own way to learn its newest version, used instead of the registry (Cursor: `agent about`). */
  sources?: Partial<Record<ProviderId, () => Promise<string | undefined>>>
}

/**
 * The newest published version per provider, from the npm registry. Time-boxed, cached for 6 hours
 * in `provider-cache.json`, and silent on failure (no version, one debug line).
 *
 * Tests never reach the network: `HARNESS_PROVIDER_LATEST_FILE` names a JSON file such as
 * `{"claude":"2.2.0","codex":"0.170.0"}`, honoured in e2e runs and in dev. In an e2e run without
 * that file nothing is looked up.
 */
export class LatestVersions {
  private readonly fetchFn: typeof fetch
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly log: NonNullable<LatestVersionsDeps['log']>
  private readonly memory: Partial<Record<ProviderId, LatestEntry>> = {}
  private cacheLoaded = false

  constructor(private readonly deps: LatestVersionsDeps) {
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init))
    this.env = deps.env ?? process.env
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? LATEST_VERSION_TTL_MS
    this.timeoutMs = deps.timeoutMs ?? LATEST_VERSION_TIMEOUT_MS
    this.log = deps.log ?? { debug: () => undefined }
  }

  /** The latest version, from the cache while it is fresh (unless `force`). Never rejects. */
  async get(provider: ProviderId, options: { force?: boolean } = {}): Promise<string | undefined> {
    try {
      const testMode = this.env['HARNESS_E2E'] === '1' || !this.deps.isPackaged
      const file = this.env['HARNESS_PROVIDER_LATEST_FILE']
      if (file && testMode) return await this.fromFile(file, provider)
      if (this.env['HARNESS_E2E'] === '1') return undefined
      await this.loadCache()
      const cached = this.memory[provider]
      if (cached && !options.force && this.now() - cached.fetchedAt < this.ttlMs) {
        return cached.version
      }
      const version = await this.fetchLatest(provider)
      this.memory[provider] = { version, fetchedAt: this.now() }
      await this.saveCache()
      return version
    } catch (error: unknown) {
      this.log.debug(`could not look up the latest ${provider} version`, error)
      return undefined
    }
  }

  private async fromFile(file: string, provider: ProviderId): Promise<string | undefined> {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    const value =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[provider]
        : undefined
    return typeof value === 'string' && /^\d+\.\d+/.test(value) ? value : undefined
  }

  private async fetchLatest(provider: ProviderId): Promise<string> {
    const source = this.deps.sources?.[provider]
    if (source) {
      const version = await source()
      if (version === undefined || !/^\d+\.\d+/.test(version)) {
        throw new Error(`${provider} did not report a latest version`)
      }
      return version
    }
    const url = REGISTRY_URLS[provider]
    if (url === undefined) throw new Error(`${provider} has no registry`)
    const response = await this.fetchFn(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`registry answered ${response.status}`)
    const body: unknown = await response.json()
    const version =
      typeof body === 'object' && body !== null
        ? (body as { version?: unknown }).version
        : undefined
    if (typeof version !== 'string' || !/^\d+\.\d+/.test(version)) {
      throw new Error('registry answer had no version')
    }
    return version
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    const path = this.deps.cachePath
    if (!path) return
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
      if (parsed.success && parsed.data.latest) {
        const { claude, codex, cursor } = parsed.data.latest
        if (claude) this.memory.claude = claude
        if (codex) this.memory.codex = codex
        if (cursor) this.memory.cursor = cursor
      }
    } catch {
      // No cache file yet.
    }
  }

  /** Writes the `latest` entry and keeps every other key of the file (the Codex model list). */
  private async saveCache(): Promise<void> {
    const path = this.deps.cachePath
    if (!path) return
    try {
      let existing: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      } catch {
        // Start a fresh file.
      }
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.latest.tmp`
      await writeFile(temp, JSON.stringify({ ...existing, latest: this.memory }), 'utf8')
      await rename(temp, path)
    } catch (error: unknown) {
      this.log.debug('could not write the provider cache', error)
    }
  }
}
