/** The Claude model aliases the CLI accepts. Full ids come from the CLI's `init` event. */
export const MODEL_ALIASES: readonly string[] = ['opus', 'sonnet', 'haiku']
export const DEFAULT_WORKER_MODEL = 'sonnet'

/** Aliases in lower case; a full model id is kept as given. */
export function normalizeModel(value: string): string {
  const trimmed = value.trim()
  return MODEL_ALIASES.includes(trimmed.toLowerCase()) ? trimmed.toLowerCase() : trimmed
}
