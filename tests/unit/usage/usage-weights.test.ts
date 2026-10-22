import { describe, expect, it } from 'vitest'
import {
  USAGE_WEIGHTS,
  WEIGHTED_EXPLANATION,
  cacheShare,
  newTokens,
  weightedTotal
} from '../../../src/shared/usage-weights'
import type { TokenTotals } from '../../../src/shared/types/usage'

const totals = (
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number
): TokenTotals => ({
  input,
  cacheWrite,
  cacheRead,
  output,
  total: input + cacheWrite + cacheRead + output
})

describe('usage weights', () => {
  it('keeps the ratios relative to normal input, per provider', () => {
    expect(USAGE_WEIGHTS.claude).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 })
    expect(USAGE_WEIGHTS.codex).toEqual({ input: 1, cacheWrite: 1, cacheRead: 0.1, output: 8 })
    // Assumption: Cursor passes the underlying model's pricing through.
    expect(USAGE_WEIGHTS.cursor).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 })
  })

  it('weights each provider with its own ratios and adds them up', () => {
    // Claude: 1000 + 800*1.25 + 10000*0.1 + 100*5 = 3500. Codex: 2000 + 500*1 + 20000*0.1 + 100*8 = 5300.
    const weighted = weightedTotal({
      claude: totals(1000, 800, 10_000, 100),
      codex: totals(2000, 500, 20_000, 100)
    })
    expect(weighted).toBeCloseTo(8800, 6)
  })

  it('is zero for nothing, and an unknown provider falls back on the Claude ratios', () => {
    expect(weightedTotal({})).toBe(0)
    expect(weightedTotal({ other: totals(0, 0, 0, 10) })).toBe(50)
  })

  it('explains itself in plain words and says it is not a dollar amount', () => {
    expect(WEIGHTED_EXPLANATION).toBe(
      "Weighted by cost relative to normal input: Claude cache read x0.1, cache write x1.25, output x5; Codex cached input x0.1, output x8; Cursor, where it reports tokens, at Claude's ratios. Not a dollar amount."
    )
  })
})

describe('new versus from cache', () => {
  it('new is input plus cache write plus output', () => {
    expect(newTokens(totals(100, 50, 900, 25))).toBe(175)
  })

  it('the cache share is cache read over the total, null for nothing', () => {
    expect(cacheShare(totals(100, 0, 900, 0))).toBe(0.9)
    expect(cacheShare(totals(0, 0, 0, 0))).toBeNull()
  })
})
