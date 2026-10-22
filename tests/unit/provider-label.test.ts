import { describe, expect, it } from 'vitest'
import {
  hasFallback,
  modelLabel,
  providerName,
  runningOnLabel
} from '../../src/shared/provider-label'

describe('modelLabel', () => {
  it('capitalises a Claude alias', () => {
    expect(modelLabel({ provider: 'claude', model: 'sonnet' })).toBe('Claude · Sonnet')
    expect(modelLabel({ provider: 'claude', model: 'opus' })).toBe('Claude · Opus')
    expect(modelLabel({ provider: 'claude', model: 'haiku' })).toBe('Claude · Haiku')
  })

  it('shows a Claude full model id as it is', () => {
    expect(modelLabel({ provider: 'claude', model: 'claude-sonnet-4-5' })).toBe(
      'Claude · claude-sonnet-4-5'
    )
  })

  it('shows a Codex id as it is, even when it looks like a Claude alias', () => {
    expect(modelLabel({ provider: 'codex', model: 'gpt-5.5' })).toBe('Codex · gpt-5.5')
    expect(modelLabel({ provider: 'codex', model: 'sonnet' })).toBe('Codex · sonnet')
  })
})

describe('runningOnLabel', () => {
  it('is the model label without a fallback', () => {
    expect(runningOnLabel({ provider: 'codex', model: 'gpt-5.5' })).toBe('Codex · gpt-5.5')
    expect(runningOnLabel({ provider: 'claude', model: 'sonnet' })).toBe('Claude · Sonnet')
  })

  it('names the unavailable provider after a fallback', () => {
    expect(
      runningOnLabel({
        provider: 'claude',
        model: 'sonnet',
        requestedProvider: 'codex',
        fallbackReason: 'signed_out'
      })
    ).toBe('Claude (Codex unavailable)')
  })

  it('needs both the requested provider and a reason to count as a fallback', () => {
    const noReason = { provider: 'claude', model: 'sonnet', requestedProvider: 'codex' } as const
    expect(hasFallback(noReason)).toBe(false)
    expect(runningOnLabel(noReason)).toBe('Claude · Sonnet')
    const same = {
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'claude',
      fallbackReason: 'x'
    } as const
    expect(hasFallback(same)).toBe(false)
  })
})

describe('providerName', () => {
  it('capitalises the provider id', () => {
    expect(providerName('claude')).toBe('Claude')
    expect(providerName('codex')).toBe('Codex')
  })
})
