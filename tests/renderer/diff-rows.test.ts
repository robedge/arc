import { describe, expect, it } from 'vitest'
import {
  hunkRowIndexes,
  toSplitRows,
  toUnifiedRows
} from '../../src/renderer/src/lib/review/diff-rows'
import type { DiffHunk } from '../../src/shared/types/review'

const hunks: DiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, text: 'b' },
      { kind: 'add', newNo: 2, text: 'c', noNewline: true }
    ]
  },
  {
    oldStart: 20,
    oldLines: 1,
    newStart: 20,
    newLines: 1,
    header: '@@ -20 +20 @@ fn',
    lines: [{ kind: 'ctx', oldNo: 20, newNo: 20, text: 'z' }]
  }
]

it('flattens hunks into header rows and line rows with numbers on both sides', () => {
  const rows = toUnifiedRows(hunks)
  expect(rows.map((r) => r.type)).toEqual([
    'hunk',
    'line',
    'line',
    'line',
    'noNewline',
    'hunk',
    'line'
  ])
  expect(rows[0]).toEqual({ type: 'hunk', hunkIndex: 0, header: '@@ -1,2 +1,2 @@' })
  expect(rows[1]).toEqual({ type: 'line', kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' })
  expect(rows[2]).toEqual({ type: 'line', kind: 'del', oldNo: 2, text: 'b' })
  expect(rows[3]).toEqual({ type: 'line', kind: 'add', newNo: 2, text: 'c' })
  expect(rows[5]).toEqual({ type: 'hunk', hunkIndex: 1, header: '@@ -20 +20 @@ fn' })
})

it('lists the hunk header rows and handles no hunks', () => {
  expect(hunkRowIndexes(toUnifiedRows(hunks))).toEqual([0, 5])
  expect(toUnifiedRows([])).toEqual([])
})

const hunkOf = (lines: DiffHunk['lines']): DiffHunk[] => [
  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '@@ h @@', lines }
]
const pairs = (hs: DiffHunk[]): [string | null, string | null][] =>
  toSplitRows(hs).flatMap((r) =>
    r.type === 'pair'
      ? [[r.left?.text ?? null, r.right?.text ?? null] as [string | null, string | null]]
      : []
  )

describe('toSplitRows', () => {
  it('pairs equal runs of removed and added lines row by row', () => {
    const rows = pairs(
      hunkOf([
        { kind: 'del', oldNo: 1, text: 'a' },
        { kind: 'del', oldNo: 2, text: 'b' },
        { kind: 'add', newNo: 1, text: 'A' },
        { kind: 'add', newNo: 2, text: 'B' }
      ])
    )
    expect(rows).toEqual([
      ['a', 'A'],
      ['b', 'B']
    ])
  })

  it('leaves the right cell empty for extra removed lines', () => {
    const rows = pairs(
      hunkOf([
        { kind: 'del', oldNo: 1, text: 'a' },
        { kind: 'del', oldNo: 2, text: 'b' },
        { kind: 'del', oldNo: 3, text: 'c' },
        { kind: 'add', newNo: 1, text: 'A' }
      ])
    )
    expect(rows).toEqual([
      ['a', 'A'],
      ['b', null],
      ['c', null]
    ])
  })

  it('leaves the left cell empty for extra added lines', () => {
    const rows = pairs(
      hunkOf([
        { kind: 'del', oldNo: 1, text: 'a' },
        { kind: 'add', newNo: 1, text: 'A' },
        { kind: 'add', newNo: 2, text: 'B' }
      ])
    )
    expect(rows).toEqual([
      ['a', 'A'],
      [null, 'B']
    ])
  })

  it('shows context on both sides with each side own number and spans hunk headers', () => {
    const rows = toSplitRows([
      ...hunkOf([
        { kind: 'ctx', oldNo: 5, newNo: 7, text: 'same' },
        { kind: 'del', oldNo: 6, text: 'x' },
        { kind: 'add', newNo: 8, text: 'y' },
        { kind: 'ctx', oldNo: 7, newNo: 9, text: 'tail' }
      ]),
      ...hunkOf([{ kind: 'add', newNo: 40, text: 'z' }])
    ])
    expect(rows.map((r) => r.type)).toEqual(['hunk', 'pair', 'pair', 'pair', 'hunk', 'pair'])
    expect(rows[1]).toEqual({
      type: 'pair',
      left: { kind: 'ctx', no: 5, text: 'same' },
      right: { kind: 'ctx', no: 7, text: 'same' }
    })
    expect(rows[2]).toMatchObject({
      left: { kind: 'del', no: 6 },
      right: { kind: 'add', no: 8 }
    })
    expect(hunkRowIndexes(rows)).toEqual([0, 4])
  })
})
