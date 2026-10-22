import { describe, expect, it } from 'vitest'
import { brainRunningOn } from '../../../src/main/sessions/running-on'
import type { ProviderState, ProviderStatusMap } from '../../../src/shared/types/provider'

const status = (state: ProviderState): ProviderStatusMap => ({
  codex: { provider: 'codex', state, message: '', checkedAt: 1 }
})
const codexBrain = { brainProvider: 'codex', brainModel: 'gpt-deep' } as const

describe('brainRunningOn', () => {
  it('a Claude brain is what is stored, whatever Codex does', () => {
    expect(
      brainRunningOn({ brainProvider: 'claude', brainModel: 'opus' }, status('signed_out'))
    ).toEqual({ provider: 'claude', model: 'opus' })
  })

  it('a Codex brain with Codex ok is what is stored', () => {
    expect(brainRunningOn(codexBrain, status('ok'))).toEqual({
      provider: 'codex',
      model: 'gpt-deep'
    })
  })

  it.each([
    ['signed_out', "Codex isn't signed in. Run codex login in Terminal to use Codex."],
    ['missing', "Codex isn't installed. Install Codex to use it."],
    ['unsupported', 'This Codex is too old for Arc. Update Codex to use it.'],
    ['error', "Arc couldn't check Codex."]
  ] as const)(
    'a Codex brain with Codex %s replies from Claude · Sonnet and says why',
    (state, sentence) => {
      expect(brainRunningOn(codexBrain, status(state))).toEqual({
        provider: 'claude',
        model: 'sonnet',
        requestedProvider: 'codex',
        fallbackReason: sentence
      })
    }
  )

  it('a Codex that no check has reported on counts as not ready', () => {
    expect(brainRunningOn(codexBrain, {})).toMatchObject({
      provider: 'claude',
      requestedProvider: 'codex',
      fallbackReason: "Arc couldn't check Codex."
    })
  })
})
