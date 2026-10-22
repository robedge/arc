import { isProviderId } from './provider-label'
import type { ProviderId } from './types/provider'
import type { TokenTotals } from './types/usage'

/** What one token of each bucket counts as, relative to a normal input token. */
export interface UsageWeights {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/**
 * The API price ratios. Neither Anthropic nor OpenAI publishes how plan limits weight tokens, so these
 * stand in for it: Claude charges 1.25x to write the cache, 0.1x to read it and 5x for output; OpenAI
 * has no write premium, reads cached input at 0.1x and charges 8x for output.
 */
export const USAGE_WEIGHTS: Readonly<Record<ProviderId, UsageWeights>> = {
  claude: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  codex: { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 8 },
  // Assumption: Cursor passes the underlying model's pricing through, so it carries Claude's ratios.
  cursor: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }
}

export const WEIGHTED_EXPLANATION =
  "Weighted by cost relative to normal input: Claude cache read x0.1, cache write x1.25, output x5; Codex cached input x0.1, output x8; Cursor, where it reports tokens, at Claude's ratios. Not a dollar amount."

/** One provider's tokens at its own ratios; a provider without ratios of its own uses Claude's. */
export function weightedTokens(provider: string, t: TokenTotals): number {
  const w = isProviderId(provider) ? USAGE_WEIGHTS[provider] : USAGE_WEIGHTS.claude
  return (
    t.input * w.input +
    t.cacheWrite * w.cacheWrite +
    t.cacheRead * w.cacheRead +
    t.output * w.output
  )
}

/** Each provider weighted with its own ratios, then summed. */
export function weightedTotal(
  byProvider: Readonly<Record<string, TokenTotals | undefined>>
): number {
  return Object.entries(byProvider).reduce(
    (sum, [provider, t]) => (t === undefined ? sum : sum + weightedTokens(provider, t)),
    0
  )
}

/** Tokens the provider had to process fresh: input, cache write and output. */
export function newTokens(t: TokenTotals): number {
  return t.input + t.cacheWrite + t.output
}

/** Cache read as a share of the total (0 to 1); null when nothing was used. */
export function cacheShare(t: TokenTotals): number | null {
  return t.total > 0 ? t.cacheRead / t.total : null
}
