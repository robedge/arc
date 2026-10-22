import { describe, expect, it, vi } from 'vitest'
import {
  ProviderStatusService,
  type ProviderChecker
} from '../../../src/main/providers/provider-status-service'
import type { ProviderId, ProviderStatus } from '../../../src/shared/types/provider'

function status(provider: ProviderId, state: ProviderStatus['state'], at: number): ProviderStatus {
  return { provider, state, message: state === 'ok' ? '' : 'm', checkedAt: at }
}

function setup(codex: ProviderStatus['state'] = 'ok') {
  let clock = 1000
  const checker = {
    checkClaude: vi.fn(() =>
      Promise.resolve({ ...status('claude', 'ok', clock), version: '2.1.302' })
    ),
    checkCodex: vi.fn(() => Promise.resolve(status('codex', codex, clock))),
    checkCursor: vi.fn(() => Promise.resolve(status('cursor', 'missing', clock))),
    resetPath: vi.fn()
  } satisfies ProviderChecker
  const publish = vi.fn()
  const service = new ProviderStatusService({ checker, publish, now: () => clock, ttlMs: 30_000 })
  return { service, checker, publish, advance: (ms: number) => (clock += ms) }
}

describe('ProviderStatusService', () => {
  it('is empty until a check finishes', () => {
    expect(setup().service.get()).toEqual({})
  })

  it('check() runs both providers, resets the PATH, publishes the map and returns it', async () => {
    const { service, checker, publish } = setup('signed_out')
    const map = await service.check()
    expect(checker.resetPath).toHaveBeenCalledTimes(1)
    expect(map.claude?.state).toBe('ok')
    expect(map.codex?.state).toBe('signed_out')
    expect(publish).toHaveBeenLastCalledWith(map)
    expect(service.get()).toEqual(map)
  })

  it('check(provider) runs only that provider', async () => {
    const { service, checker } = setup()
    const map = await service.check('codex')
    expect(checker.checkClaude).not.toHaveBeenCalled()
    expect(Object.keys(map)).toEqual(['codex'])
  })

  it('shares one in-flight check per provider', async () => {
    const { service, checker } = setup()
    await Promise.all([service.check('codex'), service.check('codex')])
    expect(checker.checkCodex).toHaveBeenCalledTimes(1)
  })

  it('ensureFresh returns an ok status younger than the TTL without checking', async () => {
    const { service, checker, advance } = setup()
    await service.check('codex')
    advance(29_000)
    await service.ensureFresh('codex')
    expect(checker.checkCodex).toHaveBeenCalledTimes(1)
  })

  it('ensureFresh re-checks an ok status older than the TTL', async () => {
    const { service, checker, advance } = setup()
    await service.check('codex')
    advance(30_001)
    await service.ensureFresh('codex')
    expect(checker.checkCodex).toHaveBeenCalledTimes(2)
  })

  it('ensureFresh re-checks a status that is not ok, even when fresh', async () => {
    const { service, checker } = setup('missing')
    await service.check('codex')
    const next = await service.ensureFresh('codex')
    expect(checker.checkCodex).toHaveBeenCalledTimes(2)
    expect(next.state).toBe('missing')
  })

  it('ensureFresh checks when nothing is cached', async () => {
    const { service, checker } = setup()
    await service.ensureFresh('claude')
    expect(checker.checkClaude).toHaveBeenCalledTimes(1)
  })

  it('markSignedOut keeps the version, sets the login command and publishes', async () => {
    const { service, publish } = setup()
    await service.check('claude')
    publish.mockClear()
    service.markSignedOut('claude')
    expect(service.getStatus('claude')).toMatchObject({
      state: 'signed_out',
      version: '2.1.302',
      loginCommand: 'claude'
    })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('a throwing check keeps the previous status and logs', async () => {
    const { service, checker } = setup()
    await service.check('codex')
    checker.checkCodex.mockRejectedValueOnce(new Error('boom'))
    const next = await service.check('codex').then(() => service.getStatus('codex'))
    expect(next?.state).toBe('ok')
  })
})
