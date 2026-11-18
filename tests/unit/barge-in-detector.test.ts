// @spec: 016-voice-companion
import { describe, expect, it } from 'vitest'
import { BargeInDetector } from '../../src/renderer/src/lib/nova/audio/barge-in'

/** Feeds frames; returns the index (0-based) of the frame that fired, or -1. */
function feed(detector: BargeInDetector, frames: number[]): number {
  for (let i = 0; i < frames.length; i++) if (detector.push(frames[i]!)) return i
  return -1
}
const speech = (frames: number): number[] => Array<number>(frames).fill(0.9)
const quiet = (frames: number): number[] => Array<number>(frames).fill(0.1)

describe('barge-in detector', () => {
  it('fires after 400 ms of continuous speech (13 frames of 32 ms)', () => {
    expect(feed(new BargeInDetector(), speech(20))).toBe(12)
  })

  it('does not fire for a short blip (200 ms)', () => {
    expect(feed(new BargeInDetector(), [...speech(6), ...quiet(30)])).toBe(-1)
  })

  it('does not count probabilities between 0.5 and 0.65 (Nova leaking into the mic)', () => {
    expect(feed(new BargeInDetector(), Array<number>(60).fill(0.6))).toBe(-1)
  })

  it('tolerates up to two frames below the threshold inside the run', () => {
    expect(feed(new BargeInDetector(), [...speech(5), ...quiet(2), ...speech(10)])).toBeGreaterThan(
      0
    )
  })

  it('a gap of three frames starts the run over', () => {
    expect(feed(new BargeInDetector(), [...speech(8), ...quiet(3), ...speech(8)])).toBe(-1)
  })

  it('starts over after firing', () => {
    const detector = new BargeInDetector()
    expect(feed(detector, speech(13))).toBe(12)
    expect(feed(detector, speech(5))).toBe(-1)
  })
})
