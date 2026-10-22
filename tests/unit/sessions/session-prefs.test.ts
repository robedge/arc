import { describe, expect, it } from 'vitest'
import { effectiveBrain } from '../../../src/main/sessions/session-prefs'
import type {
  ModelRef,
  ProviderId,
  ProviderState,
  ProviderStatusMap
} from '../../../src/shared/types/provider'

function status(states: Partial<Record<ProviderId, ProviderState>>): ProviderStatusMap {
  const map: ProviderStatusMap = {}
  for (const [provider, state] of Object.entries(states) as [ProviderId, ProviderState][]) {
    map[provider] = { provider, state, message: '', checkedAt: 1 }
  }
  return map
}

const defaultFor = (provider: ProviderId): ModelRef | undefined =>
  provider === 'codex' ? { provider, model: 'gpt-deep' } : undefined

const cursorBrain = { brainProvider: 'cursor', brainModel: 'default[]' } as const

describe('effectiveBrain: the fallback chain', () => {
  it('a Cursor brain that is ok runs on Cursor', () => {
    expect(effectiveBrain(cursorBrain, status({ cursor: 'ok' }))).toEqual({
      provider: 'cursor',
      model: 'default[]'
    })
  })

  it.each(['missing', 'signed_out', 'unsupported', 'error'] as const)(
    'Cursor %s: Claude Sonnet stands in and the request is remembered',
    (state) => {
      expect(effectiveBrain(cursorBrain, status({ cursor: state }))).toEqual({
        provider: 'claude',
        model: 'sonnet',
        unavailable: state,
        requested: 'cursor'
      })
    }
  )

  it('Cursor with no status yet counts as unknown', () => {
    expect(effectiveBrain(cursorBrain, {})).toMatchObject({
      provider: 'claude',
      unavailable: 'unknown',
      requested: 'cursor'
    })
  })

  it('Cursor at its limit while ok falls back with the limit reason', () => {
    expect(
      effectiveBrain(cursorBrain, status({ cursor: 'ok' }), undefined, {
        limited: new Set(['cursor'])
      })
    ).toEqual({ provider: 'claude', model: 'sonnet', unavailable: 'limit', requested: 'cursor' })
  })

  it('a handshake refusal forces the fallback although the status says ok', () => {
    expect(effectiveBrain(cursorBrain, status({ cursor: 'ok' }), 'signed_out')).toMatchObject({
      provider: 'claude',
      unavailable: 'signed_out',
      requested: 'cursor'
    })
  })

  it('Claude also unavailable: Codex stands in with its default', () => {
    expect(
      effectiveBrain(
        cursorBrain,
        status({ cursor: 'missing', claude: 'error', codex: 'ok' }),
        undefined,
        {
          defaultFor
        }
      )
    ).toEqual({ provider: 'codex', model: 'gpt-deep', unavailable: 'missing', requested: 'cursor' })
  })

  it('Codex is skipped while it is at its limit or when nobody can name its model', () => {
    const down = status({ cursor: 'missing', claude: 'error', codex: 'ok' })
    expect(
      effectiveBrain(cursorBrain, down, undefined, { defaultFor, limited: new Set(['codex']) })
    ).toMatchObject({ provider: 'claude', model: 'sonnet' })
    expect(effectiveBrain(cursorBrain, down)).toMatchObject({ provider: 'claude', model: 'sonnet' })
  })

  it('a Codex brain stands in on Claude, as before', () => {
    expect(
      effectiveBrain(
        { brainProvider: 'codex', brainModel: 'gpt-deep' },
        status({ codex: 'signed_out' })
      )
    ).toEqual({
      provider: 'claude',
      model: 'sonnet',
      unavailable: 'signed_out',
      requested: 'codex'
    })
  })

  it('a Claude brain is never checked', () => {
    expect(effectiveBrain({ brainProvider: 'claude', brainModel: 'opus' }, {})).toEqual({
      provider: 'claude',
      model: 'opus'
    })
  })
})
