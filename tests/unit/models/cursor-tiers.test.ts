import { describe, expect, it } from 'vitest'
import { cursorTier } from '../../../src/main/models/cursor-tiers'

describe('cursorTier', () => {
  it.each([
    ['default[]', 'balanced'],
    ['claude-opus-5[thinking=true,context=300k,effort=high,fast=false]', 'deep'],
    ['gemini-3.1-pro[]', 'deep'],
    ['claude-haiku-5-5[thinking=true]', 'fast'],
    ['gpt-5.4-mini[reasoning=medium]', 'fast'],
    ['gpt-5.4-nano[reasoning=medium]', 'fast'],
    ['gemini-3.8-flash[reasoning_effort=high]', 'fast'],
    ['gpt-5.6-luna[context=272k]', 'fast'],
    ['claude-sonnet-5[thinking=true]', 'balanced'],
    ['composer-2.5[fast=true]', 'balanced'],
    ['grok-4.7[context=256k,reasoning_effort=high,fast=true]', 'balanced'],
    ['gpt-5.3-codex[reasoning=medium,fast=false]', 'balanced']
  ])('%s is %s', (model, tier) => {
    expect(cursorTier({ model })).toBe(tier)
  })

  it('does not read the bracket parameters: fast=true is a speed setting, not a small model', () => {
    expect(cursorTier({ model: 'grok-4.7[fast=true]' })).toBe('balanced')
  })

  it('counts the default entry as balanced whatever its name', () => {
    expect(cursorTier({ model: 'x-mini[]', isDefault: true })).toBe('balanced')
  })

  it('uses the base name when it is given', () => {
    expect(cursorTier({ model: 'weird-id', base: 'claude-opus-4-8' })).toBe('deep')
  })
})
