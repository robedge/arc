/**
 * Soft-wrapping for the terminal log. The log is virtualized with a fixed row height, so a logical line is split
 * into fixed-width visual rows by column count (a hard break, like a real terminal) instead of growing sideways.
 */

export interface TerminalRow {
  text: string
  /** Index of the buffer line this row belongs to. */
  line: number
  /** True for every row after the first of a wrapped line. */
  continuation: boolean
}

/** Leading spaces of a line; wrapped rows repeat them so the continuation lines up (helper lines are indented). */
function indentOf(line: string, cols: number): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  // Never let the indent starve the text of room.
  return Math.min(n, Math.max(0, Math.floor(cols / 2)))
}

function usable(cols: number): number {
  return Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : Infinity
}

/** How many visual rows one line takes at `cols` columns (an empty line still takes one). */
export function rowCount(line: string, cols: number): number {
  const width = usable(cols)
  if (line.length <= width) return 1
  const indent = indentOf(line, width)
  const body = width - indent
  return 1 + Math.ceil((line.length - width) / body)
}

/** One line split into rows; continuation rows keep the line's indent. */
export function wrapLine(line: string, cols: number): string[] {
  const width = usable(cols)
  if (line.length <= width) return [line]
  const indent = indentOf(line, width)
  const pad = ' '.repeat(indent)
  const body = width - indent
  const rows = [line.slice(0, width)]
  for (let at = width; at < line.length; at += body) rows.push(pad + line.slice(at, at + body))
  return rows
}

/** Every buffer line split into visual rows. */
export function wrapLines(lines: readonly string[], cols: number): TerminalRow[] {
  const out: TerminalRow[] = []
  lines.forEach((line, i) => {
    wrapLine(line, cols).forEach((text, k) => out.push({ text, line: i, continuation: k > 0 }))
  })
  return out
}

/**
 * `offsets[i]` is the index of line i's first visual row and `offsets[lines.length]` the total row count.
 * Cheap enough to redo whenever the buffer or the width changes: it allocates one typed array and no strings.
 */
export function rowOffsets(lines: readonly string[], cols: number): Int32Array {
  const offsets = new Int32Array(lines.length + 1)
  let total = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = total
    total += rowCount(lines[i] ?? '', cols)
  }
  offsets[lines.length] = total
  return offsets
}

/** The line holding visual row `row` (binary search over `offsets`). */
export function lineOfRow(offsets: Int32Array, row: number): number {
  let lo = 0
  let hi = offsets.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((offsets[mid] ?? 0) <= row) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

/** The visual rows `[first, last)` only, so a huge buffer renders just its window. */
export function rowsInWindow(
  lines: readonly string[],
  offsets: Int32Array,
  cols: number,
  first: number,
  last: number
): TerminalRow[] {
  const out: TerminalRow[] = []
  if (lines.length === 0) return out
  for (let i = lineOfRow(offsets, first); i < lines.length; i++) {
    const start = offsets[i] ?? 0
    if (start >= last) break
    wrapLine(lines[i] ?? '', cols).forEach((text, k) => {
      const row = start + k
      if (row >= first && row < last) out.push({ text, line: i, continuation: k > 0 })
    })
  }
  return out
}
