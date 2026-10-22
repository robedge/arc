import { expect, it, vi } from 'vitest'
import { createStreamBuffer } from '../../src/renderer/src/lib/stores/stream-buffer'

function manual() {
  const queue: Array<() => void> = []
  return {
    schedule: (cb: () => void) => queue.push(cb),
    cancel: () => {},
    runFrame: () => queue.splice(0).forEach((cb) => cb()),
    size: () => queue.length
  }
}

it('coalesces many deltas for one message into a single flush per frame', () => {
  const frame = manual()
  const onFlush = vi.fn()
  const buf = createStreamBuffer(onFlush, frame.schedule, frame.cancel)
  buf.push(1, 'He')
  buf.push(1, 'llo')
  buf.push(1, '!')
  expect(frame.size()).toBe(1)
  expect(onFlush).not.toHaveBeenCalled()
  frame.runFrame()
  expect(onFlush).toHaveBeenCalledTimes(1)
  expect(onFlush).toHaveBeenCalledWith(1, 'Hello!')
})

it('keeps messages separate and flush() delivers immediately', () => {
  const frame = manual()
  const onFlush = vi.fn()
  const buf = createStreamBuffer(onFlush, frame.schedule, frame.cancel)
  buf.push(1, 'a')
  buf.push(2, 'b')
  buf.flush()
  expect(onFlush.mock.calls).toEqual([
    [1, 'a'],
    [2, 'b']
  ])
  buf.push(1, 'c')
  frame.runFrame()
  expect(onFlush).toHaveBeenLastCalledWith(1, 'c')
})
