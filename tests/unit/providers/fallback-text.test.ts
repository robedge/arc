import { describe, expect, it } from 'vitest'
import type { FallbackReason } from '../../../src/main/models/provider-resolution'
import {
  brainFallbackText,
  commandNeedsProviderText,
  fallbackReasonText,
  workerCannotContinueText,
  workerFallbackText
} from '../../../src/main/providers/fallback-text'

describe('the fallback texts', () => {
  it('worker lines, one per reason', () => {
    expect(workerFallbackText('W2', 'signed_out')).toBe(
      "Codex isn't signed in, so W2 runs on Claude. Run codex login in Terminal to use Codex."
    )
    expect(workerFallbackText('W2', 'missing')).toBe(
      "Codex isn't installed, so W2 runs on Claude. Install Codex to use it."
    )
    expect(workerFallbackText('W2', 'unsupported')).toBe(
      'This Codex is too old for Arc, so W2 runs on Claude. Update Codex to use it.'
    )
    expect(workerFallbackText('W2', 'error')).toBe(
      "Arc couldn't check Codex, so W2 runs on Claude."
    )
  })

  it('brain lines, one per reason', () => {
    expect(brainFallbackText('signed_out')).toBe(
      "Codex isn't signed in, so the brain replies from Claude · Sonnet. Run codex login in Terminal to use Codex."
    )
    expect(brainFallbackText('missing')).toBe(
      "Codex isn't installed, so the brain replies from Claude · Sonnet. Install Codex to use it."
    )
    expect(brainFallbackText('unsupported')).toBe(
      'This Codex is too old for Arc, so the brain replies from Claude · Sonnet. Update Codex to use it.'
    )
    expect(brainFallbackText('error')).toBe(
      "Arc couldn't check Codex, so the brain replies from Claude · Sonnet."
    )
  })

  it('the card sentence is the line without the subject', () => {
    expect(fallbackReasonText('signed_out')).toBe(
      "Codex isn't signed in. Run codex login in Terminal to use Codex."
    )
    expect(fallbackReasonText('error')).toBe("Arc couldn't check Codex.")
  })

  it('a stopped Codex worker waits for Codex instead of moving', () => {
    expect(workerCannotContinueText('W2', 'signed_out')).toBe(
      "Codex isn't signed in, so W2 can't continue. Run codex login in Terminal, then continue W2."
    )
    const reasons: FallbackReason[] = ['missing', 'unsupported', 'error']
    for (const reason of reasons) {
      expect(workerCannotContinueText('W2', reason)).toMatch(/so W2 can't continue\. .* W2\.$/)
    }
  })

  it('a Codex command names the command, then gives the reason', () => {
    expect(commandNeedsProviderText('W2', '/review', 'signed_out')).toBe(
      "W2 needs Codex for /review. Codex isn't signed in. Run codex login in Terminal to use Codex."
    )
  })

  it('Cursor lines take the name and login from the provider traits', () => {
    expect(workerFallbackText('W2', 'signed_out', 'cursor')).toBe(
      "Cursor isn't signed in, so W2 runs on Claude. Run agent login in Terminal to use Cursor."
    )
    expect(workerFallbackText('W2', 'missing', 'cursor')).toBe(
      "Cursor isn't installed, so W2 runs on Claude. Install Cursor to use it."
    )
    expect(workerFallbackText('W2', 'unsupported', 'cursor')).toBe(
      'This Cursor is too old for Arc, so W2 runs on Claude. Update Cursor to use it.'
    )
    expect(workerFallbackText('W2', 'error', 'cursor')).toBe(
      "Arc couldn't check Cursor, so W2 runs on Claude."
    )
    expect(workerFallbackText('W2', 'limit', 'cursor')).toBe(
      'Cursor has reached its usage limit, so W2 runs on Claude.'
    )
    expect(workerFallbackText('W2', 'signed_out', 'cursor', 'codex')).toBe(
      "Cursor isn't signed in, so W2 runs on Codex. Run agent login in Terminal to use Cursor."
    )
  })

  it('Cursor card sentence, brain, wait and command lines', () => {
    expect(fallbackReasonText('signed_out', 'cursor')).toBe(
      "Cursor isn't signed in. Run agent login in Terminal to use Cursor."
    )
    expect(brainFallbackText('signed_out', 'cursor')).toBe(
      "Cursor isn't signed in, so the brain replies from Claude · Sonnet. Run agent login in Terminal to use Cursor."
    )
    expect(brainFallbackText('limit', 'cursor', { provider: 'codex', model: 'gpt-deep' })).toMatch(
      /^Cursor has reached its usage limit, so the brain replies from Codex · /
    )
    expect(workerCannotContinueText('W2', 'signed_out', 'cursor')).toBe(
      "Cursor isn't signed in, so W2 can't continue. Run agent login in Terminal, then continue W2."
    )
    expect(commandNeedsProviderText('W2', '/review', 'missing', 'cursor')).toBe(
      "W2 needs Cursor for /review. Cursor isn't installed. Install Cursor to use it."
    )
  })

  it('the Codex limit lines are still named for Codex', () => {
    expect(workerFallbackText('W3', 'limit')).toBe(
      'Codex has reached its usage limit, so W3 runs on Claude.'
    )
  })
})
