import { describe, expect, it } from 'vitest'
import {
  lineOfRow,
  rowCount,
  rowOffsets,
  rowsInWindow,
  wrapLine,
  wrapLines
} from '../../src/renderer/src/lib/components/sessions/terminal-wrap'

describe('terminal soft wrapping', () => {
  it('leaves short and empty lines alone, and never wraps at Infinity columns', () => {
    expect(wrapLine('abc', 10)).toEqual(['abc'])
    expect(wrapLine('', 10)).toEqual([''])
    expect(wrapLine('x'.repeat(5000), Infinity)).toHaveLength(1)
  })

  it('splits a long line by column count and loses no characters', () => {
    const line = 'abcdefghijklmnopqrstuvwxyz'
    const rows = wrapLine(line, 10)
    expect(rows).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz'])
    expect(rows.join('')).toBe(line)
    expect(rowCount(line, 10)).toBe(3)
  })

  it('repeats the indent on continuation rows without exceeding the width', () => {
    const line = '  ↳ helper (Review): Read /a/very/long/path.ts'
    const rows = wrapLine(line, 20)
    expect(rows[0]).toBe(line.slice(0, 20))
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(20)
    for (const r of rows.slice(1)) expect(r.startsWith('  ')).toBe(true)
    expect(rows.map((r, i) => (i ? r.slice(2) : r)).join('')).toBe(line)
    expect(rows).toHaveLength(rowCount(line, 20))
  })

  it('marks continuation rows and maps rows back to lines', () => {
    const rows = wrapLines(['short', 'x'.repeat(25), ''], 10)
    expect(rows.map((r) => [r.line, r.continuation])).toEqual([
      [0, false],
      [1, false],
      [1, true],
      [1, true],
      [2, false]
    ])
  })

  it('computes offsets and renders only a window of rows', () => {
    const lines = ['a', 'b'.repeat(25), 'c', 'd']
    const offsets = rowOffsets(lines, 10)
    expect([...offsets]).toEqual([0, 1, 4, 5, 6])
    expect(lineOfRow(offsets, 0)).toBe(0)
    expect(lineOfRow(offsets, 3)).toBe(1)
    expect(lineOfRow(offsets, 4)).toBe(2)
    const window = rowsInWindow(lines, offsets, 10, 2, 5)
    expect(window.map((r) => r.text)).toEqual(['bbbbbbbbbb', 'bbbbb', 'c'])
    expect(rowsInWindow(lines, offsets, 10, 0, 6)).toEqual(wrapLines(lines, 10))
  })

  it('handles a large buffer quickly', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i} ` + 'x'.repeat(i % 300))
    const start = performance.now()
    const offsets = rowOffsets(lines, 80)
    expect(offsets[lines.length]).toBeGreaterThan(lines.length)
    expect(performance.now() - start).toBeLessThan(500)
  })
})
