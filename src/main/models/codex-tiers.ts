import type { ModelTier } from '@shared/types/provider'

/**
 * Codex's `model/list` has no tier field (spike S11), so the tier comes from the model's name. It is
 * used only to choose the Claude model that stands in for an unavailable Codex one, so a wrong
 * guess costs a slightly bigger or smaller model, never a failure. Names are not stable: fix a
 * wrong guess here, by exact model id, instead of changing the rule below.
 */
export const CODEX_TIER_OVERRIDES: Readonly<Record<string, ModelTier>> = {
  // "Older balanced model" in the account's own description (spike S11); the name carries no hint.
  'gpt-5.6-terra': 'balanced'
}

/** A model whose name has one of these as a whole word (`gpt-6-luna`, `codex-mini`) is a fast one. */
const FAST_WORDS: ReadonlySet<string> = new Set(['mini', 'nano', 'spark', 'luna', 'fast'])

/** The fields of a Codex `model/list` entry that decide the tier. */
export interface TierInput {
  model: string
  isDefault?: boolean
}

/**
 * The override for the exact id, else `fast` for a fast name, else `balanced` for the provider's
 * default, else `deep`.
 */
export function codexTier(input: TierInput): ModelTier {
  const override = CODEX_TIER_OVERRIDES[input.model]
  if (override !== undefined) return override
  const words = input.model.toLowerCase().split(/[^a-z0-9]+/)
  if (words.some((w) => FAST_WORDS.has(w))) return 'fast'
  return input.isDefault === true ? 'balanced' : 'deep'
}
