import type { ReviewNoteSide } from '@shared/types/review'
import type { DiffRow, SplitCell, SplitRow } from './diff-rows'

/** The line a note is written on: which side of the diff, its number there, and its text. */
export interface NoteAnchor {
  side: ReviewNoteSide
  line: number
  lineText: string
}

export const anchorKey = (side: ReviewNoteSide, line: number): string => `${side}:${line}`

type LineRow = Extract<DiffRow, { type: 'line' }>

/**
 * The anchor of a unified line: removed lines are on the old side; added lines and context lines are on
 * the new side.
 */
export function unifiedAnchor(row: LineRow): NoteAnchor | null {
  if (row.kind === 'del') {
    return row.oldNo === undefined ? null : { side: 'old', line: row.oldNo, lineText: row.text }
  }
  return row.newNo === undefined ? null : { side: 'new', line: row.newNo, lineText: row.text }
}

/** The anchor of one side of a side-by-side row: each cell is on its own side. */
export function splitAnchor(cell: SplitCell, side: ReviewNoteSide): NoteAnchor | null {
  return cell.no > 0 ? { side, line: cell.no, lineText: cell.text } : null
}

/** A row that holds the notes (and the open composer) of one line. */
export interface UnifiedNotesItem {
  type: 'notes'
  key: string
  anchor: NoteAnchor
}
export interface SplitNotesItem {
  type: 'notes'
  key: string
  left: NoteAnchor | null
  right: NoteAnchor | null
}

export type UnifiedItem = DiffRow | UnifiedNotesItem
export type SplitItem = SplitRow | SplitNotesItem

export interface WithNotes<TItem> {
  items: TItem[]
  /** For each input row, its index in `items`. */
  indexOf: number[]
  /** Anchor keys that found a line to sit under. */
  placed: Set<string>
}

/**
 * Inserts a notes row under every line that has notes or the open composer (`wanted` holds anchor keys).
 * A context line shows the notes of both its sides.
 */
export function withUnifiedNotes(
  rows: readonly DiffRow[],
  wanted: ReadonlySet<string>
): WithNotes<UnifiedItem> {
  const items: UnifiedItem[] = []
  const indexOf: number[] = []
  const placed = new Set<string>()
  for (const row of rows) {
    indexOf.push(items.length)
    items.push(row)
    if (row.type !== 'line') continue
    const anchors: NoteAnchor[] = []
    const primary = unifiedAnchor(row)
    if (primary) anchors.push(primary)
    if (row.kind === 'ctx' && row.oldNo !== undefined) {
      anchors.push({ side: 'old', line: row.oldNo, lineText: row.text })
    }
    for (const anchor of anchors) {
      const key = anchorKey(anchor.side, anchor.line)
      if (!wanted.has(key) || placed.has(key)) continue
      placed.add(key)
      items.push({ type: 'notes', key, anchor })
    }
  }
  return { items, indexOf, placed }
}

/** Side-by-side version: one notes row can hold a note on each side. */
export function withSplitNotes(
  rows: readonly SplitRow[],
  wanted: ReadonlySet<string>
): WithNotes<SplitItem> {
  const items: SplitItem[] = []
  const indexOf: number[] = []
  const placed = new Set<string>()
  const pick = (cell: SplitCell | null, side: ReviewNoteSide): NoteAnchor | null => {
    const anchor = cell ? splitAnchor(cell, side) : null
    if (!anchor) return null
    const key = anchorKey(anchor.side, anchor.line)
    if (!wanted.has(key) || placed.has(key)) return null
    placed.add(key)
    return anchor
  }
  for (const row of rows) {
    indexOf.push(items.length)
    items.push(row)
    if (row.type !== 'pair') continue
    const left = pick(row.left, 'old')
    const right = pick(row.right, 'new')
    if (left || right) {
      items.push({
        type: 'notes',
        key: `${left ? anchorKey(left.side, left.line) : ''}|${right ? anchorKey(right.side, right.line) : ''}`,
        left,
        right
      })
    }
  }
  return { items, indexOf, placed }
}
