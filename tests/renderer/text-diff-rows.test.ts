import { describe, expect, it } from 'vitest'
import { diffLines } from '@shared/text-diff'
import { toUnifiedRows } from '../../src/renderer/src/lib/review/diff-rows'

describe('diffLines with toUnifiedRows', () => {
  it('feeds toUnifiedRows', () => {
    const rows = toUnifiedRows(diffLines('a\nb\nc\n', 'a\nB\nc\n')!)
    expect(rows.map((r) => (r.type === 'line' ? r.kind : r.type))).toEqual([
      'hunk',
      'ctx',
      'del',
      'add',
      'ctx'
    ])
    expect(rows[2]).toMatchObject({ type: 'line', kind: 'del', oldNo: 2, text: 'b' })
    expect(rows[3]).toMatchObject({ type: 'line', kind: 'add', newNo: 2, text: 'B' })
  })
})
