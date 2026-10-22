import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeltaBatcher, IntervalBatcher } from '../../../src/main/sessions/batcher'
import type { DeltaBatch } from '../../../src/main/sessions/batcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function makeBatcher(maxBytes?: number): { batcher: DeltaBatcher; out: DeltaBatch[] } {
  const out: DeltaBatch[] = []
  let seq = 0
  const batcher = new DeltaBatcher({
    onFlush: (b) => out.push(b),
    nextSeq: () => (seq += 1),
    ...(maxBytes !== undefined ? { maxBytes } : {})
  })
  return { batcher, out }
}

describe('DeltaBatcher', () => {
  it('coalesces deltas into one push every 50 ms, with an increasing seq', () => {
    const { batcher, out } = makeBatcher()
    for (let i = 0; i < 10; i++) {
      batcher.push(7, `w${i} `)
      vi.advanceTimersByTime(4)
    }
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(10)
    expect(out).toEqual([{ messageId: 7, seq: 1, text: 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 ' }])
    batcher.push(7, 'tail')
    vi.advanceTimersByTime(50)
    expect(out.map((b) => b.seq)).toEqual([1, 2])
    expect(out[1]?.text).toBe('tail')
  })

  it('flushes at once when 4 KB is pending', () => {
    const { batcher, out } = makeBatcher()
    batcher.push(1, 'a'.repeat(4000))
    expect(out).toHaveLength(0)
    batcher.push(1, 'b'.repeat(200))
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toHaveLength(4200)
  })

  it('flushes the pending chunk of one message before starting another', () => {
    const { batcher, out } = makeBatcher()
    batcher.push(1, 'one')
    batcher.push(2, 'two')
    batcher.flush()
    expect(out.map((b) => [b.messageId, b.text, b.seq])).toEqual([
      [1, 'one', 1],
      [2, 'two', 2]
    ])
  })
})

describe('IntervalBatcher', () => {
  it('hands items over every 100 ms', () => {
    const out: number[][] = []
    const batcher = new IntervalBatcher<number>((items) => out.push(items))
    batcher.add(1)
    vi.advanceTimersByTime(60)
    batcher.add(2)
    vi.advanceTimersByTime(40)
    expect(out).toEqual([[1, 2]])
  })
})
