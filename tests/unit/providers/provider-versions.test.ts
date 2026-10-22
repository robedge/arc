import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LatestVersions,
  compareVersions,
  isNewerVersion,
  updateCommandFor
} from '../../../src/main/providers/provider-versions'
import { useTempDir } from '../helpers/temp-dir'

describe('compareVersions', () => {
  it('compares numeric segments, not strings', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('2.1.302', '2.1.31')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBe(1)
  })

  it('ignores a prerelease unless both versions have one', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.4-beta.1', '1.2.3')).toBe(1)
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.10')).toBe(-1)
    expect(compareVersions('1.2.3-rc.1', '1.2.3-beta.9')).toBe(1)
  })
})

describe('Cursor versions', () => {
  it('compares the date and ignores the build hash', () => {
    expect(isNewerVersion('2026.11.01-abc1234', '2026.10.19-6bbf2c4')).toBe(true)
    expect(isNewerVersion('2026.10.19-ffffff0', '2026.10.19-6bbf2c4')).toBe(false)
    expect(isNewerVersion('2026.10.19-0000000', '2026.10.19-6bbf2c4')).toBe(false)
    expect(isNewerVersion('2026.9.30-aaaaaaa', '2026.10.19-6bbf2c4')).toBe(false)
  })

  it('updates with `agent update`', () => {
    expect(updateCommandFor('cursor', '/Users/me/.local/bin/agent')).toBe('agent update')
    expect(updateCommandFor('cursor', undefined)).toBe('agent update')
  })
})

describe('updateCommandFor', () => {
  it('defaults to the tool’s own update command', () => {
    expect(updateCommandFor('claude', '/Users/me/.local/bin/claude')).toBe('claude update')
    expect(updateCommandFor('codex', undefined)).toBe('codex update')
  })

  it('uses brew when the real path goes through the Cellar or the Caskroom', () => {
    expect(updateCommandFor('codex', '/opt/homebrew/Cellar/codex/0.162.1/bin/codex')).toBe(
      'brew upgrade codex'
    )
    expect(updateCommandFor('claude', '/opt/homebrew/Caskroom/claude-code/2.1.302/claude')).toBe(
      'brew upgrade --cask claude-code'
    )
  })

  it('keeps `codex update` for an npm install that sits under the Homebrew prefix', () => {
    expect(
      updateCommandFor('codex', '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')
    ).toBe('codex update')
  })
})

describe('LatestVersions', () => {
  const dir = useTempDir('arc-latest-')
  const okResponse = (version: string): Response =>
    new Response(JSON.stringify({ name: 'x', version }), { status: 200 })

  function make(overrides: Partial<ConstructorParameters<typeof LatestVersions>[0]> = {}) {
    let clock = 1_000_000
    const fetchFn = vi.fn((...args: Parameters<typeof fetch>) =>
      Promise.resolve(okResponse(String(args[0]).includes('codex') ? '0.170.0' : '2.2.0'))
    )
    const debug = vi.fn()
    const latest = new LatestVersions({
      fetch: fetchFn as unknown as typeof fetch,
      cachePath: join(dir(), 'provider-cache.json'),
      env: {},
      isPackaged: true,
      now: () => clock,
      log: { debug },
      ...overrides
    })
    return { latest, fetchFn, debug, advance: (ms: number) => (clock += ms) }
  }

  it('reads `.version` from the right registry URL', async () => {
    const { latest, fetchFn } = make()
    expect(await latest.get('codex')).toBe('0.170.0')
    expect(await latest.get('claude')).toBe('2.2.0')
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://registry.npmjs.org/@openai/codex/latest',
      'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'
    ])
  })

  it('serves the cache for 6 hours, then looks up again', async () => {
    const { latest, fetchFn, advance } = make()
    await latest.get('codex')
    advance(6 * 60 * 60 * 1000 - 1)
    await latest.get('codex')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    advance(2)
    await latest.get('codex')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('looks up again when forced', async () => {
    const { latest, fetchFn } = make()
    await latest.get('codex')
    await latest.get('codex', { force: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('persists in provider-cache.json, next to the other keys, and a new instance reuses it', async () => {
    const path = join(dir(), 'provider-cache.json')
    await mkdir(dir(), { recursive: true })
    await writeFile(path, JSON.stringify({ codex: { fetchedAt: 1, models: [] } }), 'utf8')
    const first = make()
    await first.latest.get('codex')
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(saved['codex']).toEqual({ fetchedAt: 1, models: [] })
    expect(saved['latest']).toMatchObject({ codex: { version: '0.170.0' } })

    const second = make()
    expect(await second.latest.get('codex')).toBe('0.170.0')
    expect(second.fetchFn).not.toHaveBeenCalled()
  })

  it('is silent on a failure: no version, one debug line, nothing thrown', async () => {
    const { latest, debug } = make({
      fetch: vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    })
    expect(await latest.get('codex')).toBeUndefined()
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('treats a bad status or a body without a version as a failure', async () => {
    const bad = make({
      fetch: vi.fn(() =>
        Promise.resolve(new Response('nope', { status: 503 }))
      ) as unknown as typeof fetch
    })
    expect(await bad.latest.get('codex')).toBeUndefined()
    const empty = make({
      fetch: vi.fn(() =>
        Promise.resolve(new Response('{}', { status: 200 }))
      ) as unknown as typeof fetch
    })
    expect(await empty.latest.get('codex')).toBeUndefined()
  })

  it('gives the request a 5 second abort signal', async () => {
    const { latest, fetchFn } = make()
    await latest.get('codex')
    const init = fetchFn.mock.calls[0]?.[1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('reads the test file instead of the network, only in e2e or unpackaged runs', async () => {
    const file = join(dir(), 'latest.json')
    await writeFile(file, JSON.stringify({ codex: '0.199.0' }), 'utf8')
    const e2e = make({ env: { HARNESS_E2E: '1', HARNESS_PROVIDER_LATEST_FILE: file } })
    expect(await e2e.latest.get('codex')).toBe('0.199.0')
    expect(await e2e.latest.get('claude')).toBeUndefined()
    expect(e2e.fetchFn).not.toHaveBeenCalled()

    const packaged = make({ env: { HARNESS_PROVIDER_LATEST_FILE: file } })
    expect(await packaged.latest.get('codex')).toBe('0.170.0')
  })

  it('never reaches the network in an e2e run without the test file', async () => {
    const { latest, fetchFn } = make({ env: { HARNESS_E2E: '1' } })
    expect(await latest.get('codex')).toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  describe('per-provider sources', () => {
    it('asks the Cursor source, not the registry, and caches it for 6 hours', async () => {
      const cursor = vi.fn(() => Promise.resolve('2026.11.01-abc1234' as string | undefined))
      const { latest, fetchFn, advance } = make({ sources: { cursor } })
      expect(await latest.get('cursor')).toBe('2026.11.01-abc1234')
      advance(6 * 60 * 60 * 1000 - 1)
      await latest.get('cursor')
      expect(cursor).toHaveBeenCalledTimes(1)
      advance(2)
      await latest.get('cursor')
      expect(cursor).toHaveBeenCalledTimes(2)
      expect(fetchFn).not.toHaveBeenCalled()
      expect(await latest.get('codex')).toBe('0.170.0')
    })

    it('has no version when the Cursor source reports none, and says so in the log', async () => {
      const { latest, debug } = make({ sources: { cursor: () => Promise.resolve(undefined) } })
      expect(await latest.get('cursor')).toBeUndefined()
      expect(debug).toHaveBeenCalled()
    })

    it('keeps the Cursor entry in provider-cache.json and reuses it in a new instance', async () => {
      const cursor = vi.fn(() => Promise.resolve('2026.11.01-abc1234' as string | undefined))
      await make({ sources: { cursor } }).latest.get('cursor')
      const second = make({ sources: { cursor } })
      expect(await second.latest.get('cursor')).toBe('2026.11.01-abc1234')
      expect(cursor).toHaveBeenCalledTimes(1)
    })

    it('lets HARNESS_PROVIDER_LATEST_FILE answer for every provider, Cursor included', async () => {
      const file = join(dir(), 'latest.json')
      await mkdir(dir(), { recursive: true })
      await writeFile(
        file,
        JSON.stringify({ claude: '2.9.0', codex: '0.9.9', cursor: '2026.12.01-abcdef0' }),
        'utf8'
      )
      const cursor = vi.fn(() => Promise.resolve('1.0.0' as string | undefined))
      const { latest, fetchFn } = make({
        env: { HARNESS_PROVIDER_LATEST_FILE: file, HARNESS_E2E: '1' },
        sources: { cursor }
      })
      expect(await latest.get('claude')).toBe('2.9.0')
      expect(await latest.get('codex')).toBe('0.9.9')
      expect(await latest.get('cursor')).toBe('2026.12.01-abcdef0')
      expect(cursor).not.toHaveBeenCalled()
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })
})
