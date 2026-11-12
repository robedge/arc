import type { DiffHunk, DiffLine } from './types/review'

/** Either side with more lines than this is not diffed; `diffLines` returns null and the caller shows a fallback. */
export const TEXT_DIFF_MAX_LINES = 2000

const DEFAULT_CONTEXT = 3

interface Side {
  lines: string[]
  /** The last line has no line break after it. */
  lastHasNoNewline: boolean
}

/**
 * Splits on `\n` after turning `\r\n` into `\n` (line endings are not compared). A trailing newline does
 * not create an extra empty line; a last line without one is remembered so it can be flagged `noNewline`.
 */
function split(text: string): Side {
  if (text === '') return { lines: [], lastHasNoNewline: false }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
    return { lines, lastHasNoNewline: false }
  }
  return { lines, lastHasNoNewline: true }
}

/** Equality key: a last line without a newline differs from the same text with one, as in git. */
function keys(side: Side): string[] {
  const out = side.lines.slice()
  if (side.lastHasNoNewline) out[out.length - 1] += '\0'
  return out
}

/** Edit script by LCS over the trimmed middle; common prefix and suffix are matched first. */
function script(a: string[], b: string[]): DiffLine[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++
  }
  const n = a.length - pre - suf
  const m = b.length - pre - suf
  const width = m + 1
  // lcs[i * width + j]: LCS length of the middle's a[i..] and b[j..].
  const lcs = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[pre + i] === b[pre + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const ops: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  const push = (kind: DiffLine['kind'], text: string): void => {
    if (kind === 'ctx') ops.push({ kind, oldNo: oldNo++, newNo: newNo++, text })
    else if (kind === 'del') ops.push({ kind, oldNo: oldNo++, text })
    else ops.push({ kind, newNo: newNo++, text })
  }
  for (let k = 0; k < pre; k++) push('ctx', a[k]!)
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      push('ctx', a[pre + i]!)
      i++
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      push('del', a[pre + i]!)
      i++
    } else {
      push('add', b[pre + j]!)
      j++
    }
  }
  for (let k = a.length - suf; k < a.length; k++) push('ctx', a[k]!)
  return ops
}

/**
 * Line diff of two texts as `DiffHunk[]`, the shape change review renders, with `context` unchanged lines
 * around each change (default 3) and overlapping hunks merged. Identical texts give `[]`. Returns null when
 * either side has more than `TEXT_DIFF_MAX_LINES` lines.
 */
export function diffLines(a: string, b: string, opts?: { context?: number }): DiffHunk[] | null {
  const context = Math.max(0, opts?.context ?? DEFAULT_CONTEXT)
  const left = split(a)
  const right = split(b)
  if (left.lines.length > TEXT_DIFF_MAX_LINES || right.lines.length > TEXT_DIFF_MAX_LINES)
    return null

  const ops = script(keys(left), keys(right))
  // The script compared keys; show the real text and flag a final line without a newline.
  let o = 0
  let n = 0
  for (const op of ops) {
    if (op.kind !== 'add') {
      op.text = left.lines[o++]!
      if (left.lastHasNoNewline && o === left.lines.length) op.noNewline = true
    } else {
      op.text = right.lines[n++]!
      if (right.lastHasNoNewline && n === right.lines.length) op.noNewline = true
    }
    if (op.kind === 'ctx') n++
  }

  const changed: number[] = []
  ops.forEach((op, index) => {
    if (op.kind !== 'ctx') changed.push(index)
  })
  const hunks: DiffHunk[] = []
  let g = 0
  while (g < changed.length) {
    let end = g
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! - 1 <= 2 * context) end++
    const from = Math.max(0, changed[g]! - context)
    const to = Math.min(ops.length - 1, changed[end]! + context)
    const lines = ops.slice(from, to + 1)
    const oldLines = lines.filter((l) => l.kind !== 'add').length
    const newLines = lines.filter((l) => l.kind !== 'del').length
    const oldBefore = ops.slice(0, from).filter((l) => l.kind !== 'add').length
    const newBefore = ops.slice(0, from).filter((l) => l.kind !== 'del').length
    // A side with no lines in the hunk starts at the line before it, as git writes it.
    const oldStart = oldLines === 0 ? oldBefore : oldBefore + 1
    const newStart = newLines === 0 ? newBefore : newBefore + 1
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      lines
    })
    g = end + 1
  }
  return hunks
}
