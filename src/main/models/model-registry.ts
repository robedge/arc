import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { assertNever } from '@shared/assert-never'
import { providerName } from '@shared/provider-label'
import type {
  ModelInfo,
  ModelRef,
  ModelTier,
  ProviderId,
  ProviderModels,
  ProviderStatusMap
} from '@shared/types/provider'
import type { CodexModelInfo, CodexModelSource } from '../agents/codex/codex-probe'
import type { CursorModelInfo, CursorModelSource } from '../agents/cursor/cursor-probe'
import { MODEL_ALIASES, normalizeModel } from '../sessions/worker-model'
import { codexTier } from './codex-tiers'
import { cursorTier } from './cursor-tiers'

/** How long a provider's model list stays fresh. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** The Claude models Arc offers by alias. */
const CLAUDE_MODELS: readonly ModelInfo[] = [
  { ref: { provider: 'claude', model: 'opus' }, label: 'Opus', tier: 'deep', isDefault: false },
  {
    ref: { provider: 'claude', model: 'sonnet' },
    label: 'Sonnet',
    tier: 'balanced',
    isDefault: true
  },
  { ref: { provider: 'claude', model: 'haiku' }, label: 'Haiku', tier: 'fast', isDefault: false }
]

const cachedListSchema = z.looseObject({
  fetchedAt: z.number(),
  models: z.array(
    z.looseObject({ model: z.string().min(1), displayName: z.string(), isDefault: z.boolean() })
  )
})

/** `provider-cache.json`: one `{ fetchedAt, models }` entry per provider; unknown keys are kept. */
export const cacheSchema = z.looseObject({
  codex: cachedListSchema.optional(),
  /** Entries may carry `group`, `base` and `variant`. */
  cursor: cachedListSchema.optional()
})

export interface ModelRegistryDeps {
  /** Where the Codex models come from; left out, Codex lists nothing. */
  codex?: CodexModelSource | undefined
  /** Where the Cursor models come from; left out, Cursor lists nothing. */
  cursor?: CursorModelSource | undefined
  /** The latest provider statuses. Codex and Cursor models are listed only while that provider is `ok`. */
  status: () => ProviderStatusMap
  /** `userData/provider-cache.json`; without it the lists are kept in memory only. */
  cachePath?: string | undefined
  now?: () => number
  ttlMs?: number
  log?: { warn: (message: string, ...rest: unknown[]) => void }
}

/** The providers whose model list is probed and cached. */
type ProbedProvider = 'codex' | 'cursor'
const PROBED: readonly ProbedProvider[] = ['codex', 'cursor']

interface CachedModels<T> {
  fetchedAt: number
  models: T[]
}

/** A Cursor entry as cached: an older file may lack the maker fields. */
type CachedCursorModel = Pick<CursorModelInfo, 'model' | 'displayName' | 'isDefault'> &
  Partial<Pick<CursorModelInfo, 'group' | 'base' | 'variant'>>

interface ModelCaches {
  codex?: CachedModels<CodexModelInfo>
  cursor?: CachedModels<CachedCursorModel>
}

/**
 * What models each provider offers. Claude's are the static aliases; Codex's come from `model/list`
 * and Cursor's from the `session/new` of a probe session, each through its probe, cached in memory
 * and in `provider-cache.json` for 24 hours. The lists depend on the signed-in account (spike S11),
 * so a provider's models are listed only while it is `ok`.
 */
export class ModelRegistry {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly log: NonNullable<ModelRegistryDeps['log']>
  private readonly caches: ModelCaches = {}
  /** Cache writes run one after the other, so two refreshes never write the file at once. */
  private saving: Promise<void> = Promise.resolve()
  private cacheLoaded = false
  private inflight: Promise<boolean> | undefined
  /** Whether `inflight` is a forced refresh. */
  private inflightForced = false
  /** Full model ids that agents reported (`init`, `thread/start`), accepted next to the listed ones. */
  private readonly learned = new Set<string>()

  constructor(private readonly deps: ModelRegistryDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? MODEL_CACHE_TTL_MS
    this.log = deps.log ?? { warn: () => undefined }
  }

  /** One provider's models, default first. Codex and Cursor are empty unless their status is `ok`. */
  list(provider: ProviderId): ModelInfo[] {
    switch (provider) {
      case 'claude':
        return [...CLAUDE_MODELS]
      case 'codex':
        return this.codexList()
      case 'cursor':
        return this.cursorList()
      default:
        return assertNever(provider)
    }
  }

  private cursorList(): ModelInfo[] {
    if (this.deps.status().cursor?.state !== 'ok') return []
    const models = this.caches.cursor?.models ?? []
    return models
      .map((m) => ({
        ref: { provider: 'cursor', model: m.model } satisfies ModelRef,
        label: m.displayName === '' ? m.model : m.displayName,
        tier: cursorTier({ model: m.model, base: m.base, isDefault: m.isDefault }),
        isDefault: m.isDefault,
        ...(m.group !== undefined ? { group: m.group } : {}),
        ...(m.base !== undefined ? { base: m.base } : {}),
        ...(m.variant !== undefined ? { variant: m.variant } : {})
      }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  }

  private codexList(): ModelInfo[] {
    if (this.deps.status().codex?.state !== 'ok') return []
    const models = this.caches.codex?.models ?? []
    return models
      .map((m) => ({
        ref: { provider: 'codex', model: m.model } satisfies ModelRef,
        label: m.displayName === '' ? m.model : m.displayName,
        tier: codexTier(m),
        isDefault: m.isDefault
      }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  }

  /**
   * The provider's lightest model (its `fast` tier), for requests that only need an answer to exist,
   * such as the launch plan check. Undefined when the provider lists no fast model.
   */
  cheapestFor(provider: ProviderId): ModelRef | undefined {
    return this.list(provider).find((m) => m.tier === 'fast')?.ref
  }

  /** Every provider's list, for the pickers. */
  all(): ProviderModels {
    return { claude: this.list('claude'), codex: this.list('codex'), cursor: this.list('cursor') }
  }

  /** The provider's default model: Claude `sonnet`, Codex the entry marked default (else the first). */
  defaultFor(provider: ProviderId): ModelRef | undefined {
    const models = this.list(provider)
    return (models.find((m) => m.isDefault) ?? models[0])?.ref
  }

  /** The provider's fast-tier model, if it lists one. */
  fastFor(provider: ProviderId): ModelRef | undefined {
    return this.list(provider).find((m) => m.tier === 'fast')?.ref
  }

  /** True for a listed model, a Claude alias in any case, or a full id an agent reported. */
  has(ref: ModelRef): boolean {
    if (ref.provider === 'claude' && MODEL_ALIASES.includes(ref.model.toLowerCase())) return true
    if (this.learned.has(this.learnedKey(ref))) return true
    return this.list(ref.provider).some((m) => m.ref.model === normalizeRef(ref).model)
  }

  /**
   * The listed model a ref names: its id, or for Cursor its label in any case ("auto" for Auto).
   * Undefined when it names no listed model.
   */
  resolve(ref: ModelRef): ModelRef | undefined {
    if (this.has(ref)) return normalizeRef(ref)
    if (ref.provider !== 'cursor') return undefined
    const wanted = ref.model.trim().toLowerCase()
    return this.list('cursor').find((m) => m.label.toLowerCase() === wanted)?.ref
  }

  /**
   * The tier of a model. An unlisted Codex or Cursor model (the provider is down, so nothing is
   * listed) is tiered by its name alone; an unknown Claude full id counts as balanced.
   */
  tierOf(ref: ModelRef): ModelTier {
    const listed = this.list(ref.provider).find((m) => m.ref.model === ref.model)
    if (listed) return listed.tier
    switch (ref.provider) {
      case 'codex':
        return codexTier({ model: ref.model })
      case 'cursor':
        return cursorTier({ model: ref.model })
      case 'claude':
        return 'balanced'
      default:
        return assertNever(ref.provider)
    }
  }

  /** Remembers a full model id that a running agent reported. */
  learn(ref: ModelRef): void {
    this.learned.add(this.learnedKey(ref))
  }

  /**
   * Refreshes the Codex and Cursor lists of the providers that are `ok` and whose list is missing,
   * older than 24 hours, or `force` is set. A failed probe keeps the previous list. Never rejects.
   * Resolves true when a list differs from the one before (the cached list on the first refresh).
   */
  refresh(options: { force?: boolean } = {}): Promise<boolean> {
    const force = options.force === true
    const running = this.inflight
    if (running && (this.inflightForced || !force)) return running
    // A forced refresh must not take the answer of a plain one already running (it may have kept a
    // fresh cache), so it runs after it and reports a change either of them saw.
    const next = (running ?? Promise.resolve(false))
      .then((before) => this.doRefresh(force).then((changed) => before || changed))
      .finally(() => {
        if (this.inflight === next) this.inflight = undefined
      })
    this.inflight = next
    this.inflightForced = force
    return next
  }

  private async doRefresh(force: boolean): Promise<boolean> {
    await this.loadCache()
    // The probes are separate processes, so a slow Cursor never holds up Codex.
    const changed = await Promise.all(PROBED.map((provider) => this.refreshOne(provider, force)))
    return changed.some(Boolean)
  }

  private async refreshOne(provider: ProbedProvider, force: boolean): Promise<boolean> {
    if (this.deps.status()[provider]?.state !== 'ok') return false
    const cached = this.caches[provider]
    if (!force && cached && this.now() - cached.fetchedAt < this.ttlMs) return false
    try {
      const fetchedAt = this.now()
      let before: unknown
      let after: unknown
      if (provider === 'codex') {
        const source = this.deps.codex
        if (!source) return false
        const models = await source.listModels()
        before = cached?.models ?? []
        after = models
        this.caches.codex = { fetchedAt, models }
      } else {
        const source = this.deps.cursor
        if (!source) return false
        const models = await source.listModels()
        before = cached?.models ?? []
        after = models
        this.caches.cursor = { fetchedAt, models }
      }
      await this.saveCache()
      return JSON.stringify(after) !== JSON.stringify(before)
    } catch (error: unknown) {
      this.log.warn(
        `could not list the ${providerName(provider)} models; keeping the previous list`,
        error
      )
      return false
    }
  }

  private learnedKey(ref: ModelRef): string {
    return `${ref.provider}:${ref.model}`
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    const path = this.deps.cachePath
    if (!path) return
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
      if (!parsed.success) return
      if (parsed.data.codex) this.caches.codex = parsed.data.codex
      if (parsed.data.cursor) this.caches.cursor = cursorCache(parsed.data.cursor)
    } catch {
      // A missing or unreadable cache file means nothing is cached yet.
    }
  }

  /** Writes the cached lists and keeps every other key of the file (update info arrives later). */
  private saveCache(): Promise<void> {
    this.saving = this.saving.then(() => this.writeCache())
    return this.saving
  }

  private async writeCache(): Promise<void> {
    const path = this.deps.cachePath
    if (!path) return
    const { codex, cursor } = this.caches
    if (!codex && !cursor) return
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
      const temp = `${path}.tmp`
      await writeFile(
        temp,
        JSON.stringify({ ...existing, ...(codex ? { codex } : {}), ...(cursor ? { cursor } : {}) }),
        'utf8'
      )
      await rename(temp, path)
    } catch (error: unknown) {
      this.log.warn('could not write the provider cache', error)
    }
  }
}

/** A cached Cursor entry as the registry holds it: the optional maker fields are kept when they are strings. */
function cursorCache(entry: z.infer<typeof cachedListSchema>): CachedModels<CachedCursorModel> {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  return {
    fetchedAt: entry.fetchedAt,
    models: entry.models.map((m) => {
      const group = text(m['group'])
      const base = text(m['base'])
      const variant = text(m['variant'])
      return {
        model: m.model,
        displayName: m.displayName,
        isDefault: m.isDefault,
        ...(group !== undefined ? { group } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(variant !== undefined ? { variant } : {})
      }
    })
  }
}

function normalizeRef(ref: ModelRef): ModelRef {
  return ref.provider === 'claude' ? { ...ref, model: normalizeModel(ref.model) } : ref
}
