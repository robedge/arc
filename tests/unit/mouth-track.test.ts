// @spec: 016-voice-companion
import { describe, expect, it } from 'vitest'
import { computeMouthTrack } from '../../src/renderer/src/lib/nova/mouth-track'

const RATE = 24000

interface Burst {
  /** Centre in seconds. */
  at: number
  amp: number
  /** Sine frequency; low is open-vowel like, high is spread-vowel or sibilant like. */
  hz: number
  len?: number
}

/** A signal of silence with sin-windowed bursts, each shaped like a syllable. */
function synth(seconds: number, bursts: Burst[]): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE))
  for (const b of bursts) {
    const len = b.len ?? 0.16
    const from = Math.round((b.at - len / 2) * RATE)
    const n = Math.round(len * RATE)
    for (let i = 0; i < n; i++) {
      const w = Math.sin((Math.PI * i) / n) ** 2
      const idx = from + i
      if (idx >= 0 && idx < pcm.length) {
        pcm[idx] = (pcm[idx] ?? 0) + b.amp * w * Math.sin((2 * Math.PI * b.hz * idx) / RATE)
      }
    }
  }
  return pcm
}

const peakOpen = (
  track: ReturnType<typeof computeMouthTrack>,
  from: number,
  to: number
): number => {
  let max = 0
  for (let t = from; t <= to; t += 0.005) max = Math.max(max, track.sample(t).open)
  return max
}

describe('mouth track', () => {
  it('keeps the mouth closed for silence and for a noise floor under the gate', () => {
    const silent = computeMouthTrack(new Float32Array(RATE * 2), RATE)
    expect(silent.nuclei).toEqual([])
    expect(peakOpen(silent, 0, 2)).toBe(0)
    const hiss = new Float32Array(RATE * 2)
    for (let i = 0; i < hiss.length; i++) hiss[i] = 0.0008 * Math.sin(i * 1.7)
    expect(peakOpen(computeMouthTrack(hiss, RATE), 0, 2)).toBe(0)
  })

  it('finds one syllable nucleus per burst, at the burst centres', () => {
    const centres = [0.3, 0.62, 0.95, 1.4, 1.75]
    const track = computeMouthTrack(
      synth(
        2.2,
        centres.map((at) => ({ at, amp: 0.3, hz: 400 }))
      ),
      RATE,
      { seed: 1 }
    )
    expect(track.nuclei).toHaveLength(centres.length)
    track.nuclei.forEach((n, i) => expect(Math.abs(n.t - centres[i]!)).toBeLessThanOrEqual(0.03))
  })

  it('opens further for louder bursts', () => {
    const track = computeMouthTrack(
      synth(1.5, [
        { at: 0.3, amp: 0.3, hz: 400 },
        { at: 0.7, amp: 0.08, hz: 400 },
        { at: 1.1, amp: 0.02, hz: 400 }
      ]),
      RATE,
      { seed: 2 }
    )
    const [loud, mid, soft] = [0.3, 0.7, 1.1].map((at) => peakOpen(track, at - 0.05, at + 0.05))
    expect(loud).toBeGreaterThan(mid! + 0.1)
    expect(mid).toBeGreaterThan(soft! + 0.05)
    expect(loud).toBeLessThanOrEqual(1)
    expect(loud).toBeGreaterThan(0.6)
  })

  it('closes in the dips between bursts and fully in silences', () => {
    const track = computeMouthTrack(
      synth(2, [
        { at: 0.3, amp: 0.3, hz: 400 },
        { at: 0.6, amp: 0.3, hz: 400 },
        { at: 1.5, amp: 0.3, hz: 400 }
      ]),
      RATE,
      { seed: 3 }
    )
    expect(peakOpen(track, 0.28, 0.32)).toBeGreaterThan(0.5)
    // Between the first two the signal dips to silence for about 60 ms.
    expect(track.sample(0.45).open).toBeLessThan(0.12)
    // Silence: from the third burst's neighbours the mouth is shut.
    for (const t of [0.0, 0.05, 0.9, 1.0, 1.2, 1.9]) expect(track.sample(t).open).toBe(0)
    expect(track.sample(0.45).closure).toBeGreaterThan(0.3)
  })

  it('tags low bursts aa and bright bursts ee, and opens less for a quiet hiss', () => {
    const track = computeMouthTrack(
      synth(2, [
        { at: 0.3, amp: 0.3, hz: 350 },
        { at: 0.8, amp: 0.3, hz: 2800 },
        { at: 1.3, amp: 0.3, hz: 600 }
      ]),
      RATE,
      { seed: 4 }
    )
    expect(track.nuclei.map((n) => n.vowel)).toEqual(['aa', 'ee', 'aa'])
    expect(track.sample(0.3).aa).toBeGreaterThan(0.5)
    expect(track.sample(0.3).ee).toBeLessThan(0.1)
    expect(track.sample(0.8).ee).toBeGreaterThan(0.5)
    const sibilant = computeMouthTrack(
      synth(1, [
        { at: 0.3, amp: 0.3, hz: 400 },
        { at: 0.7, amp: 0.05, hz: 7000 }
      ]),
      RATE,
      { seed: 4 }
    )
    expect(peakOpen(sibilant, 0.65, 0.75)).toBeLessThan(peakOpen(sibilant, 0.25, 0.35) * 0.5)
  })

  it('is deterministic for a seed, varies a little between seeds, and never repeats a syllable exactly', () => {
    const pcm = synth(
      2,
      [0.3, 0.7, 1.1, 1.5].map((at) => ({ at, amp: 0.25, hz: 450 }))
    )
    const a = computeMouthTrack(pcm, RATE, { seed: 7 })
    const b = computeMouthTrack(pcm, RATE, { seed: 7 })
    const c = computeMouthTrack(pcm, RATE, { seed: 8 })
    const dump = (t: typeof a): number[] =>
      Array.from({ length: 200 }, (_, i) => t.sample(i * 0.01).open)
    expect(dump(a)).toEqual(dump(b))
    expect(dump(a)).not.toEqual(dump(c))
    const peaks = a.nuclei.map((n) => n.open)
    for (let i = 1; i < peaks.length; i++)
      expect(Math.abs(peaks[i]! - peaks[i - 1]!)).toBeGreaterThan(0.01)
    // Variation stays within about 10 % of the loudness-driven value.
    const spread = Math.max(...peaks) / Math.min(...peaks)
    expect(spread).toBeLessThan(1.35)
  })

  it('samples out of range as closed', () => {
    const track = computeMouthTrack(synth(1, [{ at: 0.5, amp: 0.3, hz: 400 }]), RATE)
    expect(track.sample(-1).open).toBe(0)
    expect(track.sample(99).open).toBe(0)
  })
})
