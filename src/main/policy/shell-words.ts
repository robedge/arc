/**
 * A small shell-word tokenizer for the policy classifier (tech spec 2.6). It is not a shell: it
 * splits a command line into segments (on `;`, `&&`, `||`, `|`, `&`, newlines, groups, `$()` and
 * backticks), and each segment into words and redirections, with quotes removed. What it cannot
 * read safely (an unmatched quote, a here-string, an expansion inside a here-document) is reported
 * in `problems`, and the classifier treats that as destructive.
 */

export interface ShellWord {
  /** The word with quotes and escapes removed. */
  text: string
  /** Part of the value comes from an expansion the tokenizer cannot evaluate (`$VAR`, `$(...)`). */
  dynamic: boolean
}

export interface ShellRedirect {
  /** `>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `<`, `<&`, `<>` or `<<` (a here-document). */
  op: string
  target: ShellWord | null
}

export interface ShellSegment {
  words: ShellWord[]
  redirects: ShellRedirect[]
  /** The segment reads a here-document on stdin. */
  heredoc: boolean
}

export interface ShellParse {
  segments: ShellSegment[]
  /** Why the line cannot be read safely; empty when it can. */
  problems: string[]
}

export interface ShellParseOptions {
  /** Expands `~` and `$HOME`. */
  home: string
}

const MAX_DEPTH = 8
const MAX_LENGTH = 100_000

type Mode = 'top' | 'paren' | 'backtick'

interface Heredoc {
  delimiter: string
  quoted: boolean
  strip: boolean
}

interface WordBuilder {
  text: string
  dynamic: boolean
  /** Only digits, never quoted: may be the file descriptor of a redirection (`2>`). */
  plainDigits: boolean
}

const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c)
const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r'
const isWordEnd = (c: string): boolean => isBlank(c) || c === '\n' || /[;&|()<>]/.test(c)

class Parser {
  private pos = 0
  readonly segments: ShellSegment[] = []
  readonly problems: string[] = []

  constructor(
    private readonly src: string,
    private readonly options: ShellParseOptions
  ) {}

  run(): void {
    this.sequence('top', 0)
  }

  private problem(text: string): void {
    if (!this.problems.includes(text)) this.problems.push(text)
  }

  /** Reads commands until the end of the input, or (inside a substitution) its closing token. */
  private sequence(mode: Mode, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.problem('commands nested too deeply')
      this.pos = this.src.length
      return
    }
    const src = this.src
    // One state object: TypeScript does not follow assignments made inside the helper closures.
    const st: {
      segment: ShellSegment
      word: WordBuilder | null
      pending: ShellRedirect | null
    } = { segment: { words: [], redirects: [], heredoc: false }, word: null, pending: null }
    const heredocs: Heredoc[] = []
    let groupDepth = 0

    const endWord = (): void => {
      const w = st.word
      if (!w) return
      st.word = null
      const finished: ShellWord = { text: w.text, dynamic: w.dynamic }
      if (st.pending) {
        st.pending.target = finished
        st.pending = null
      } else {
        st.segment.words.push(finished)
      }
    }
    const endSegment = (): void => {
      endWord()
      st.pending = null
      if (st.segment.words.length > 0 || st.segment.redirects.length > 0) {
        this.segments.push(st.segment)
      }
      st.segment = { words: [], redirects: [], heredoc: false }
    }
    const builder = (): WordBuilder => {
      st.word ??= { text: '', dynamic: false, plainDigits: true }
      return st.word
    }
    const append = (text: string, quoted: boolean): void => {
      const w = builder()
      w.text += text
      if (quoted || !/^\d*$/.test(text)) w.plainDigits = false
    }
    const markDynamic = (): void => {
      const w = builder()
      w.dynamic = true
      w.plainDigits = false
    }

    while (this.pos < src.length) {
      const c = src.charAt(this.pos)

      if (isBlank(c)) {
        endWord()
        this.pos += 1
        continue
      }
      if (c === '\n') {
        endSegment()
        this.pos += 1
        for (const heredoc of heredocs.splice(0)) this.readHeredocBody(heredoc)
        continue
      }
      if (c === '\\') {
        const next = src.charAt(this.pos + 1)
        if (next === '\n') {
          this.pos += 2
        } else {
          if (next !== '') append(next, true)
          this.pos += 2
        }
        continue
      }
      if (c === "'") {
        const end = src.indexOf("'", this.pos + 1)
        if (end === -1) {
          this.problem('an unmatched quote')
          this.pos = src.length
          return
        }
        builder()
        append(src.slice(this.pos + 1, end), true)
        this.pos = end + 1
        continue
      }
      if (c === '"') {
        this.pos += 1
        const w = builder()
        w.plainDigits = false
        this.doubleQuoted(w, depth)
        continue
      }
      if (c === '$') {
        this.dollar(builder(), depth, false)
        continue
      }
      if (c === '`') {
        this.pos += 1
        this.sequence('backtick', depth + 1)
        markDynamic()
        continue
      }
      if (c === '~' && st.word === null) {
        const next = src.charAt(this.pos + 1)
        if (next === '' || next === '/' || isWordEnd(next)) {
          append(this.options.home, true)
          this.pos += 1
          continue
        }
      }
      if (c === ';') {
        endSegment()
        this.pos += 1
        continue
      }
      if (c === '&') {
        const next = src.charAt(this.pos + 1)
        if (next === '>') {
          endWord()
          const op = src.charAt(this.pos + 2) === '>' ? '&>>' : '&>'
          this.pos += op.length
          st.pending = { op, target: null }
          st.segment.redirects.push(st.pending)
          continue
        }
        endSegment()
        this.pos += next === '&' ? 2 : 1
        continue
      }
      if (c === '|') {
        endSegment()
        const next = src.charAt(this.pos + 1)
        this.pos += next === '|' || next === '&' ? 2 : 1
        continue
      }
      if (c === '(') {
        endSegment()
        groupDepth += 1
        this.pos += 1
        continue
      }
      if (c === ')') {
        if (mode === 'paren' && groupDepth === 0) {
          endSegment()
          this.pos += 1
          for (const heredoc of heredocs.splice(0)) this.readHeredocBody(heredoc)
          return
        }
        endSegment()
        groupDepth = Math.max(0, groupDepth - 1)
        this.pos += 1
        continue
      }
      if (c === '>' || c === '<') {
        const next = src.charAt(this.pos + 1)
        if (next === '(') {
          // Process substitution: its command runs, and its path is an argument.
          this.pos += 2
          this.sequence('paren', depth + 1)
          markDynamic()
          continue
        }
        // A digits-only word right before the operator is the file descriptor (`2>`), not an argument.
        if (st.word?.plainDigits) {
          st.word = null
        } else {
          endWord()
        }
        const op = this.redirectOperator()
        if (op === '<<<') {
          this.problem('a here-string')
          continue
        }
        if (op === '<<' || op === '<<-') {
          const heredoc = this.readHeredocDelimiter(op === '<<-')
          if (heredoc) {
            heredocs.push(heredoc)
            st.segment.heredoc = true
            st.segment.redirects.push({
              op: '<<',
              target: { text: heredoc.delimiter, dynamic: false }
            })
          }
          continue
        }
        st.pending = { op, target: null }
        st.segment.redirects.push(st.pending)
        continue
      }
      // An ordinary word character.
      builder()
      append(c, false)
      this.pos += 1
    }

    if (mode !== 'top') this.problem('an unterminated substitution')
    endSegment()
    for (const heredoc of heredocs.splice(0)) this.readHeredocBody(heredoc)
  }

  private redirectOperator(): string {
    const rest = this.src.slice(this.pos, this.pos + 3)
    for (const op of ['<<<', '<<-', '>>', '>|', '>&', '<<', '<&', '<>', '>', '<']) {
      if (rest.startsWith(op)) {
        this.pos += op.length
        return op
      }
    }
    this.pos += 1
    return rest.charAt(0)
  }

  /** `$name`, `${...}`, `$(...)`, `$((...))` and `$'...'` after the `$` at the current position. */
  private dollar(word: WordBuilder, depth: number, inDouble: boolean): void {
    const src = this.src
    const next = src.charAt(this.pos + 1)
    if (next === '(') {
      if (src.charAt(this.pos + 2) === '(') {
        const close = src.indexOf('))', this.pos + 3)
        if (close === -1) {
          this.problem('an unterminated arithmetic expansion')
          this.pos = src.length
          return
        }
        this.pos = close + 2
        word.dynamic = true
        word.plainDigits = false
        return
      }
      this.pos += 2
      this.sequence('paren', depth + 1)
      word.dynamic = true
      word.plainDigits = false
      return
    }
    if (next === '{') {
      let level = 1
      let i = this.pos + 2
      for (; i < src.length && level > 0; i++) {
        const ch = src.charAt(i)
        if (ch === '{') level += 1
        else if (ch === '}') level -= 1
      }
      if (level > 0) {
        this.problem('an unterminated parameter expansion')
        this.pos = src.length
        return
      }
      const name = src.slice(this.pos + 2, i - 1)
      this.pos = i
      this.variable(word, name)
      return
    }
    if (next === "'" && !inDouble) {
      const end = src.indexOf("'", this.pos + 2)
      if (end === -1) {
        this.problem('an unmatched quote')
        this.pos = src.length
        return
      }
      word.text += src.slice(this.pos + 2, end)
      word.dynamic = true
      word.plainDigits = false
      this.pos = end + 1
      return
    }
    if (isNameStart(next)) {
      let i = this.pos + 1
      while (i < src.length && isNameChar(src.charAt(i))) i++
      const name = src.slice(this.pos + 1, i)
      this.pos = i
      this.variable(word, name)
      return
    }
    if (/[0-9@*#?!$-]/.test(next)) {
      this.pos += 2
      word.dynamic = true
      word.plainDigits = false
      return
    }
    word.text += '$'
    word.plainDigits = false
    this.pos += 1
  }

  private variable(word: WordBuilder, name: string): void {
    word.plainDigits = false
    if (name === 'HOME') word.text += this.options.home
    else word.dynamic = true
  }

  /** Inside `"..."`: expansions run, everything else is literal. The opening quote is consumed. */
  private doubleQuoted(word: WordBuilder, depth: number): void {
    const src = this.src
    for (;;) {
      if (this.pos >= src.length) {
        this.problem('an unmatched quote')
        return
      }
      const c = src.charAt(this.pos)
      if (c === '"') {
        this.pos += 1
        return
      }
      if (c === '\\') {
        const next = src.charAt(this.pos + 1)
        if (next === '\n') {
          this.pos += 2
        } else if (next === '"' || next === '\\' || next === '$' || next === '`') {
          word.text += next
          this.pos += 2
        } else {
          word.text += c
          this.pos += 1
        }
        continue
      }
      if (c === '$') {
        this.dollar(word, depth, true)
        continue
      }
      if (c === '`') {
        this.pos += 1
        this.sequence('backtick', depth + 1)
        word.dynamic = true
        continue
      }
      word.text += c
      this.pos += 1
    }
  }

  private readHeredocDelimiter(strip: boolean): Heredoc | null {
    const src = this.src
    while (isBlank(src.charAt(this.pos))) this.pos += 1
    let delimiter = ''
    let quoted = false
    while (this.pos < src.length && !isWordEnd(src.charAt(this.pos))) {
      const c = src.charAt(this.pos)
      if (c === "'" || c === '"') {
        const end = src.indexOf(c, this.pos + 1)
        if (end === -1) {
          this.problem('an unmatched quote')
          this.pos = src.length
          return null
        }
        delimiter += src.slice(this.pos + 1, end)
        quoted = true
        this.pos = end + 1
      } else if (c === '\\') {
        delimiter += src.charAt(this.pos + 1)
        quoted = true
        this.pos += 2
      } else {
        delimiter += c
        this.pos += 1
      }
    }
    if (delimiter === '') {
      this.problem('a here-document without a delimiter')
      return null
    }
    return { delimiter, quoted, strip }
  }

  /** Skips the body lines of a here-document. An unquoted delimiter lets `$(...)` and backticks run. */
  private readHeredocBody(heredoc: Heredoc): void {
    const src = this.src
    const start = this.pos
    let lineStart = this.pos
    while (lineStart <= src.length) {
      const nl = src.indexOf('\n', lineStart)
      const lineEnd = nl === -1 ? src.length : nl
      const line = src.slice(lineStart, lineEnd)
      const compare = heredoc.strip ? line.replace(/^\t+/, '') : line
      if (compare === heredoc.delimiter) {
        this.checkHeredocBody(heredoc, src.slice(start, lineStart))
        this.pos = nl === -1 ? src.length : nl + 1
        return
      }
      if (nl === -1) break
      lineStart = nl + 1
    }
    this.checkHeredocBody(heredoc, src.slice(start))
    this.pos = src.length
  }

  private checkHeredocBody(heredoc: Heredoc, body: string): void {
    if (!heredoc.quoted && (body.includes('$(') || body.includes('`'))) {
      this.problem('a command substitution inside a here-document')
    }
  }
}

export function parseShell(source: string, options: ShellParseOptions): ShellParse {
  if (source.length > MAX_LENGTH) {
    return { segments: [], problems: ['a command that is too long to check'] }
  }
  const parser = new Parser(source, options)
  parser.run()
  return { segments: parser.segments, problems: parser.problems }
}
