import { describe, expect, it } from 'vitest'
import {
  createFaceDriver,
  MAX_MOUTH_OPENING_PX,
  shapeOpening,
  type FaceInput,
  type FacePose,
  type FaceState
} from '../../src/renderer/src/lib/nova/face-driver'

const DT = 1 / 60

function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function run(
  seconds: number,
  input: (t: number) => Partial<FaceInput> & { state: FaceState },
  seed = 1
): FacePose[] {
  const driver = createFaceDriver(seeded(seed))
  const poses: FacePose[] = []
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t = i * DT
    poses.push(driver.step({ dt: DT, speechLevel: 0, micLevel: 0, reduced: false, ...input(t) }))
  }
  return poses
}

const speak = (level: (t: number) => number) => (t: number) => ({
  state: 'speaking' as const,
  speechLevel: level(t)
})

const closed = { open: 0, aa: 0, ee: 0, closure: 0 }
const sample = (open: number, extra: Partial<typeof closed> = {}): typeof closed => ({
  ...closed,
  open,
  ...extra
})

const talk = (mouth: (t: number) => typeof closed) => (t: number) => ({
  state: 'speaking' as const,
  mouth: mouth(t)
})

const maxStep = (poses: FacePose[]): number => {
  let max = 0
  for (let i = 1; i < poses.length; i++)
    max = Math.max(max, Math.abs(poses[i]!.mouthOpen - poses[i - 1]!.mouthOpen))
  return max
}

describe('face driver mouth motion', () => {
  it('never snaps: a step in the target moves at most 30 % of the range per frame at 60 fps', () => {
    const track = run(
      1.5,
      talk((t) => sample(t < 0.5 ? 0 : 1))
    )
    expect(maxStep(track)).toBeLessThanOrEqual(0.3)
    expect(maxStep(track)).toBeGreaterThan(0.05)
    // The live-level fallback is smooth too.
    const live = run(1.5, (t) => ({ state: 'speaking', speechLevel: t < 0.5 ? 0 : 0.3 }))
    expect(maxStep(live)).toBeLessThanOrEqual(0.3)
  })

  it('follows a slow ramp continuously, with no quantised plateaus', () => {
    for (const poses of [
      run(
        2,
        talk((t) => sample(Math.min(1, t / 1.8)))
      ),
      run(2, (t) => ({ state: 'speaking', speechLevel: 0.02 + 0.23 * Math.min(1, t / 1.8) }))
    ]) {
      const moving = poses.slice(12, 100)
      for (let i = 1; i < moving.length; i++) {
        expect(moving[i]!.mouthOpen).toBeGreaterThan(moving[i - 1]!.mouthOpen)
      }
      expect(new Set(moving.map((p) => p.mouthOpen.toFixed(4))).size).toBe(moving.length)
    }
  })

  it('reaches 80 % of a target step within 80 ms and settles on it', () => {
    const poses = run(
      1.5,
      talk((t) => sample(t < 0.5 ? 0 : 1))
    )
    const from = Math.round(0.5 / DT)
    const within = poses[from + Math.round(0.08 / DT)]!
    expect(within.mouthOpen).toBeGreaterThanOrEqual(0.8)
    expect(poses[poses.length - 1]!.mouthOpen).toBeGreaterThan(0.995)
    expect(Math.max(...poses.map((p) => p.mouthOpen))).toBeLessThanOrEqual(1.0001)
  })

  it('closes within 150 ms of a pause, a little slower than it opens', () => {
    const poses = run(
      2,
      talk((t) => sample(t < 1 ? 1 : 0))
    )
    const from = Math.round(1 / DT)
    expect(poses[from + Math.round(0.15 / DT)]!.mouthOpen).toBeLessThan(0.12)
    expect(poses[poses.length - 1]!.mouthLevel).toBe(0)
    const up = run(
      1,
      talk(() => sample(1))
    )
    const rise = up.findIndex((p) => p.mouthOpen >= 0.9)
    const fall = poses.slice(from).findIndex((p) => p.mouthOpen <= 0.1)
    expect(fall).toBeGreaterThan(rise)
  })

  const settle = (opts: Parameters<typeof createFaceDriver>[1], open: number): FacePose => {
    const driver = createFaceDriver(seeded(1), opts)
    let pose: FacePose | undefined
    for (let i = 0; i < 120; i++) {
      pose = driver.step({
        dt: DT,
        state: 'speaking',
        speechLevel: 0,
        micLevel: 0,
        reduced: false,
        mouth: sample(open)
      })
    }
    return pose!
  }
  const GAPS = [0.1, 3.3, 10, 15.8, 21.5, 27.8, 34.2, 40.3, 46.4, 53, 59, 65.1, 71.2]
  const pxOf = (level: number): number => {
    const lo = Math.min(GAPS.length - 2, Math.floor(level))
    return GAPS[lo]! + (GAPS[lo + 1]! - GAPS[lo]!) * (level - lo)
  }

  it('maps the shaped openness over the manifest levels when there are no lip gaps', () => {
    expect(settle({ mouthLevels: 12 }, 0.5).mouthLevel).toBeCloseTo(shapeOpening(0.5) * 12, 1)
    expect(settle({ mouthLevels: 12 }, 1).mouthLevel).toBeCloseTo(12, 1)
  })

  it('uses the manifest opening values, monotonically, and never opens past the cap', () => {
    const opts = { mouthLevels: 4, mouthOpenings: [0, 10, 30, 60, 100] }
    // The cap (40 px) lies between level 2 (30) and level 3 (60).
    const half = shapeOpening(0.5) * MAX_MOUTH_OPENING_PX
    expect(settle(opts, 0.5).mouthLevel).toBeCloseTo(1 + (half - 10) / 20, 1)
    const seen: number[] = []
    for (let i = 0; i <= 20; i++) seen.push(settle(opts, i / 20).mouthLevel)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
    expect(seen.at(-1)!).toBeCloseTo(2 + (MAX_MOUTH_OPENING_PX - 30) / 30, 2)
  })

  it('caps the displayed opening at 40 px for the real 12-level manifest, even for a huge burst', () => {
    expect(MAX_MOUTH_OPENING_PX).toBe(40)
    const opts = { mouthLevels: 12, mouthOpenings: GAPS }
    const driver = createFaceDriver(seeded(1), opts)
    let max = 0
    for (let i = 0; i < 240; i++) {
      const pose = driver.step({
        dt: DT,
        state: 'speaking',
        speechLevel: 0,
        micLevel: 0,
        reduced: false,
        mouth: sample(i < 120 ? 50 : 1, { ee: 1 })
      })
      max = Math.max(max, pxOf(pose.mouthLevel))
      expect(pose.mouthLevel).toBeLessThanOrEqual(7)
    }
    expect(max).toBeLessThanOrEqual(MAX_MOUTH_OPENING_PX + 1e-6)
    expect(max).toBeGreaterThan(39)
  })

  it('puts typical syllables at levels 3 to 5 (16 to 28 px) and compresses near the top without a plateau', () => {
    const opts = { mouthLevels: 12, mouthOpenings: GAPS }
    const typical = [0.6, 0.7, 0.8].map((o) => pxOf(settle(opts, o).mouthLevel))
    for (const px of typical) {
      expect(px).toBeGreaterThanOrEqual(15)
      expect(px).toBeLessThanOrEqual(29)
    }
    const top = [0.9, 0.95, 1].map((o) => pxOf(settle(opts, o).mouthLevel))
    expect(top[1]!).toBeGreaterThan(top[0]! + 0.5)
    expect(top[2]!).toBeGreaterThan(top[1]! + 0.5)
  })

  it('blends the spread vowel in by a weight that grows with openness, and never uses the open-vowel shape', () => {
    const at = (open: number): FacePose =>
      run(
        1,
        talk(() => sample(open, { ee: 1 }))
      ).at(-1)!
    const small = at(0.2)
    const wide = at(1)
    expect(wide.mouthVowel).toBe('eee')
    expect(wide.vowelWeight).toBeGreaterThan(small.vowelWeight + 0.2)
    expect(wide.vowelWeight).toBeLessThanOrEqual(0.9)
    const aa = run(
      1,
      talk(() => sample(1, { aa: 1 }))
    )
    expect(aa.every((p) => p.mouthVowel === undefined && p.vowelWeight < 0.05)).toBe(true)
    const none = run(
      1,
      talk(() => sample(0.8))
    ).at(-1)!
    expect(none.vowelWeight).toBeLessThan(0.05)
  })

  it('reports closures between syllables and none while open', () => {
    const shut = run(
      1,
      talk(() => sample(0, { closure: 1 }))
    ).at(-1)!
    expect(shut.closure).toBeGreaterThan(0.8)
    const open = run(
      1,
      talk(() => sample(0.8))
    ).at(-1)!
    expect(open.closure).toBeLessThan(0.05)
  })

  it('falls back to the live level when there is no track, and stays closed under the gate', () => {
    const loud = run(1, (t) => ({ state: 'speaking', speechLevel: t < 0 ? 0 : 0.3 }))
    expect(loud.at(-1)!.mouthOpen).toBeGreaterThan(0.9)
    const quiet = run(1, () => ({ state: 'speaking', speechLevel: 0.01 }))
    expect(Math.max(...quiet.map((p) => p.mouthOpen))).toBe(0)
    const paused = run(3, (t) => ({ state: 'speaking', speechLevel: t < 1 ? 0.3 : 0 }))
    expect(paused.at(-1)!.mouthLevel).toBe(0)
  })

  it('keeps the mouth closed when not speaking, and in reduced motion', () => {
    const listening = run(2, () => ({ state: 'listening', speechLevel: 0.5, mouth: sample(1) }))
    expect(Math.max(...listening.map((p) => p.mouthLevel))).toBe(0)
    const reduced = run(2, () => ({
      state: 'speaking',
      speechLevel: 0.5,
      mouth: sample(1, { aa: 1 }),
      reduced: true
    }))
    expect(
      reduced.every((p) => p.mouthLevel === 0 && p.mouthOpen === 0 && p.vowelWeight === 0)
    ).toBe(true)
  })
})

describe('face driver blinks and glances', () => {
  it('blinks every 3 to 6 seconds with the manifest sequence', () => {
    const poses = run(90, () => ({ state: 'idle' }))
    const starts: number[] = []
    const frames: string[] = []
    poses.forEach((p, i) => {
      if (p.blinkFrame && !poses[i - 1]?.blinkFrame) starts.push(i * DT)
      if (p.blinkFrame && frames[frames.length - 1] !== p.blinkFrame) frames.push(p.blinkFrame)
    })
    expect(starts.length).toBeGreaterThanOrEqual(15)
    expect(starts.length).toBeLessThanOrEqual(30)
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]! - starts[i - 1]!
      expect(gap).toBeGreaterThanOrEqual(3)
      expect(gap).toBeLessThanOrEqual(6.4)
    }
    expect(frames.slice(0, 3)).toEqual(['blink-1', 'blink-2', 'blink-1'])
  })

  it('never blinks above level 4 and blinks soon after the mouth relaxes', () => {
    const poses = run(
      40,
      speak((t) => (t < 30 ? 0.5 : 0))
    )
    const loud = poses.slice(0, 30 * 60)
    expect(loud.some((p) => p.blinkFrame)).toBe(false)
    expect(poses.slice(30 * 60 + 60).some((p) => p.blinkFrame)).toBe(true)
  })

  it('glances while thinking and returns to centre afterwards', () => {
    const poses = run(40, () => ({ state: 'thinking' }))
    const dirs: string[] = []
    for (const p of poses) if (p.glance && dirs[dirs.length - 1] !== p.glance) dirs.push(p.glance)
    expect(dirs.length).toBeGreaterThanOrEqual(3)
    expect(poses.every((p) => p.glanceAmount >= 0 && p.glanceAmount <= 1)).toBe(true)
    expect(Math.max(...poses.map((p) => p.glanceAmount))).toBeGreaterThan(0.95)
    const idle = run(20, (t) => ({ state: t < 10 ? 'thinking' : 'idle' }))
    expect(idle.slice(12 * 60).every((p) => p.glance === undefined)).toBe(true)
    expect(run(20, () => ({ state: 'idle' })).every((p) => p.glance === undefined)).toBe(true)
  })
})

describe('face driver motion and glow', () => {
  it('sways about 1 to 2 px with a 0.3 % breath when idle', () => {
    const poses = run(20, () => ({ state: 'idle' }))
    const maxX = Math.max(...poses.map((p) => Math.abs(p.swayX)))
    expect(maxX).toBeGreaterThan(1)
    expect(maxX).toBeLessThanOrEqual(2)
    expect(Math.max(...poses.map((p) => p.scale))).toBeLessThanOrEqual(1.0031)
    expect(Math.max(...poses.map((p) => p.scale))).toBeGreaterThan(1.002)
  })

  it('drives the glow from the mic when listening and speech when speaking', () => {
    const quiet = run(1, () => ({ state: 'listening', micLevel: 0 }))
    const loud = run(1, () => ({ state: 'listening', micLevel: 0.6 }))
    expect(loud[30]!.glow).toBeGreaterThan(quiet[30]!.glow + 0.3)
    const talk = run(
      1,
      speak(() => 0.3)
    )
    const hush = run(
      1,
      speak(() => 0)
    )
    expect(talk[59]!.glow).toBeGreaterThan(hush[59]!.glow + 0.3)
    const idle = run(5, () => ({ state: 'idle' }))
    expect(new Set(idle.map((p) => p.glow)).size).toBe(1)
  })

  it('reduced motion: base only, no blink, glance or sway, glow still changes', () => {
    const states: FaceState[] = ['idle', 'listening', 'thinking', 'speaking']
    for (const state of states) {
      const poses = run(30, () => ({ state, speechLevel: 0.4, micLevel: 0.4, reduced: true }))
      for (const p of poses) {
        expect(p.mouthLevel).toBe(0)
        expect(p.mouthVowel).toBeUndefined()
        expect(p.mouthOpen).toBe(0)
        expect(p.blinkFrame).toBeUndefined()
        expect(p.glance).toBeUndefined()
        expect(p.glanceAmount).toBe(0)
        expect(p.swayX).toBe(0)
        expect(p.swayY).toBe(0)
        expect(p.scale).toBe(1)
        expect(p.glow).toBeGreaterThan(0)
      }
    }
    const lit = run(1, () => ({ state: 'listening', micLevel: 0.6, reduced: true }))
    const dark = run(1, () => ({ state: 'listening', micLevel: 0, reduced: true }))
    expect(lit[10]!.glow).toBeGreaterThan(dark[10]!.glow)
  })
})
