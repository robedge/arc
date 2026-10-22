/** The terminal line a typed `/name` gets on a Codex worker that has no such skill (tech spec 2.7). */
export const CODEX_SLASH_LINE = 'Slash commands run in a new worker for Codex'

/** The `/name` a typed line starts with, or null. A path such as `/usr/bin` is not a command. */
export function typedSlashName(text: string): string | null {
  const match = /^\/([\w:.-]+)(?:\s|$)/.exec(text.trimStart())
  return match?.[1] ?? null
}

/** What the brain's messages start with when they reach a worker; step-in recognises the ones it must hold. */
export const BRAIN_MESSAGE_PREFIX = '[Arc] Message from the brain: '
