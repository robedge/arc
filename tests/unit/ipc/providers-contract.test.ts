import { describe, expect, it } from 'vitest'
import { channelNames, channelSchemas, eventNames } from '../../../src/shared/ipc/contract'

describe('provider IPC contract', () => {
  it('replaces cli:* with providers:*', () => {
    const channels: readonly string[] = channelNames
    expect(channels).toContain('providers:get')
    expect(channels).toContain('providers:check')
    expect(channels).not.toContain('cli:retry-check')
    expect(eventNames).toContain('providers:changed')
    expect(eventNames as readonly string[]).not.toContain('cli:status')
  })

  it('has providers:bypass, which takes nothing', () => {
    const channels: readonly string[] = channelNames
    expect(channels).toContain('providers:bypass')
    expect(channelSchemas['providers:bypass'].safeParse({}).success).toBe(true)
    expect(channelSchemas['providers:bypass'].safeParse({ repo: 'x' }).success).toBe(false)
  })

  it('providers:get takes nothing', () => {
    expect(channelSchemas['providers:get'].safeParse({}).success).toBe(true)
    expect(channelSchemas['providers:get'].safeParse({ provider: 'codex' }).success).toBe(false)
  })

  it('providers:check takes an optional known provider', () => {
    const schema = channelSchemas['providers:check']
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ provider: 'codex' }).success).toBe(true)
    expect(schema.safeParse({ provider: 'claude' }).success).toBe(true)
    expect(schema.safeParse({ provider: 'gemini' }).success).toBe(false)
    expect(schema.safeParse({ extra: 1 }).success).toBe(false)
  })

  it('has the model list, the Settings defaults and their change push', () => {
    const channels: readonly string[] = channelNames
    expect(channels).toEqual(
      expect.arrayContaining(['providers:models', 'settings:get', 'settings:set'])
    )
    expect(eventNames).toContain('settings:changed')
    expect(channelSchemas['providers:models'].safeParse({}).success).toBe(true)
    expect(channelSchemas['settings:get'].safeParse({ x: 1 }).success).toBe(false)
  })

  it('settings:set takes any subset of the two keys and validates their values', () => {
    const schema = channelSchemas['settings:set']
    expect(schema.safeParse({}).success).toBe(true)
    expect(
      schema.safeParse({ 'providers.brain': { provider: 'codex', model: 'gpt-6-sol' } }).success
    ).toBe(true)
    for (const workers of [
      { mode: 'auto' },
      { mode: 'provider', provider: 'codex' },
      { mode: 'model', model: { provider: 'claude', model: 'opus' } }
    ]) {
      expect(schema.safeParse({ 'providers.workers': workers }).success).toBe(true)
    }
    expect(schema.safeParse({ 'providers.workers': { mode: 'provider' } }).success).toBe(false)
    expect(
      schema.safeParse({ 'providers.workers': { mode: 'provider', provider: 'gemini' } }).success
    ).toBe(false)
    expect(schema.safeParse({ 'providers.brain': 'sonnet' }).success).toBe(false)
    expect(schema.safeParse({ 'providers.other': 1 }).success).toBe(false)
  })

  it('sessions:set-config takes brainModel as a ModelRef and workers as a WorkersPref', () => {
    const schema = channelSchemas['sessions:set-config']
    expect(
      schema.safeParse({
        sessionId: 's',
        brainModel: { provider: 'claude', model: 'opus' },
        workers: { mode: 'provider', provider: 'codex' }
      }).success
    ).toBe(true)
    expect(schema.safeParse({ sessionId: 's', brainModel: 'opus' }).success).toBe(false)
    expect(schema.safeParse({ sessionId: 's', model: 'haiku' }).success).toBe(false)
    expect(schema.safeParse({ sessionId: 's', workers: { mode: 'auto', extra: 1 } }).success).toBe(
      false
    )
  })
})
