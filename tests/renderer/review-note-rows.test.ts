import { describe, expect, it } from 'vitest'
import { toSplitRows, toUnifiedRows } from '../../src/renderer/src/lib/review/diff-rows'
import { withSplitNotes, withUnifiedNotes } from '../../src/renderer/src/lib/review/note-rows'
import { offsetsOf, rowAt } from '../../src/renderer/src/lib/review/row-window'
import type { DiffHunk } from '../../src/shared/types/review'

const hunks: DiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    header: '@@',
    lines: [
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
      { kind: 'del', oldNo: 2, text: 'gone' },
      { kind: 'add', newNo: 2, text: 'came' }
    ]
  }
]

describe('note rows', () => {
  it('unified: a notes row follows its line; a context line also shows old-side notes', () => {
    const rows = toUnifiedRows(hunks)
    const laid = withUnifiedNotes(rows, new Set(['old:2', 'old:1']))
    expect(laid.items.map((i) => (i.type === 'notes' ? `notes ${i.key}` : i.type))).toEqual([
      'hunk',
      'line',
      'notes old:1',
      'line',
      'notes old:2',
      'line'
    ])
    expect(laid.indexOf).toEqual([0, 1, 3, 5])
    expect([...laid.placed].sort()).toEqual(['old:1', 'old:2'])
  })

  it('split: one notes row can hold a note on each side', () => {
    const laid = withSplitNotes(toSplitRows(hunks), new Set(['old:2', 'new:2']))
    const notes = laid.items.filter((i) => i.type === 'notes')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      left: { side: 'old', line: 2 },
      right: { side: 'new', line: 2 }
    })
  })

  it('a note whose line is not shown is not placed', () => {
    expect(withUnifiedNotes(toUnifiedRows(hunks), new Set(['new:99'])).placed.size).toBe(0)
  })
})

describe('row window', () => {
  it('finds the row at a position with mixed heights', () => {
    const offsets = offsetsOf([20, 20, 100, 20])
    expect(offsets).toEqual([0, 20, 40, 140, 160])
    expect(rowAt(offsets, 0)).toBe(0)
    expect(rowAt(offsets, 39)).toBe(1)
    expect(rowAt(offsets, 40)).toBe(2)
    expect(rowAt(offsets, 139)).toBe(2)
    expect(rowAt(offsets, 1000)).toBe(3)
    expect(rowAt(offsetsOf([]), 5)).toBe(0)
  })
})
