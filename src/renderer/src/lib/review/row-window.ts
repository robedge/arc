/** Top offset of every row plus the total height at the end (`heights.length + 1` entries). */
export function offsetsOf(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1)
  let sum = 0
  for (let i = 0; i < heights.length; i++) {
    out[i] = sum
    sum += heights[i] as number
  }
  out[heights.length] = sum
  return out
}

/** The row that contains vertical position `y`; clamped to the first and last row. */
export function rowAt(offsets: readonly number[], y: number): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((offsets[mid] as number) <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}
