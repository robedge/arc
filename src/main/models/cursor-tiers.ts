import type { ModelTier } from '@shared/types/provider'

/**
 * Cursor's model list has no tier field, so the tier comes from the model's name. It is used only to
 * choose the Claude model that stands in for an unavailable Cursor one, so a wrong guess costs a
 * slightly bigger or smaller model, never a failure. Names are not stable: fix a wrong guess here,
 * by exact base name, instead of changing the rules below.
 */
export const CURSOR_TIER_OVERRIDES: Readonly<Record<string, ModelTier>> = {}

/** A model whose name has one of these as a whole word (`gpt-5.4-mini`, `gemini-3-flash`) is a fast one. */
const FAST_WORDS: ReadonlySet<string> = new Set([
  'mini',
  'nano',
  'flash',
  'haiku',
  'spark',
  'luna',
  'lite'
])

/** A model whose name has one of these as a whole word (`claude-opus-5`, `gemini-3.1-pro`) is a deep one. */
const DEEP_WORDS: ReadonlySet<string> = new Set(['opus', 'pro', 'max'])

/** The fields of a Cursor model that decide the tier. */
export interface CursorTierInput {
  /** The ACP model id (`grok-4.7[context=256k]`) or the bare name. */
  model: string
  /** The name without parameters, when known. */
  base?: string | undefined
  isDefault?: boolean | undefined
}

/**
 * Auto (the default entry) is `balanced`. Otherwise the exact-name override, then `fast` or `deep` by
 * a whole word of the name (the bracket parameters are not read: `fast=true` is a speed setting, not
 * a small model), else `balanced`.
 */
export function cursorTier(input: CursorTierInput): ModelTier {
  const name = (input.base ?? input.model.split('[')[0] ?? input.model).trim()
  if (input.isDefault === true || name === 'default' || name.toLowerCase() === 'auto') {
    return 'balanced'
  }
  const override = CURSOR_TIER_OVERRIDES[name]
  if (override !== undefined) return override
  const words = name.toLowerCase().split(/[^a-z0-9]+/)
  if (words.some((w) => FAST_WORDS.has(w))) return 'fast'
  if (words.some((w) => DEEP_WORDS.has(w))) return 'deep'
  return 'balanced'
}
