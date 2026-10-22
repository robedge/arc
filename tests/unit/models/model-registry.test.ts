import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexModelInfo, CodexModelSource } from '../../../src/main/agents/codex/codex-probe'
import { codexTier } from '../../../src/main/models/codex-tiers'
import {
  MODEL_CACHE_TTL_MS,
  ModelRegistry,
  cacheSchema
} from '../../../src/main/models/model-registry'
import type { ProviderState, ProviderStatusMap } from '../../../src/shared/types/provider'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'arc-model-registry-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const LIST: CodexModelInfo[] = [
  { model: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: false },
  { model: 'gpt-6-sol', displayName: 'GPT-6 Sol', isDefault: true },
  { model: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: false }
]

function rig(options: { state?: ProviderState; list?: CodexModelInfo[]; cache?: boolean } = {}): {
  registry: ModelRegistry
  source: CodexModelSource & { calls: number; fail: boolean; list: CodexModelInfo[] }
  clock: { now: number }
  status: { state: ProviderState | undefined }
  cachePath: string
} {
  const clock = { now: 1_000_000 }
  const status: { state: ProviderState | undefined } = { state: options.state ?? 'ok' }
  const source = {
    calls: 0,
    fail: false,
    list: options.list ?? LIST,
    listModels(): Promise<CodexModelInfo[]> {
      source.calls += 1
      return source.fail ? Promise.reject(new Error('probe failed')) : Promise.resolve(source.list)
    }
  }
  const cachePath = join(dir, 'provider-cache.json')
  const map = (): ProviderStatusMap =>
    status.state === undefined
      ? {}
      : { codex: { provider: 'codex', state: status.state, message: '', checkedAt: 1 } }
  const registry = new ModelRegistry({
    codex: source,
    status: map,
    cachePath: options.cache === false ? undefined : cachePath,
    now: () => clock.now,
    log: { warn: vi.fn() }
  })
  return { registry, source, clock, status, cachePath }
}

describe('Claude models', () => {
  it('lists opus, sonnet and haiku with sonnet as the default, whatever Codex does', () => {
    const { registry } = rig({ state: 'missing' })
    expect(registry.list('claude').map((m) => [m.ref.model, m.tier, m.isDefault])).toEqual([
      ['opus', 'deep', false],
      ['sonnet', 'balanced', true],
      ['haiku', 'fast', false]
    ])
    expect(registry.defaultFor('claude')).toEqual({ provider: 'claude', model: 'sonnet' })
  })

  it('accepts aliases in any case and learned full ids, and nothing else', () => {
    const { registry } = rig()
    expect(registry.has({ provider: 'claude', model: 'Opus' })).toBe(true)
    expect(registry.has({ provider: 'claude', model: 'claude-opus-5-1' })).toBe(false)
    registry.learn({ provider: 'claude', model: 'claude-opus-5-1' })
    expect(registry.has({ provider: 'claude', model: 'claude-opus-5-1' })).toBe(true)
    expect(registry.has({ provider: 'claude', model: 'gpt-6-sol' })).toBe(false)
  })
})

describe('Codex models', () => {
  it('lists nothing before the first refresh and nothing while Codex is not ok', async () => {
    const { registry, status } = rig()
    expect(registry.list('codex')).toEqual([])
    await registry.refresh()
    expect(registry.list('codex')).toHaveLength(3)
    for (const state of ['missing', 'signed_out', 'unsupported', 'error'] as const) {
      status.state = state
      expect(registry.list('codex')).toEqual([])
      expect(registry.defaultFor('codex')).toBeUndefined()
      expect(registry.all().codex).toEqual([])
    }
    status.state = undefined
    expect(registry.list('codex')).toEqual([])
  })

  it('does not call the probe while Codex is not ok', async () => {
    const { registry, source, status } = rig({ state: 'signed_out' })
    await registry.refresh()
    await registry.refresh({ force: true })
    expect(source.calls).toBe(0)
    status.state = 'ok'
    await registry.refresh()
    expect(source.calls).toBe(1)
  })

  it('puts the default first and tiers each model by its name', async () => {
    const { registry } = rig()
    await registry.refresh()
    const models = registry.list('codex')
    expect(models.map((m) => [m.ref.model, m.label, m.tier, m.isDefault])).toEqual([
      ['gpt-6-sol', 'GPT-6 Sol', 'balanced', true],
      ['gpt-6-luna', 'GPT-6 Luna', 'fast', false],
      ['gpt-6-astra', 'GPT-6 Astra', 'deep', false]
    ])
    expect(registry.defaultFor('codex')).toEqual({ provider: 'codex', model: 'gpt-6-sol' })
    expect(registry.has({ provider: 'codex', model: 'gpt-6-luna' })).toBe(true)
    expect(registry.has({ provider: 'codex', model: 'gpt-5.5' })).toBe(false)
    expect(registry.tierOf({ provider: 'codex', model: 'gpt-6-luna' })).toBe('fast')
  })

  it('tiers an unlisted Codex model by its name alone', () => {
    const { registry } = rig({ state: 'signed_out' })
    expect(registry.tierOf({ provider: 'codex', model: 'gpt-6-luna' })).toBe('fast')
    expect(registry.tierOf({ provider: 'codex', model: 'gpt-6-sol' })).toBe('deep')
  })

  it('uses the first model when none is marked default', async () => {
    const { registry } = rig({ list: [{ model: 'a', displayName: 'A', isDefault: false }] })
    await registry.refresh()
    expect(registry.defaultFor('codex')).toEqual({ provider: 'codex', model: 'a' })
  })

  it('falls back to the id when the display name is empty', async () => {
    const { registry } = rig({ list: [{ model: 'a', displayName: '', isDefault: true }] })
    await registry.refresh()
    expect(registry.list('codex')[0]?.label).toBe('a')
  })
})

describe('the cache', () => {
  it('keeps the list for 24 hours in memory and writes it to provider-cache.json', async () => {
    const { registry, source, clock, cachePath } = rig()
    await registry.refresh()
    await registry.refresh()
    expect(source.calls).toBe(1)
    clock.now += MODEL_CACHE_TTL_MS - 1
    await registry.refresh()
    expect(source.calls).toBe(1)
    clock.now += 2
    await registry.refresh()
    expect(source.calls).toBe(2)
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      codex: { fetchedAt: number; models: CodexModelInfo[] }
    }
    expect(stored.codex.fetchedAt).toBe(clock.now)
    expect(stored.codex.models).toEqual(LIST)
  })

  it('force refreshes at once', async () => {
    const { registry, source } = rig()
    await registry.refresh()
    await registry.refresh({ force: true })
    expect(source.calls).toBe(2)
  })

  it('a second registry on the same file reads the cache and does not probe', async () => {
    const first = rig()
    await first.registry.refresh()
    const second = new ModelRegistry({
      codex: first.source,
      status: () => ({ codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 1 } }),
      cachePath: first.cachePath,
      now: () => first.clock.now + 1000
    })
    await second.refresh()
    expect(first.source.calls).toBe(1)
    expect(second.list('codex').map((m) => m.ref.model)).toEqual([
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-6-astra'
    ])
  })

  it('keeps the other keys of the file when it writes', async () => {
    const { registry, cachePath } = rig()
    writeFileSync(cachePath, JSON.stringify({ latest: { claude: '2.1.310' } }))
    await registry.refresh()
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(stored['latest']).toEqual({ claude: '2.1.310' })
    expect(stored['codex']).toBeDefined()
  })

  it('a stale cache stays in use when the probe fails, and the failure is not thrown', async () => {
    const { registry, source, clock } = rig()
    await registry.refresh()
    clock.now += MODEL_CACHE_TTL_MS + 1
    source.fail = true
    await expect(registry.refresh()).resolves.toBe(false)
    expect(registry.list('codex')).toHaveLength(3)
  })

  it('says whether a refresh changed the model list', async () => {
    const { registry, source } = rig()
    expect(await registry.refresh()).toBe(true)
    expect(await registry.refresh({ force: true })).toBe(false)
    source.list = [...source.list, { model: 'gpt-new', displayName: 'GPT New', isDefault: false }]
    expect(await registry.refresh({ force: true })).toBe(true)
    expect(registry.list('codex').map((m) => m.ref.model)).toContain('gpt-new')
  })

  it('an unreadable cache file is ignored', async () => {
    const { registry, source, cachePath } = rig()
    writeFileSync(cachePath, '{not json')
    await registry.refresh()
    expect(source.calls).toBe(1)
    expect(registry.list('codex')).toHaveLength(3)
  })

  it('runs without a cache file', async () => {
    const { registry, source } = rig({ cache: false })
    await registry.refresh()
    await registry.refresh()
    expect(source.calls).toBe(1)
  })

  it('shares one probe between callers that refresh at the same time', async () => {
    const { registry, source } = rig()
    await Promise.all([registry.refresh(), registry.refresh()])
    expect(source.calls).toBe(1)
    await Promise.all([registry.refresh({ force: true }), registry.refresh({ force: true })])
    expect(source.calls).toBe(2)
  })

  it('a forced refresh during a plain one that kept a fresh cache still probes', async () => {
    const { registry, source } = rig()
    await registry.refresh()
    source.list = [...source.list, { model: 'gpt-new', displayName: 'GPT New', isDefault: false }]
    // The plain refresh keeps the fresh cache; the forced one asked meanwhile must not take its answer.
    const [plain, forced, after] = await Promise.all([
      registry.refresh(),
      registry.refresh({ force: true }),
      registry.refresh()
    ])
    expect(source.calls).toBe(2)
    expect(plain).toBe(false)
    expect(forced).toBe(true)
    expect(after).toBe(true)
    expect(registry.list('codex').map((m) => m.ref.model)).toContain('gpt-new')
  })
})

describe('codexTier', () => {
  it.each([
    ['gpt-6-luna', false, 'fast'],
    ['gpt-5.5-codex-mini', false, 'fast'],
    ['gpt-5.3-codex-spark', false, 'fast'],
    ['gpt-nano', true, 'fast'],
    ['fake-fast', false, 'fast'],
    ['gpt-6-sol', true, 'balanced'],
    ['gpt-6-astra', false, 'deep'],
    ['gpt-5.6-terra', false, 'balanced'],
    ['minimal-gpt', false, 'deep'],
    ['LUNA', false, 'fast']
  ] as const)('%s (default %s) is %s', (model, isDefault, tier) => {
    expect(codexTier({ model, isDefault })).toBe(tier)
  })
})

describe('ModelRegistry.cheapestFor', () => {
  it('is the fast tier of Claude (Haiku)', () => {
    const { registry } = rig()
    expect(registry.cheapestFor('claude')).toEqual({ provider: 'claude', model: 'haiku' })
  })

  it('is the fast tier of Codex while Codex is ok, and none otherwise', async () => {
    const ok = rig()
    await ok.registry.refresh()
    expect(ok.registry.cheapestFor('codex')).toEqual({ provider: 'codex', model: 'gpt-6-luna' })
    expect(rig({ state: 'missing' }).registry.cheapestFor('codex')).toBeUndefined()
  })
})

describe('the cache file schema', () => {
  it('parses an old file with only claude/codex-era keys and keeps the codex entry', async () => {
    const { registry, source, cachePath } = rig()
    const entry = { fetchedAt: 1_000_000, models: LIST }
    writeFileSync(cachePath, JSON.stringify({ latest: { claude: '2.1.310' }, codex: entry }))
    await registry.refresh({ force: true })
    expect(source.calls).toBe(1)
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(stored.latest).toEqual({ claude: '2.1.310' })
    expect(stored).not.toHaveProperty('cursor')
  })

  it('parses a cursor entry with optional group/base/variant and rejects a malformed one', () => {
    const models = [{ model: 'gpt-5', displayName: 'GPT-5', isDefault: true, group: 'gpt' }]
    expect(cacheSchema.safeParse({ codex: { fetchedAt: 1, models: [] } }).success).toBe(true)
    const ok = cacheSchema.safeParse({ cursor: { fetchedAt: 1, models } })
    expect(ok.success).toBe(true)
    expect(ok.data?.cursor?.models[0]).toMatchObject({ group: 'gpt' })
    expect(cacheSchema.safeParse({ cursor: { fetchedAt: 'x', models } }).success).toBe(false)
  })

  it('rewrites a file that has a cursor entry without dropping it', async () => {
    const { registry, cachePath } = rig()
    const cursor = { fetchedAt: 5, models: [{ model: 'm', displayName: 'M', isDefault: false }] }
    writeFileSync(cachePath, JSON.stringify({ cursor }))
    await registry.refresh({ force: true })
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(stored.cursor).toEqual(cursor)
    expect(stored).toHaveProperty('codex')
  })
})
