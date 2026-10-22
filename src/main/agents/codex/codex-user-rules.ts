import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROTECTED_PREFIXES } from './codex-rules'

/**
 * Reads the allow entries of the user's own Codex execpolicy rules (`$CODEX_HOME/rules/*.rules`), to
 * tell Settings which of them can still skip Arc's approvals (tech spec section 5, spike S2). It is
 * read-only. A rule file is Starlark; only `prefix_rule(pattern=[...], decision="...")` calls are
 * read, with a small scanner, and nothing is evaluated or kept beyond the prefixes.
 */

type Word = string | readonly string[]
export type RulePattern = readonly Word[]

export interface RuleEntry {
  pattern: RulePattern
  decision: string
}

/** A reader over `text` that skips comments and strings correctly. */
class Scanner {
  constructor(
    private readonly text: string,
    public at = 0
  ) {}

  get done(): boolean {
    return this.at >= this.text.length
  }

  peek(): string {
    return this.text[this.at] ?? ''
  }

  skipSpace(): void {
    while (!this.done) {
      const c = this.peek()
      if (c === '#') {
        while (!this.done && this.peek() !== '\n') this.at += 1
      } else if (/\s/.test(c)) {
        this.at += 1
      } else {
        return
      }
    }
  }

  /** A quoted string at the cursor, with the usual backslash escapes. */
  string(): string | null {
    const quote = this.peek()
    if (quote !== '"' && quote !== "'") return null
    this.at += 1
    let out = ''
    while (!this.done) {
      const c = this.text[this.at] ?? ''
      this.at += 1
      if (c === quote) return out
      if (c === '\\') {
        const next = this.text[this.at] ?? ''
        this.at += 1
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      } else {
        out += c
      }
    }
    return null
  }

  /** Moves past a string, a comment or one character, tracking nothing else. */
  skipAtom(): void {
    const c = this.peek()
    if (c === '"' || c === "'") {
      this.string()
    } else if (c === '#') {
      while (!this.done && this.peek() !== '\n') this.at += 1
    } else {
      this.at += 1
    }
  }

  /** The text between the parentheses of a call whose `(` is at the cursor; the cursor ends after `)`. */
  balancedBody(): string | null {
    if (this.peek() !== '(') return null
    this.at += 1
    const start = this.at
    let depth = 1
    while (!this.done) {
      const c = this.peek()
      if (c === '"' || c === "'" || c === '#') {
        this.skipAtom()
        continue
      }
      this.at += 1
      if (c === '(' || c === '[' || c === '{') depth += 1
      if (c === ')' || c === ']' || c === '}') {
        depth -= 1
        if (depth === 0) return this.text.slice(start, this.at - 1)
      }
    }
    return null
  }
}

/** A string, or a list of strings and lists, as a rule writes a pattern. Anything else is null. */
function parseValue(scan: Scanner): unknown {
  scan.skipSpace()
  if (scan.peek() === '[') {
    scan.at += 1
    const items: unknown[] = []
    for (;;) {
      scan.skipSpace()
      if (scan.done) return null
      if (scan.peek() === ']') {
        scan.at += 1
        return items
      }
      const item = parseValue(scan)
      if (item === null) return null
      items.push(item)
      scan.skipSpace()
      if (scan.peek() === ',') scan.at += 1
    }
  }
  return scan.string()
}

/** Splits call arguments at the commas outside brackets and strings. */
function splitArguments(body: string): string[] {
  const parts: string[] = []
  const scan = new Scanner(body)
  let depth = 0
  let from = 0
  while (!scan.done) {
    const c = scan.peek()
    if (c === '"' || c === "'" || c === '#') {
      scan.skipAtom()
      continue
    }
    scan.at += 1
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(from, scan.at - 1))
      from = scan.at
    }
  }
  parts.push(body.slice(from))
  return parts
}

function asPattern(value: unknown): RulePattern | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const words: Word[] = []
  for (const item of value as unknown[]) {
    if (typeof item === 'string') {
      words.push(item)
    } else if (Array.isArray(item) && item.every((w): w is string => typeof w === 'string')) {
      words.push(item)
    } else {
      return null
    }
  }
  return words
}

/** Every `prefix_rule(pattern=..., decision=...)` of one rules file. A call that cannot be read is skipped. */
export function parseRulesFile(text: string): RuleEntry[] {
  const out: RuleEntry[] = []
  const scan = new Scanner(text)
  while (!scan.done) {
    scan.skipSpace()
    const start = scan.at
    while (/[A-Za-z0-9_]/.test(scan.peek())) scan.at += 1
    const name = text.slice(start, scan.at)
    if (name === '') {
      scan.skipAtom()
      continue
    }
    scan.skipSpace()
    const body = scan.balancedBody()
    if (body === null || name !== 'prefix_rule') continue
    let pattern: RulePattern | null = null
    let decision = 'allow'
    for (const part of splitArguments(body)) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      // A comment can sit in front of the keyword (after the previous argument's comma).
      const key = /([A-Za-z_]\w*)\s*$/.exec(part.slice(0, eq))?.[1]
      const value = new Scanner(part, eq + 1)
      if (key === 'pattern') pattern = asPattern(parseValue(value))
      else if (key === 'decision') {
        const parsed = parseValue(value)
        if (typeof parsed === 'string') decision = parsed
      }
    }
    if (pattern !== null) out.push({ pattern, decision })
  }
  return out
}

function wordSet(word: Word): readonly string[] {
  return typeof word === 'string' ? [word] : word
}

/**
 * True when every command the allow prefix `allow` matches is also matched by one of Arc's own
 * `prompt` rules, so Codex asks Arc whatever the user's rule says. A prompt rule matches a command
 * when its words are a prefix of the command's, so it covers `allow` when it is no longer than
 * `allow` and, word by word, lists every alternative `allow` lists.
 */
export function isCoveredByArcRules(
  allow: RulePattern,
  arc: readonly RulePattern[] = PROTECTED_PREFIXES
): boolean {
  return arc.some(
    (rule) =>
      rule.length <= allow.length &&
      rule.every((word, i) => {
        const wanted = wordSet(word)
        return wordSet(allow[i] ?? []).every((w) => wanted.includes(w))
      })
  )
}

const PLAIN_WORD = /^[\w./:@%+=,~-]{1,40}$/
const MAX_SHOWN_WORDS = 4

/**
 * A prefix as the user reads it: `git commit`, `npm run build`, `curl -L`. Only plain words are
 * shown; at the first long or odd word (a script after `node -e`) the prefix ends in "…", so no
 * rule content leaves the file.
 */
export function describePrefix(pattern: RulePattern): string {
  const shown: string[] = []
  for (const word of pattern) {
    const alternatives = wordSet(word)
    if (shown.length >= MAX_SHOWN_WORDS || !alternatives.every((w) => PLAIN_WORD.test(w))) {
      return `${shown.join(' ')} …`.trim()
    }
    shown.push(alternatives.join('|'))
  }
  return shown.join(' ')
}

export interface UserAllowRules {
  /** The distinct allow prefixes, in file order. */
  prefixes: RulePattern[]
}

/** The allow entries of `<codexHome>/rules/*.rules`; a missing folder or an unreadable file counts as none. */
export async function readUserAllowRules(codexHome: string): Promise<UserAllowRules> {
  const dir = join(codexHome, 'rules')
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.rules')).sort()
  } catch {
    return { prefixes: [] }
  }
  const prefixes: RulePattern[] = []
  const seen = new Set<string>()
  for (const name of names) {
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const entry of parseRulesFile(text)) {
      if (entry.decision !== 'allow') continue
      const key = JSON.stringify(entry.pattern)
      if (seen.has(key)) continue
      seen.add(key)
      prefixes.push(entry.pattern)
    }
  }
  return { prefixes }
}
