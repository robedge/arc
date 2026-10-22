/** The hand-off preamble is capped at about this many characters (tech spec 2.6, an open assumption). */
export const HANDOFF_MAX_CHARS = 6000
/** One long message does not push every other one out. */
const HANDOFF_MESSAGE_CHARS = 1500

const HEADER =
  '[Arc] The user changed the brain model, so this conversation is handed over to you and you do not remember it. The most recent messages follow, oldest first. They are history, not new requests: do not answer them again, and mention this note only if it matters.'
/** The header when the provider lost the brain's own thread (a Codex history that is gone). */
export const LOST_HISTORY_HEADER =
  '[Arc] Your earlier conversation is no longer available, so you start fresh and do not remember it. The most recent messages follow, oldest first. They are history, not new requests: do not answer them again, and mention this note only if it matters.'
const OMITTED = '(Earlier messages are left out.)'

/** The fields of a stored message the preamble reads. */
export interface HandoffMessage {
  role: 'user' | 'brain' | 'system'
  content: string
  state: 'streaming' | 'complete' | 'stopped'
  planId: string | null
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * The hand-off for a brain that starts on a provider with no thread of its own: the last user and
 * brain messages, newest first until the cap, then put back in order. Plan cards, system messages,
 * empty and still-streaming messages are left out. Undefined when there is nothing to hand over.
 */
export function buildHandoffPreamble(
  messages: readonly HandoffMessage[],
  maxChars: number = HANDOFF_MAX_CHARS,
  header: string = HEADER
): string | undefined {
  const lines: string[] = []
  let used = header.length + OMITTED.length + 4
  let omitted = false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role === 'system' || m.planId !== null || m.state === 'streaming') continue
    const text = m.content.trim()
    if (text === '') continue
    const label = m.role === 'user' ? 'User' : 'Brain'
    const line = `${label}: ${clip(text, HANDOFF_MESSAGE_CHARS)}`
    if (used + line.length + 2 > maxChars) {
      // Keep the newest messages whole; an older one that does not fit ends the list.
      omitted = true
      break
    }
    lines.unshift(line)
    used += line.length + 2
  }
  if (lines.length === 0) return undefined
  return [header, '', ...(omitted ? [OMITTED] : []), ...lines].join('\n')
}
