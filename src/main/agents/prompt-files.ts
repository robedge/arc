/**
 * Saved prompt files (`*.md` with optional `---` front matter) as Codex prompts and Cursor commands
 * use them: parsing the front matter, splitting arguments and expanding the placeholders.
 */

export interface PromptFile {
  /** The file name without `.md`: the name after the slash. */
  name: string
  description: string
  argumentHint?: string
  body: string
}

function unquote(value: string): string {
  const v = value.trim()
  const quote = v[0]
  return v.length >= 2 && (quote === '"' || quote === "'") && v.endsWith(quote) ? v.slice(1, -1) : v
}

/** Splits optional `---` front matter off a prompt file; reads its `description` and `argument-hint`. */
export function parsePromptFile(name: string, text: string): PromptFile {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  let description = ''
  let argumentHint: string | undefined
  let body = normalized
  if (match) {
    body = normalized.slice(match[0].length)
    for (const line of (match[1] ?? '').split('\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const key = line.slice(0, colon).trim()
      const value = unquote(line.slice(colon + 1))
      if (key === 'description') description = value
      else if (key === 'argument-hint' && value !== '') argumentHint = value
    }
  }
  return { name, description, ...(argumentHint !== undefined ? { argumentHint } : {}), body }
}

/** Splits an argument string on whitespace; single or double quotes keep words together. */
export function splitArgs(argString: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of argString) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current !== '') tokens.push(current)
      current = ''
      started = false
    } else {
      current += ch
    }
  }
  if (started || current !== '') tokens.push(current)
  return tokens
}

export type PromptExpansion = { ok: true; text: string } | { ok: false; missing: string[] }

const NAMED_ARG = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/

/**
 * Expands a prompt body the way Codex does (Cursor commands use the same rules): `$1`..`$9` are the positional arguments (empty when
 * absent), `$ARGUMENTS` is all of them joined by spaces, `$KEY` takes the `KEY=value` argument, and
 * `$$` is a literal `$`. A named placeholder with no value is an error: the caller gets the names
 * that are missing instead of a half-expanded prompt.
 */
export function expandPromptBody(body: string, argString: string): PromptExpansion {
  const positional: string[] = []
  const named = new Map<string, string>()
  for (const token of splitArgs(argString)) {
    const pair = NAMED_ARG.exec(token)
    if (pair?.[1] !== undefined) named.set(pair[1], pair[2] ?? '')
    else positional.push(token)
  }
  const missing: string[] = []
  const text = body.replace(
    /\$(?:(\$)|([1-9])|([A-Z][A-Z0-9_]*))/g,
    (_all, dollar?: string, digit?: string, key?: string) => {
      if (dollar !== undefined) return '$'
      if (digit !== undefined) return positional[Number(digit) - 1] ?? ''
      if (key === 'ARGUMENTS') return positional.join(' ')
      const value = key === undefined ? undefined : named.get(key)
      if (value === undefined) {
        if (key !== undefined && !missing.includes(key)) missing.push(key)
        return ''
      }
      return value
    }
  )
  return missing.length > 0 ? { ok: false, missing } : { ok: true, text }
}
