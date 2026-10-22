import { describe, expect, it, vi } from 'vitest'
import { bridgeToolNamer } from '../../../src/main/agents/tool-namer'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { resolveWorkerTarget } from '../../../src/main/models/provider-resolution'
import { ProviderStatusService } from '../../../src/main/providers/provider-status-service'
import { updateCommandFor } from '../../../src/main/providers/provider-versions'
import { unavailableReason } from '../../../src/main/sessions/brain-providers'
import { splitCommandRef } from '../../../src/main/sessions/command-routing'
import { parsePlanWorkers } from '../../../src/main/sessions/plan-coordinator'
import { effectiveBrain } from '../../../src/main/sessions/session-prefs'
import {
  isProviderId,
  modelLabel,
  providerIds,
  providerName
} from '../../../src/shared/provider-label'
import { PROVIDER_TRAITS } from '../../../src/shared/provider-traits'
import {
  MIN_CURSOR_VERSION,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderStatus
} from '../../../src/shared/types/provider'
import { USAGE_WEIGHTS, weightedTokens } from '../../../src/shared/usage-weights'

/** Spec 010: the provider helpers behave for every id in PROVIDER_IDS, so a fourth provider cannot be forgotten. */

const tokens = { input: 1000, cacheWrite: 100, cacheRead: 10_000, output: 500, total: 11_600 }

const missing = (provider: ProviderId): ProviderStatus => ({
  provider,
  state: 'missing',
  message: '',
  checkedAt: 1
})

describe('provider list', () => {
  it('names Claude, Codex and Cursor in display order', () => {
    expect([...PROVIDER_IDS]).toEqual(['claude', 'codex', 'cursor'])
    expect([...providerIds]).toEqual([...PROVIDER_IDS])
    expect(MIN_CURSOR_VERSION).toBe('2026.07.06')
  })

  it('accepts only provider ids', () => {
    expect(isProviderId('cursor')).toBe(true)
    expect(isProviderId('gemini')).toBe(false)
    expect(isProviderId(undefined)).toBe(false)
  })
})

describe.each(PROVIDER_IDS.map((id) => [id]))('provider %s', (id) => {
  it('has complete traits', () => {
    const traits = PROVIDER_TRAITS[id]
    expect(traits.name.length).toBeGreaterThan(0)
    expect(traits.cliName.length).toBeGreaterThan(0)
    expect(traits.loginCommand.length).toBeGreaterThan(0)
    expect(traits.installHint.length).toBeGreaterThan(0)
    expect(typeof traits.hasNativeSystemPrompt).toBe('boolean')
    expect(typeof traits.liveModelSwitch).toBe('boolean')
    expect(['event', 'push', 'probe']).toContain(traits.planSource)
    expect(providerName(id)).toBe(traits.name)
    expect(modelLabel({ provider: id, model: 'm' })).toBe(`${traits.name} · m`)
  })

  it('has its own fallback position, with Claude first', () => {
    const order = PROVIDER_IDS.map((p) => PROVIDER_TRAITS[p].fallbackOrder)
    expect(new Set(order).size).toBe(PROVIDER_IDS.length)
    expect(PROVIDER_TRAITS.claude.fallbackOrder).toBe(Math.min(...order))
  })

  it('weights tokens by its own ratios', () => {
    const w = USAGE_WEIGHTS[id]
    const expected =
      tokens.input * w.input +
      tokens.cacheWrite * w.cacheWrite +
      tokens.cacheRead * w.cacheRead +
      tokens.output * w.output
    expect(weightedTokens(id, tokens)).toBe(expected)
  })

  it('has an update command and a bridge tool namer', () => {
    expect(updateCommandFor(id, undefined)).toMatch(/update$/)
    expect(bridgeToolNamer(id).name('spawn_worker')).toContain('spawn_worker')
  })

  it('reads a stored plan worker of its own', () => {
    const [worker] = parsePlanWorkers(JSON.stringify([{ name: 'w', provider: id }]))
    expect(worker?.provider).toBe(id)
  })

  it('is a command id prefix', () => {
    expect(splitCommandRef(`${id}:review`)?.ref).toBe(`${id}:review`)
  })

  it('is unavailable to the brain until a check says ok (Claude always is)', () => {
    const reason = unavailableReason(id, {})
    if (id === 'claude') expect(reason).toBeUndefined()
    else expect(reason).toBe(`${providerName(id)} hasn't been checked yet`)
  })

  it('does not run the brain when it is not ready', () => {
    const brain = effectiveBrain({ brainProvider: id, brainModel: 'm' }, {})
    expect(brain.provider).toBe('claude')
    if (id === 'claude') expect(brain.model).toBe('m')
    else expect(brain.unavailable).toBe('unknown')
  })

  it('stands in a Claude worker when it is not ready, naming itself in the note', () => {
    const registry = new ModelRegistry({
      codex: { listModels: () => Promise.resolve([]) },
      status: () => ({})
    })
    const target = resolveWorkerTarget({
      sessionPref: { mode: 'provider', provider: id },
      registry,
      status: {}
    })
    if (id === 'claude') {
      expect(target.ref.provider).toBe('claude')
      expect(target.fallback).toBeUndefined()
      return
    }
    expect(target.ref.provider).toBe('claude')
    expect(target.fallback?.from.provider).toBe(id)
    expect(target.notes.join(' ')).toContain(`${providerName(id)} `)
  })

  it('lists models for the pickers, none for a provider that is not ready', () => {
    const registry = new ModelRegistry({
      codex: { listModels: () => Promise.resolve([]) },
      status: () => ({})
    })
    expect(Array.isArray(registry.all()[id])).toBe(true)
    if (id !== 'claude') expect(registry.list(id)).toEqual([])
  })

  it('is checked by the status service (its Cursor checker reports it missing here)', async () => {
    const checkClaude = vi.fn(() => Promise.resolve({ ...missing('claude'), state: 'ok' as const }))
    const checkCodex = vi.fn(() => Promise.resolve({ ...missing('codex'), state: 'ok' as const }))
    const checkCursor = vi.fn(() => Promise.resolve(missing('cursor')))
    const service = new ProviderStatusService({
      checker: { checkClaude, checkCodex, checkCursor, resetPath: vi.fn() },
      publish: vi.fn(),
      now: () => 5
    })
    const map = await service.check(id)
    expect(map[id]?.provider).toBe(id)
    if (id === 'cursor') {
      expect(map[id]?.state).toBe('missing')
    } else {
      expect(map[id]?.state).toBe('ok')
    }
  })
})
