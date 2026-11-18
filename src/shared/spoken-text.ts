/** What Nova says aloud for a brain answer (spec 016). Pure: no Electron or DOM, so main and renderer can both use it. */
export interface SpokenText {
  text: string
  /** True when anything substantive (code, a table, a diff, a URL, a path, extra sentences) was left out. */
  droppedContent: boolean
}

const MAX_SENTENCES = 3
const MAX_CHARS = 350

/** Words whose trailing period does not end a sentence (lowercase, internal periods kept). */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'approx',
  'inc',
  'fig'
])

const FENCE = /^\s*(```|~~~)/
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
/** `@@`, `---`/`+++` headers and `-x`/`+x` lines. `- item` and `+ item` (a space after the marker) are list items. */
const DIFF_LINE = /^(@@|(---|\+\+\+)\s\S|[+-]\S)/
const TABLE_LINE = /^\s*\|/

function isPathToken(core: string): boolean {
  if (/^(\.{1,2}\/|~\/|\/)\S/.test(core)) return true
  return core.includes('/') && /\.[A-Za-z0-9]{1,8}$/.test(core)
}

/** Whether the period at `index` ends a sentence: not an abbreviation, not a lone initial. */
function endsSentence(text: string, index: number): boolean {
  if (text[index] !== '.') return true
  const word = /[A-Za-z.]+$/.exec(text.slice(0, index))?.[0].toLowerCase() ?? ''
  if (ABBREVIATIONS.has(word)) return false
  // A lone capital letter before the period is an initial ("J. Smith"), not a sentence end.
  return !/(?:^|\s)[A-Za-z]$/.test(text.slice(0, index))
}

export function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  const terminator = /[.!?]+(?=\s|$)/g
  for (let match = terminator.exec(text); match; match = terminator.exec(text)) {
    const end = match.index + match[0].length
    if (!endsSentence(text, end - 1)) continue
    sentences.push(text.slice(start, end).trim())
    start = end
  }
  const rest = text.slice(start).trim()
  if (rest) sentences.push(rest)
  return sentences.filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
}

/** Cuts at the last word boundary that leaves room for a closing period. */
function truncate(sentence: string): string {
  let head = sentence.slice(0, MAX_CHARS - 1)
  if (sentence[MAX_CHARS - 1] !== ' ') head = head.slice(0, Math.max(head.lastIndexOf(' '), 1))
  return `${head.trim().replace(/[,;:.!?]+$/, '')}.`
}

export function shapeSpoken(markdown: string): SpokenText {
  let dropped = false
  const kept: string[] = []
  let fence: string | null = null

  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(raw)
    if (fence !== null) {
      dropped = true
      if (fenceMatch?.[1] === fence) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? null
      dropped = true
      continue
    }
    if (HORIZONTAL_RULE.test(raw)) continue
    if (TABLE_LINE.test(raw) || DIFF_LINE.test(raw)) {
      dropped = true
      continue
    }
    kept.push(
      raw
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>+\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    )
  }

  let text = kept.join(' ')
  const strip = (pattern: RegExp, replacement: string): void => {
    text = text.replace(pattern, (...args: string[]) => {
      dropped = dropped || replacement === ''
      return replacement === '$1' ? (args[1] ?? '') : replacement
    })
  }
  strip(/`[^`]*`/g, '')
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, (_m, label: string) => {
    dropped = true
    return label
  })
  strip(/\b(?:https?:\/\/|www\.)[^\s<>)]*[^\s<>).,;:!?]/g, '')
  text = text
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')

  text = text
    .split(/\s+/)
    .map((token) => {
      const parts = /^([("'[]*)(.*?)([.,;:!?)"'\]]*)$/.exec(token)
      if (!parts || !parts[2] || !isPathToken(parts[2])) return token
      dropped = true
      return `${parts[1]}${parts[3]}`
    })
    .join(' ')
    .replace(/([\p{L}\p{N}])\s+([.,;:!?])/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()

  const sentences = splitSentences(text)
  const chosen: string[] = []
  let length = 0
  for (const sentence of sentences.slice(0, MAX_SENTENCES)) {
    const next = length + (chosen.length > 0 ? 1 : 0) + sentence.length
    if (next <= MAX_CHARS) {
      chosen.push(sentence)
      length = next
    } else {
      if (chosen.length === 0) chosen.push(truncate(sentence))
      dropped = true
      break
    }
  }
  if (chosen.length < sentences.length) dropped = true

  return { text: chosen.join(' '), droppedContent: dropped }
}
