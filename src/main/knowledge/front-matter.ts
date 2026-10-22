export interface SplitFile {
  /** Front matter lines between the `---` fences, or null when the file has none. */
  lines: string[] | null
  body: string
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const EMPTY_FENCE = /^---\r?\n---\r?\n?/

export function splitFrontMatter(text: string): SplitFile {
  const empty = EMPTY_FENCE.exec(text)
  if (empty) return { lines: [], body: text.slice(empty[0].length) }
  const match = FENCE.exec(text)
  if (!match) return { lines: null, body: text }
  return { lines: (match[1] ?? '').split(/\r?\n/), body: text.slice(match[0].length) }
}

export function joinFrontMatter(lines: readonly string[] | null, body: string): string {
  if (!lines || lines.length === 0) return body
  return `---\n${lines.join('\n')}\n---\n${body}`
}

export function titleFromLines(lines: readonly string[] | null): string | undefined {
  return valueFromLines(lines, 'title')
}

export function urlFromLines(lines: readonly string[] | null): string | undefined {
  return valueFromLines(lines, 'url')
}

function valueFromLines(lines: readonly string[] | null, key: string): string | undefined {
  const line = lines?.find((l) => l.startsWith(`${key}:`))
  if (line === undefined) return undefined
  const value = line.slice(key.length + 1).trim()
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {
      // fall through to the raw value
    }
  }
  return value.length > 0 ? value : undefined
}

/** JSON string quoting is valid YAML, so any title round-trips safely. */
export function titleLine(title: string): string {
  return `title: ${JSON.stringify(title)}`
}

/** Returns the lines with the title set (string) or removed (null); other keys are kept. */
export function withTitle(lines: readonly string[] | null, title: string | null): string[] {
  const rest = (lines ?? []).filter((l) => !l.startsWith('title:'))
  return title === null ? rest : [titleLine(title), ...rest]
}

export function urlLine(url: string): string {
  return `url: ${JSON.stringify(url)}`
}
