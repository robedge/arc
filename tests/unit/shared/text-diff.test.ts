import { describe, expect, it } from 'vitest'
import { diffLines, TEXT_DIFF_MAX_LINES } from '@shared/text-diff'
import type { DiffHunk } from '@shared/types/review'

const nums = (n: number, prefix = 'line'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`)
const text = (lines: string[]): string => lines.join('\n') + '\n'

/** Applies hunks to `a` and returns the result, checking every hunk number against the text on the way. */
function apply(a: string, hunks: DiffHunk[]): string {
  const old = a === '' ? [] : a.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const out: string[] = []
  let pos = 0 // next unconsumed index in old
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1
    while (pos < start) out.push(old[pos++] ?? '')
    expect(h.header).toBe(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    expect(h.newStart).toBe(out.length + (h.newLines === 0 ? 0 : 1))
    let oldCount = 0
    let newCount = 0
    for (const l of h.lines) {
      if (l.kind !== 'add') {
        expect(old[pos]).toBe(l.text)
        expect(l.oldNo).toBe(pos + 1)
        pos++
        oldCount++
      }
      if (l.kind !== 'del') {
        expect(l.newNo).toBe(out.length + 1)
        out.push(l.text)
        newCount++
      }
    }
    expect(oldCount).toBe(h.oldLines)
    expect(newCount).toBe(h.newLines)
  }
  while (pos < old.length) out.push(old[pos++] ?? '')
  return out.length === 0 ? '' : out.join('\n') + '\n'
}

const kinds = (h: DiffHunk): string => h.lines.map((l) => l.kind[0]).join('')

describe('diffLines', () => {
  it('returns no hunks for identical texts, including empty ones', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([])
    expect(diffLines('', '')).toEqual([])
  })

  it('handles additions only', () => {
    const a = text(nums(10))
    const b = text([...nums(10).slice(0, 5), 'new', ...nums(10).slice(5)])
    const hunks = diffLines(a, b)!
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines.filter((l) => l.kind === 'add')).toHaveLength(1)
    expect(hunks[0]!.lines.filter((l) => l.kind === 'del')).toHaveLength(0)
    expect(apply(a, hunks)).toBe(b)
  })

  it('handles removals only', () => {
    const a = text(nums(10))
    const b = text(nums(10).filter((_, i) => i !== 4))
    const hunks = diffLines(a, b)!
    expect(hunks[0]!.lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['line 5'])
    expect(apply(a, hunks)).toBe(b)
  })

  it('handles a change at the first line and at the last line', () => {
    const base = nums(12)
    const first = diffLines(text(base), text(['x', ...base.slice(1)]))!
    expect(first[0]!.oldStart).toBe(1)
    expect(first[0]!.newStart).toBe(1)
    expect(apply(text(base), first)).toBe(text(['x', ...base.slice(1)]))
    const last = diffLines(text(base), text([...base.slice(0, 11), 'x']))!
    expect(last[0]!.oldStart + last[0]!.oldLines - 1).toBe(12)
    expect(apply(text(base), last)).toBe(text([...base.slice(0, 11), 'x']))
  })

  it('handles an empty side', () => {
    const b = text(['a', 'b'])
    const added = diffLines('', b)!
    expect(added[0]!.header).toBe('@@ -0,0 +1,2 @@')
    expect(apply('', added)).toBe(b)
    const removed = diffLines(b, '')!
    expect(removed[0]!.header).toBe('@@ -1,2 +0,0 @@')
    expect(apply(b, removed)).toBe('')
  })

  it('uses 3 lines of context by default and a custom amount when given', () => {
    const a = text(nums(20))
    const b = text(nums(20).map((l, i) => (i === 9 ? 'changed' : l)))
    const def = diffLines(a, b)![0]!
    expect(kinds(def)).toBe('cccdaccc')
    expect(def.header).toBe('@@ -7,7 +7,7 @@')
    const one = diffLines(a, b, { context: 1 })![0]!
    expect(kinds(one)).toBe('cdac')
    expect(one.header).toBe('@@ -9,3 +9,3 @@')
    expect(kinds(diffLines(a, b, { context: 0 })![0]!)).toBe('da')
    expect(apply(a, diffLines(a, b, { context: 0 })!)).toBe(b)
  })

  it('splits distant changes into two hunks and merges close ones into one', () => {
    const base = nums(30)
    const far = base.map((l, i) => (i === 2 || i === 25 ? 'x' + i : l))
    const farHunks = diffLines(text(base), text(far))!
    expect(farHunks).toHaveLength(2)
    expect(apply(text(base), farHunks)).toBe(text(far))
    const near = base.map((l, i) => (i === 10 || i === 15 ? 'x' + i : l))
    const nearHunks = diffLines(text(base), text(near))!
    expect(nearHunks).toHaveLength(1)
    expect(apply(text(base), nearHunks)).toBe(text(near))
  })

  it('treats CRLF as a line break and does not flag lines that match apart from their ending', () => {
    expect(diffLines('a\r\nb\r\nc\r\n', 'a\nb\nc\n')).toEqual([])
    const hunks = diffLines('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')!
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b', 'B', 'c'])
  })

  it('marks a last line without a trailing newline and treats the missing newline as a change', () => {
    const noNl = diffLines('a\nb', 'a\nb\nc')!
    const dels = noNl[0]!.lines.filter((l) => l.kind === 'del')
    expect(dels.map((l) => l.text)).toEqual(['b'])
    expect(dels[0]!.noNewline).toBe(true)
    expect(noNl[0]!.lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['b', 'c'])
    const same = diffLines('a\nb', 'a\nb')
    expect(same).toEqual([])
    const flagged = diffLines('a\nb', 'a\nB')!
    expect(flagged[0]!.lines.at(-1)).toMatchObject({ kind: 'add', text: 'B', noNewline: true })
    const trailing = diffLines('a\nb\n', 'a\nb\n\n')!
    expect(trailing[0]!.lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual([''])
  })

  it('returns null when either side is over the line limit', () => {
    expect(TEXT_DIFF_MAX_LINES).toBe(2000)
    const ok = text(nums(TEXT_DIFF_MAX_LINES))
    const big = text(nums(TEXT_DIFF_MAX_LINES + 1))
    expect(diffLines(ok, ok + 'x\n')).toBeNull()
    expect(diffLines(big, 'a\n')).toBeNull()
    expect(diffLines('a\n', big)).toBeNull()
    expect(diffLines(ok, ok)).toEqual([])
  })

  it('diffs 1,500 lines with scattered changes quickly and correctly', () => {
    const base = nums(1500)
    const changed = base.map((l, i) => (i % 97 === 0 ? 'edit ' + i : l))
    changed.splice(700, 0, 'inserted')
    changed.splice(1200, 2)
    const start = performance.now()
    const hunks = diffLines(text(base), text(changed))!
    expect(performance.now() - start).toBeLessThan(1000)
    expect(hunks.length).toBeGreaterThan(10)
    expect(apply(text(base), hunks)).toBe(text(changed))
  })
})
