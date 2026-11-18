// @spec: 016-voice-companion
import { describe, expect, it } from 'vitest'
import { createFaceDriver } from '../../src/renderer/src/lib/nova/face-driver'
import { computeMouthTrack, MOUTH_LEAD_S } from '../../src/renderer/src/lib/nova/mouth-track'

const RATE = 24000

function bursts(centres: number[]): Float32Array {
  const pcm = new Float32Array(RATE * 3)
  for (const c of centres) {
    const from = Math.round((c - 0.08) * RATE)
    const n = Math.round(0.16 * RATE)
    for (let i = 0; i < n; i++) {
      pcm[from + i] =
        0.3 * Math.sin((Math.PI * i) / n) ** 2 * Math.sin((2 * Math.PI * 400 * (from + i)) / RATE)
    }
  }
  return pcm
}

describe('mouth follows the audio clock', () => {
  it('the displayed opening peaks at or slightly before each nucleus, never after', () => {
    const centres = [0.4, 0.8, 1.3, 1.7, 2.3]
    const track = computeMouthTrack(bursts(centres), RATE, { seed: 5 })
    const driver = createFaceDriver(() => 0.5)
    const dt = 1 / 120
    const shown: { t: number; open: number }[] = []
    for (let t = 0; t < 3; t += dt) {
      const pose = driver.step({
        dt,
        state: 'speaking',
        speechLevel: 0,
        micLevel: 0,
        reduced: false,
        mouth: track.sample(t + MOUTH_LEAD_S)
      })
      shown.push({ t, open: pose.mouthOpen })
    }
    expect(track.nuclei).toHaveLength(centres.length)
    for (const nucleus of track.nuclei) {
      const near = shown.filter((s) => Math.abs(s.t - nucleus.t) < 0.07)
      const peak = near.reduce((a, b) => (b.open > a.open ? b : a))
      expect(peak.t - nucleus.t).toBeLessThanOrEqual(0.01)
      expect(peak.t - nucleus.t).toBeGreaterThanOrEqual(-0.06)
    }
  })
})
