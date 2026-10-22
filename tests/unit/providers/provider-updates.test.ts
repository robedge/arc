import { describe, expect, it, vi } from 'vitest'
import {
  ProviderStatusService,
  type ProviderChecker
} from '../../../src/main/providers/provider-status-service'
import type { ProviderId, ProviderStatus } from '../../../src/shared/types/provider'

interface World {
  claude: ProviderStatus
  codex: ProviderStatus
  cursor: ProviderStatus
}

function ok(provider: ProviderId, version: string): ProviderStatus {
  return { provider, state: 'ok', version, message: '', checkedAt: 1 }
}

function setup(
  options: { running?: boolean; latest?: Partial<Record<ProviderId, string | undefined>> } = {}
) {
  const world: World = {
    claude: ok('claude', '2.1.302'),
    codex: ok('codex', '0.162.1'),
    cursor: ok('cursor', '2026.10.19-6bbf2c4')
  }
  const latestMap = options.latest ?? { claude: '2.1.302', codex: '0.170.0' }
  const checker = {
    checkClaude: vi.fn(() => Promise.resolve(world.claude)),
    checkCodex: vi.fn(() => Promise.resolve(world.codex)),
    checkCursor: vi.fn(() => Promise.resolve(world.cursor)),
    resetPath: vi.fn()
  } satisfies ProviderChecker
  const latest = {
    get: vi.fn((provider: ProviderId) => Promise.resolve(latestMap[provider]))
  }
  const dismissed = new Map<ProviderId, string>()
  const publish = vi.fn()
  const running = { value: options.running ?? false }
  const service = new ProviderStatusService({
    checker,
    publish,
    latest,
    locate: (provider) =>
      Promise.resolve(
        provider === 'codex' ? '/opt/homebrew/Cellar/codex/0.162.1/bin/codex' : '/x/bin/claude'
      ),
    dismissals: {
      get: (p) => dismissed.get(p),
      set: (p, v) => void dismissed.set(p, v)
    },
    hasRunningAgents: () => running.value,
    now: () => 1
  })
  return { service, world, latest, latestMap, dismissed, publish, running }
}

describe('update fields', () => {
  it('flags an update with both versions and the derived command', async () => {
    const { service } = setup()
    await service.check()
    expect(service.getStatus('codex')).toMatchObject({
      version: '0.162.1',
      latestVersion: '0.170.0',
      updateAvailable: true,
      updateCommand: 'brew upgrade codex',
      updateDismissed: false
    })
    expect(service.getStatus('claude')).toMatchObject({
      latestVersion: '2.1.302',
      updateAvailable: false
    })
    expect(service.getStatus('claude')?.updateCommand).toBeUndefined()
  })

  it('publishes the status first, then again once the lookup adds the update', async () => {
    const { service, publish } = setup()
    await service.check('codex')
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[0]?.[0].codex.updateAvailable).toBe(false)
    expect(publish.mock.calls[1]?.[0].codex.updateAvailable).toBe(true)
  })

  it('compares numerically: 0.9.0 installed is behind 0.10.0', async () => {
    const { service, world } = setup({ latest: { claude: undefined, codex: '0.10.0' } })
    world.codex = ok('codex', '0.9.0')
    await service.check('codex')
    expect(service.getStatus('codex')?.updateAvailable).toBe(true)
  })

  it('shows no update when the lookup fails', async () => {
    const { service } = setup({ latest: { claude: undefined, codex: undefined } })
    await service.check()
    expect(service.getStatus('codex')?.updateAvailable).toBe(false)
    expect(service.getStatus('codex')?.latestVersion).toBeUndefined()
  })

  it('asks the registry to bypass its cache only on Check again', async () => {
    const { service, latest } = setup()
    await service.check('codex')
    await service.check('codex', { forceLatest: true })
    expect(latest.get).toHaveBeenNthCalledWith(1, 'codex', { force: false })
    expect(latest.get).toHaveBeenNthCalledWith(2, 'codex', { force: true })
  })

  it('clears the update once the new version is detected', async () => {
    const { service, world } = setup()
    await service.check('codex')
    world.codex = ok('codex', '0.170.0')
    await service.check('codex')
    expect(service.getStatus('codex')).toMatchObject({ version: '0.170.0', updateAvailable: false })
  })
})

describe('Cursor update notice', () => {
  const cursorLatest = (latest: string) => ({ claude: '2.1.302', codex: '0.162.1', cursor: latest })

  it('shows one only when `agent about` reports a newer version, with `agent update`', async () => {
    const { service } = setup({ latest: cursorLatest('2026.11.01-abc1234') })
    await service.check('cursor')
    expect(service.getStatus('cursor')).toMatchObject({
      latestVersion: '2026.11.01-abc1234',
      updateAvailable: true,
      updateCommand: 'agent update'
    })
  })

  it('shows none when about reports the installed version, even with another build hash', async () => {
    const { service } = setup({ latest: cursorLatest('2026.10.19-ffffff0') })
    await service.check('cursor')
    expect(service.getStatus('cursor')?.updateAvailable).toBe(false)
  })

  it('shows none when about reports nothing', async () => {
    const { service } = setup({ latest: { claude: '2.1.302', codex: '0.162.1' } })
    await service.check('cursor')
    expect(service.getStatus('cursor')?.updateAvailable).toBe(false)
  })
})

describe('the dismiss rule', () => {
  it('marks the notice dismissed for that version only, and the update stays', async () => {
    const { service, dismissed, publish } = setup()
    await service.check('codex')
    publish.mockClear()
    service.dismissUpdate('codex', '0.170.0')
    expect(dismissed.get('codex')).toBe('0.170.0')
    expect(service.getStatus('codex')).toMatchObject({
      updateAvailable: true,
      updateDismissed: true
    })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('stays dismissed after a later check of the same version', async () => {
    const { service } = setup()
    await service.check('codex')
    service.dismissUpdate('codex', '0.170.0')
    await service.check('codex')
    expect(service.getStatus('codex')?.updateDismissed).toBe(true)
  })

  it('shows the notice again when a newer version than the dismissed one is published', async () => {
    const { service, latestMap } = setup()
    await service.check('codex')
    service.dismissUpdate('codex', '0.170.0')
    latestMap.codex = '0.171.0'
    await service.check('codex')
    expect(service.getStatus('codex')).toMatchObject({
      latestVersion: '0.171.0',
      updateDismissed: false
    })
  })

  it('does not dismiss the other provider', async () => {
    const { service } = setup({ latest: { claude: '2.2.0', codex: '0.170.0' } })
    await service.check()
    service.dismissUpdate('codex', '0.170.0')
    expect(service.getStatus('claude')).toMatchObject({
      updateAvailable: true,
      updateDismissed: false
    })
  })
})

describe('restart required', () => {
  it('is set when the binary is gone while agents run', async () => {
    const { service, world, running } = setup()
    await service.check('codex')
    running.value = true
    world.codex = { provider: 'codex', state: 'missing', message: 'gone', checkedAt: 2 }
    await service.check('codex')
    expect(service.getStatus('codex')).toMatchObject({ restartRequired: true })
    expect(service.getStatus('codex')?.restartReason).toContain('can no longer be found')
  })

  it('is set when the new version falls below the minimum while agents run', async () => {
    const { service, world, running } = setup()
    await service.check('codex')
    running.value = true
    world.codex = { ...ok('codex', '0.100.0'), state: 'unsupported', message: 'old' }
    await service.check('codex')
    expect(service.getStatus('codex')?.restartRequired).toBe(true)
  })

  it('is not set without running agents, and stays until the provider is ok again', async () => {
    const { service, world, running } = setup()
    await service.check('codex')
    world.codex = { provider: 'codex', state: 'missing', message: 'gone', checkedAt: 2 }
    await service.check('codex')
    expect(service.getStatus('codex')?.restartRequired).toBeUndefined()

    world.codex = ok('codex', '0.162.1')
    await service.check('codex')
    running.value = true
    world.codex = { provider: 'codex', state: 'missing', message: 'gone', checkedAt: 3 }
    await service.check('codex')
    running.value = false
    await service.check('codex')
    expect(service.getStatus('codex')?.restartRequired).toBe(true)
    world.codex = ok('codex', '0.170.0')
    await service.check('codex')
    expect(service.getStatus('codex')?.restartRequired).toBeUndefined()
  })
})
