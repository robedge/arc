import type { DiffHunk, DiffLineKind } from '@shared/types/review'

/** One rendered row of a unified diff, ready for fixed-height windowing. */
export type DiffRow =
  | { type: 'hunk'; hunkIndex: number; header: string }
  | { type: 'line'; kind: DiffLineKind; oldNo?: number; newNo?: number; text: string }
  | { type: 'noNewline' }

/** Flattens hunks into hunk header rows, line rows, and a marker row after a line without a final newline. */
export function toUnifiedRows(hunks: readonly DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  hunks.forEach((hunk, hunkIndex) => {
    rows.push({ type: 'hunk', hunkIndex, header: hunk.header })
    for (const line of hunk.lines) {
      const row: DiffRow = { type: 'line', kind: line.kind, text: line.text }
      if (line.oldNo !== undefined) row.oldNo = line.oldNo
      if (line.newNo !== undefined) row.newNo = line.newNo
      rows.push(row)
      if (line.noNewline) rows.push({ type: 'noNewline' })
    }
  })
  return rows
}

/** One side of a side-by-side row. */
export interface SplitCell {
  kind: DiffLineKind
  no: number
  text: string
  noNewline?: true
}

/** One rendered row of a side-by-side diff: a hunk header spanning both sides, or a left/right pair. */
export type SplitRow =
  | { type: 'hunk'; hunkIndex: number; header: string }
  | { type: 'pair'; left: SplitCell | null; right: SplitCell | null }

/**
 * Pairs removed and added runs for side-by-side display. Within a hunk a run of removed lines followed
 * by a run of added lines is paired row by row; leftovers have an empty cell on the other side.
 * Context lines appear on both sides with their own line numbers.
 */
export function toSplitRows(hunks: readonly DiffHunk[]): SplitRow[] {
  const rows: SplitRow[] = []
  hunks.forEach((hunk, hunkIndex) => {
    rows.push({ type: 'hunk', hunkIndex, header: hunk.header })
    let dels: SplitCell[] = []
    let adds: SplitCell[] = []
    const flush = (): void => {
      const n = Math.max(dels.length, adds.length)
      for (let i = 0; i < n; i++) {
        rows.push({ type: 'pair', left: dels[i] ?? null, right: adds[i] ?? null })
      }
      dels = []
      adds = []
    }
    for (const line of hunk.lines) {
      const cell = (no: number | undefined, kind: DiffLineKind): SplitCell => ({
        kind,
        no: no ?? 0,
        text: line.text,
        ...(line.noNewline ? { noNewline: true as const } : {})
      })
      if (line.kind === 'del') {
        // A removed line after added lines starts a new run.
        if (adds.length > 0) flush()
        dels.push(cell(line.oldNo, 'del'))
      } else if (line.kind === 'add') {
        adds.push(cell(line.newNo, 'add'))
      } else {
        flush()
        rows.push({
          type: 'pair',
          left: cell(line.oldNo, 'ctx'),
          right: cell(line.newNo, 'ctx')
        })
      }
    }
    flush()
  })
  return rows
}

/** Indexes of the hunk header rows, for jumping between changes. */
export function hunkRowIndexes(rows: readonly { type: string }[]): number[] {
  const out: number[] = []
  rows.forEach((row, i) => {
    if (row.type === 'hunk') out.push(i)
  })
  return out
}
