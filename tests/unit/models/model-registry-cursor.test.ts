import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexModelInfo } from '../../../src/main/agents/codex/codex-probe'
import { mapCursorModels, type CursorModelInfo } from '../../../src/main/agents/cursor/cursor-probe'
import { MODEL_CACHE_TTL_MS, ModelRegistry } from '../../../src/main/models/model-registry'
import type { ProviderState, ProviderStatusMap } from '../../../src/shared/types/provider'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'arc-model-registry-cursor-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const CURSOR_LIST: CursorModelInfo[] = mapCursorModels([
  { modelId: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]', name: 'grok-4.7' },
  { modelId: 'default[]', name: 'Auto' },
  { modelId: 'claude-haiku-5-5[thinking=true]', name: 'claude-haiku-5-5' },
  { modelId: 'claude-opus-5[effort=high]', name: 'claude-opus-5' }
])
const CODEX_LIST: CodexModelInfo[] = [
  { model: 'gpt-6-sol', displayName: 'GPT-6 Sol', isDefault: true }
]

function rig(options: { cursor?: ProviderState; codex?: ProviderState } = {}): {
  registry: ModelRegistry
  cursorSource: { calls: number; fail: boolean; list: CursorModelInfo[]; gate?: Promise<void> }
  codexSource: { calls: number }
  clock: { now: number }
  status: { cursor: ProviderState | undefined; codex: ProviderState | undefined }
  cachePath: string
} {
  const clock = { now: 1_000_000 }
  const status = {
    cursor: options.cursor ?? ('ok' as ProviderState | undefined),
    codex: options.codex
  }
  const cursorSource: {
    calls: number
    fail: boolean
    list: CursorModelInfo[]
    gate?: Promise<void>
  } = { calls: 0, fail: false, list: CURSOR_LIST }
  const codexSource = { calls: 0 }
  const cachePath = join(dir, 'provider-cache.json')
  const map = (): ProviderStatusMap => ({
    ...(status.cursor
      ? { cursor: { provider: 'cursor', state: status.cursor, message: '', checkedAt: 1 } }
      : {}),
    ...(status.codex
      ? { codex: { provider: 'codex', state: status.codex, message: '', checkedAt: 1 } }
      : {})
  })
  const registry = new ModelRegistry({
    cursor: {
      async listModels() {
        cursorSource.calls += 1
        await cursorSource.gate
        if (cursorSource.fail) throw new Error('probe failed')
        return cursorSource.list
      }
    },
    codex: {
      listModels() {
        codexSource.calls += 1
        return Promise.resolve(CODEX_LIST)
      }
    },
    status: map,
    cachePath,
    now: () => clock.now,
    log: { warn: vi.fn() }
  })
  return { registry, cursorSource, codexSource, clock, status, cachePath }
}

describe('Cursor models', () => {
  it('lists nothing before the first refresh', () => {
    const { registry } = rig()
    expect(registry.list('cursor')).toEqual([])
    expect(registry.defaultFor('cursor')).toBeUndefined()
  })

  it('lists the probed models, Auto first, with group, base, variant and a tier', async () => {
    const { registry } = rig()
    await registry.refresh()
    const models = registry.list('cursor')
    expect(models.map((m) => m.ref)).toEqual([
      { provider: 'cursor', model: 'default[]' },
      { provider: 'cursor', model: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]' },
      { provider: 'cursor', model: 'claude-haiku-5-5[thinking=true]' },
      { provider: 'cursor', model: 'claude-opus-5[effort=high]' }
    ])
    expect(models[0]).toEqual({
      ref: { provider: 'cursor', model: 'default[]' },
      label: 'Auto',
      tier: 'balanced',
      isDefault: true,
      group: 'Cursor',
      base: 'Auto'
    })
    expect(models[1]).toMatchObject({
      label: 'grok-4.7 · high · fast',
      tier: 'balanced',
      group: 'Grok',
      base: 'grok-4.7',
      variant: 'context=256k,reasoning_effort=high,fast=true'
    })
    expect(models.map((m) => m.tier)).toEqual(['balanced', 'balanced', 'fast', 'deep'])
    expect(registry.defaultFor('cursor')).toEqual({ provider: 'cursor', model: 'default[]' })
    expect(registry.cheapestFor('cursor')).toEqual({
      provider: 'cursor',
      model: 'claude-haiku-5-5[thinking=true]'
    })
    expect(registry.all().cursor).toEqual(models)
  })

  it('accepts a listed id and rejects an unknown one', async () => {
    const { registry } = rig()
    await registry.refresh()
    expect(registry.has({ provider: 'cursor', model: 'default[]' })).toBe(true)
    expect(registry.has({ provider: 'cursor', model: 'nope[]' })).toBe(false)
    expect(registry.has({ provider: 'codex', model: 'default[]' })).toBe(false)
  })

  it('lists nothing while Cursor is not ok, and does not probe', async () => {
    const { registry, cursorSource, status } = rig({ cursor: 'signed_out' })
    await registry.refresh({ force: true })
    expect(cursorSource.calls).toBe(0)
    status.cursor = 'ok'
    await registry.refresh()
    expect(registry.list('cursor')).toHaveLength(4)
    for (const state of ['missing', 'signed_out', 'unsupported', 'error'] as const) {
      status.cursor = state
      expect(registry.list('cursor')).toEqual([])
      expect(registry.all().cursor).toEqual([])
    }
    status.cursor = undefined
    expect(registry.list('cursor')).toEqual([])
  })

  it('caches for 24 hours and probes again after, or when forced', async () => {
    const { registry, cursorSource, clock } = rig()
    expect(await registry.refresh()).toBe(true)
    expect(await registry.refresh()).toBe(false)
    expect(cursorSource.calls).toBe(1)
    clock.now += MODEL_CACHE_TTL_MS - 1
    await registry.refresh()
    expect(cursorSource.calls).toBe(1)
    clock.now += 1
    await registry.refresh()
    expect(cursorSource.calls).toBe(2)
    await registry.refresh({ force: true })
    expect(cursorSource.calls).toBe(3)
  })

  it('reports a change only when the list differs, and picks up a new model on a forced refresh', async () => {
    const { registry, cursorSource } = rig()
    await registry.refresh()
    expect(await registry.refresh({ force: true })).toBe(false)
    cursorSource.list = [
      ...CURSOR_LIST,
      ...mapCursorModels([{ modelId: 'new-model[]', name: 'new-model' }])
    ]
    expect(await registry.refresh({ force: true })).toBe(true)
    expect(registry.list('cursor').map((m) => m.ref.model)).toContain('new-model[]')
  })

  it('keeps the previous list when the probe fails', async () => {
    const { registry, cursorSource } = rig()
    await registry.refresh()
    cursorSource.fail = true
    expect(await registry.refresh({ force: true })).toBe(false)
    expect(registry.list('cursor')).toHaveLength(4)
  })

  it('writes the list to provider-cache.json beside the Codex one, and a new registry reads it back', async () => {
    const { registry, cachePath } = rig({ codex: 'ok' })
    await registry.refresh()
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      cursor: { fetchedAt: number; models: CursorModelInfo[] }
      codex: { models: CodexModelInfo[] }
    }
    expect(stored.cursor.models).toEqual(CURSOR_LIST)
    expect(stored.codex.models).toEqual(CODEX_LIST)

    // A second registry starts from the file: no probe within 24 hours.
    const second = rig()
    writeFileSync(second.cachePath, JSON.stringify(stored))
    second.clock.now = stored.cursor.fetchedAt + 1000
    await second.registry.refresh()
    expect(second.cursorSource.calls).toBe(0)
    expect(second.registry.list('cursor').map((m) => m.ref.model)).toEqual(
      registry.list('cursor').map((m) => m.ref.model)
    )
    expect(second.registry.list('cursor')[0]).toMatchObject({ group: 'Cursor', base: 'Auto' })
  })

  it('keeps unknown keys of the cache file', async () => {
    const { registry, cachePath } = rig()
    writeFileSync(cachePath, JSON.stringify({ latest: { claude: '2.1.310' } }))
    await registry.refresh()
    const stored = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(stored.latest).toEqual({ claude: '2.1.310' })
    expect(stored).toHaveProperty('cursor')
  })

  it('tiers an unlisted Cursor model by its name', () => {
    const { registry } = rig({ cursor: 'signed_out' })
    expect(registry.tierOf({ provider: 'cursor', model: 'gpt-5.4-mini[reasoning=medium]' })).toBe(
      'fast'
    )
    expect(registry.tierOf({ provider: 'cursor', model: 'claude-opus-4-8[effort=high]' })).toBe(
      'deep'
    )
    expect(registry.tierOf({ provider: 'cursor', model: 'default[]' })).toBe('balanced')
  })

  it('shares one forced refresh with a plain one and runs a forced one after a plain one', async () => {
    const { registry, cursorSource } = rig()
    let release!: () => void
    cursorSource.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plain = registry.refresh()
    const plainAgain = registry.refresh()
    expect(plainAgain).toBe(plain)
    const forced = registry.refresh({ force: true })
    expect(forced).not.toBe(plain)
    release()
    expect(await plain).toBe(true)
    expect(await forced).toBe(true)
    // The plain refresh probed once; the forced one ran after it and probed again.
    expect(cursorSource.calls).toBe(2)
  })

  it('refreshes Codex and Cursor in the same call', async () => {
    const { registry, codexSource, cursorSource } = rig({ codex: 'ok' })
    await registry.refresh({ force: true })
    expect(codexSource.calls).toBe(1)
    expect(cursorSource.calls).toBe(1)
    expect(registry.list('codex')).toHaveLength(1)
    expect(registry.list('cursor')).toHaveLength(4)
  })
})
