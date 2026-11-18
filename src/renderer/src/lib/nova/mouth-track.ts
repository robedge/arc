/**
 * A mouth track for one synthesised sentence: how far the mouth should be open, and in which vowel
 * shape, at every 10 ms of the audio. It is computed from the samples before they play, so the face
 * can follow the audio clock instead of reacting to a loudness meter.
 *
 * The track follows syllables rather than loudness: energy peaks (syllable nuclei) open the mouth in
 * proportion to how loud they are, the dips between them close it, and silences shut it. A low/high
 * band split tells open vowels from spread ones and from sibilants.
 */

export type MouthVowel = 'aa' | 'ee' | 'neutral'

export interface Nucleus {
  /** Seconds from the start of the sentence, at the energy peak. */
  t: number
  /** Openness 0..1 reached here, after the small per-syllable variation. */
  open: number
  /** Loudness 0..1 before variation. */
  loud: number
  vowel: MouthVowel
}

export interface MouthSample {
  /** 0 (closed) to 1 (widest). */
  open: number
  /** Weight of the open-vowel shape, 0..1. */
  aa: number
  /** Weight of the spread-vowel shape, 0..1. */
  ee: number
  /** 1 while the lips are pressed shut between syllables, 0 otherwise. */
  closure: number
}

export interface MouthTrack {
  /** Seconds. */
  duration: number
  nuclei: readonly Nucleus[]
  /** The target at `t` seconds into the sentence; closed outside it. */
  sample(t: number): MouthSample
}

export interface MouthTrackOptions {
  /** Seeds the per-syllable variation; the same seed gives the same track. */
  seed?: number
}

/** The mouth moves this much ahead of the sound (seconds). */
export const MOUTH_LEAD_S = 0.04

export const CLOSED: MouthSample = { open: 0, aa: 0, ee: 0, closure: 0 }

const HOP_S = 0.01
const WINDOW_S = 0.025
/** Frames quieter than this are silence (RMS in dBFS). */
const SILENCE_DB = -48
/** Loudness 0 sits here, and 1 at the reference below. */
const FLOOR_DB = -38
/** The reference is half this fixed level and half the sentence's own 99th percentile, so one quiet sentence is not stretched to full. */
const GLOBAL_REF_DB = -10
const MIN_NUCLEUS_GAP_FRAMES = 9
const MIN_NUCLEUS_LOUD = 0.1
/** Below this loudness a segment's tail no longer holds the mouth open. */
const TAIL_LOUD = 0.12
const MIN_PROMINENCE = 0.1
/** Silences at least this long close the mouth and end a segment. */
const SILENCE_FRAMES = 6
/** Brightness (first-difference RMS over RMS: about 2 sin(pi f / fs)) bands. */
const AA_MAX_BRIGHT = 0.17
const EE_MIN_BRIGHT = 0.3
const SIBILANT_BRIGHT = 0.9
const SIBILANT_SCALE = 0.3
/** How far a shallow dip between two syllables stays open. */
const DIP_OPEN = 0.45
const DIP_CLOSES_BELOW = 0.25
const CLOSURE_BELOW = 0.12
const VARIATION = 0.1
const JITTER_S = 0.015
/** The mouth reaches its widest a little before the sound peaks. */
const ANTICIPATE_S = 0.015
const MIN_CONSECUTIVE_DIFF = 0.04

function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

interface Keyframe {
  t: number
  open: number
  vowel: MouthVowel
}

interface Frames {
  count: number
  db: Float32Array
  /** Squared first-difference energy over squared energy, as an amplitude ratio. */
  diffSq: Float32Array
  sq: Float32Array
}

function analyse(pcm: Float32Array, sampleRate: number): Frames {
  const hop = Math.max(1, Math.round(sampleRate * HOP_S))
  const half = Math.round((sampleRate * WINDOW_S) / 2)
  const count = Math.floor(pcm.length / hop) + 1
  const db = new Float32Array(count)
  const diffSq = new Float32Array(count)
  const sq = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const c = i * hop
    const from = Math.max(1, c - half)
    const to = Math.min(pcm.length - 1, c + half)
    let e = 0
    let d = 0
    for (let n = from; n <= to; n++) {
      const x = pcm[n]!
      const dx = x - pcm[n - 1]!
      e += x * x
      d += dx * dx
    }
    const len = Math.max(1, to - from + 1)
    sq[i] = e / len
    diffSq[i] = d / len
    db[i] = 10 * Math.log10(e / len + 1e-12)
  }
  return { count, db, diffSq, sq }
}

/** Brightness around a frame: how much of the energy sits high in the spectrum. */
function brightness(f: Frames, centre: number, radius: number): number {
  let e = 0
  let d = 0
  for (let i = Math.max(0, centre - radius); i <= Math.min(f.count - 1, centre + radius); i++) {
    e += f.sq[i]!
    d += f.diffSq[i]!
  }
  return e > 1e-12 ? Math.sqrt(d / e) : 0
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -120
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

function pickNuclei(env: Float32Array, from: number, to: number): number[] {
  const found: { i: number; v: number }[] = []
  for (let i = from; i <= to; i++) {
    const v = env[i]!
    if (v < MIN_NUCLEUS_LOUD) continue
    let isMax = true
    for (let j = Math.max(from, i - 4); j <= Math.min(to, i + 4); j++) {
      if (j < i ? env[j]! >= v : env[j]! > v) {
        isMax = false
        break
      }
    }
    if (!isMax) continue
    let leftMin = v
    for (let j = i - 1; j >= from && env[j]! <= v; j--) leftMin = Math.min(leftMin, env[j]!)
    let rightMin = v
    for (let j = i + 1; j <= to && env[j]! <= v; j++) rightMin = Math.min(rightMin, env[j]!)
    if (v - Math.max(leftMin, rightMin) >= MIN_PROMINENCE) found.push({ i, v })
  }
  found.sort((a, b) => b.v - a.v)
  const kept: number[] = []
  for (const { i } of found) {
    if (kept.every((k) => Math.abs(k - i) >= MIN_NUCLEUS_GAP_FRAMES)) kept.push(i)
  }
  return kept.sort((a, b) => a - b)
}

/** Computes the track for 24 kHz (or any rate) mono samples. */
export function computeMouthTrack(
  pcm: Float32Array,
  sampleRate: number,
  options: MouthTrackOptions = {}
): MouthTrack {
  const rng = mulberry32(options.seed ?? 1)
  const f = analyse(pcm, sampleRate)
  const n = f.count
  const duration = pcm.length / sampleRate

  const voiced: number[] = []
  for (let i = 0; i < n; i++) if (f.db[i]! >= SILENCE_DB) voiced.push(f.db[i]!)
  const ref = Math.max(FLOOR_DB + 10, 0.5 * GLOBAL_REF_DB + 0.5 * percentile(voiced, 0.99))
  const loud = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    loud[i] = f.db[i]! < SILENCE_DB ? 0 : clamp01((f.db[i]! - FLOOR_DB) / (ref - FLOOR_DB))
  }
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    env[i] = (loud[Math.max(0, i - 1)]! + loud[i]! + loud[Math.min(n - 1, i + 1)]!) / 3
  }

  // Segments: runs of sound, bridging silences shorter than SILENCE_FRAMES.
  const segments: [number, number][] = []
  let start = -1
  let lastLoud = -1
  for (let i = 0; i < n; i++) {
    if (f.db[i]! >= SILENCE_DB) {
      if (start < 0) start = i
      lastLoud = i
    } else if (start >= 0 && i - lastLoud >= SILENCE_FRAMES) {
      segments.push([start, lastLoud])
      start = -1
    }
  }
  if (start >= 0) segments.push([start, lastLoud])

  const nuclei: Nucleus[] = []
  const keyframes: Keyframe[][] = []
  let previousOpen = -1
  let direction = 1
  for (const [from, to] of segments) {
    let peaks = pickNuclei(env, from, to)
    if (peaks.length === 0) {
      let best = from
      for (let i = from; i <= to; i++) if (env[i]! > env[best]!) best = i
      if (env[best]! >= 0.05) peaks = [best]
    }
    const frames: Keyframe[] = [{ t: from * HOP_S, open: 0, vowel: 'neutral' }]
    peaks.forEach((p, k) => {
      const bright = brightness(f, p, 3)
      const vowel: MouthVowel =
        bright < AA_MAX_BRIGHT ? 'aa' : bright >= EE_MIN_BRIGHT ? 'ee' : 'neutral'
      const sibilant = bright >= SIBILANT_BRIGHT ? SIBILANT_SCALE : 1
      let open = clamp01(env[p]! * sibilant * (1 + (rng() * 2 - 1) * VARIATION))
      // Two syllables never look the same.
      if (previousOpen >= 0 && Math.abs(open - previousOpen) < MIN_CONSECUTIVE_DIFF) {
        const up = previousOpen + direction * MIN_CONSECUTIVE_DIFF
        open = up >= 0 && up <= 1 ? up : previousOpen - direction * MIN_CONSECUTIVE_DIFF
        direction = -direction
      }
      previousOpen = open
      nuclei.push({
        t: p * HOP_S,
        open,
        loud: env[p]!,
        vowel: sibilant < 1 ? 'neutral' : vowel
      })
      const jitter = (rng() * 2 - 1) * JITTER_S
      if (k > 0) {
        const prev = peaks[k - 1]!
        let valley = prev
        for (let i = prev; i <= p; i++) if (env[i]! < env[valley]!) valley = i
        const ratio = env[valley]! / Math.max(1e-6, Math.min(env[prev]!, env[p]!))
        const prevOpen = nuclei[nuclei.length - 2]!.open
        const dip =
          ratio < DIP_CLOSES_BELOW ? 0 : clamp01(ratio) * DIP_OPEN * Math.min(prevOpen, open)
        frames.push({ t: valley * HOP_S, open: dip, vowel: 'neutral' })
      }
      frames.push({
        t: p * HOP_S - ANTICIPATE_S + jitter,
        open,
        vowel: sibilant < 1 ? 'neutral' : vowel
      })
    })
    // The mouth is shut where the sound has faded to a murmur, not where it finally drops under the gate.
    let tail = to
    while (tail > from && env[tail]! < TAIL_LOUD) tail--
    frames.push({ t: (tail + 1) * HOP_S, open: 0, vowel: 'neutral' })
    // Keep the times increasing after jitter.
    for (let i = 1; i < frames.length; i++) {
      frames[i]!.t = Math.max(frames[i]!.t, frames[i - 1]!.t + 0.02)
    }
    keyframes.push(frames)
  }

  const open = new Float32Array(n)
  const aa = new Float32Array(n)
  const ee = new Float32Array(n)
  const closure = new Float32Array(n)
  for (const frames of keyframes) {
    let j = 0
    const first = Math.ceil(frames[0]!.t / HOP_S - 1e-9)
    const last = Math.min(n - 1, Math.floor(frames[frames.length - 1]!.t / HOP_S + 1e-9))
    for (let i = Math.max(0, first); i <= last; i++) {
      const t = i * HOP_S
      while (j < frames.length - 2 && t > frames[j + 1]!.t) j++
      const a = frames[j]!
      const b = frames[j + 1]!
      const u = clamp01((t - a.t) / Math.max(1e-6, b.t - a.t))
      const e = 0.5 - 0.5 * Math.cos(Math.PI * u)
      open[i] = a.open + (b.open - a.open) * e
      const wa =
        (a.vowel === 'aa' ? 1 : 0) + ((b.vowel === 'aa' ? 1 : 0) - (a.vowel === 'aa' ? 1 : 0)) * e
      const we =
        (a.vowel === 'ee' ? 1 : 0) + ((b.vowel === 'ee' ? 1 : 0) - (a.vowel === 'ee' ? 1 : 0)) * e
      aa[i] = wa
      ee[i] = we
    }
  }
  if (segments.length > 0) {
    const spanFrom = segments[0]![0]
    const spanTo = segments[segments.length - 1]![1]
    for (let i = spanFrom; i <= spanTo; i++) {
      closure[i] = clamp01(1 - open[i]! / CLOSURE_BELOW)
    }
  }

  const at = (arr: Float32Array, x: number): number => {
    const i = Math.floor(x)
    const a = arr[i] ?? 0
    const b = arr[i + 1] ?? 0
    return a + (b - a) * (x - i)
  }
  return {
    duration,
    nuclei,
    sample(t: number): MouthSample {
      const x = t / HOP_S
      if (!(x >= 0) || x > n - 1) return CLOSED
      return {
        open: at(open, x),
        aa: at(aa, x),
        ee: at(ee, x),
        closure: at(closure, x)
      }
    }
  }
}
