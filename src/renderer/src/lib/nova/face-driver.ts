import type { MouthSample } from './mouth-track'

export type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking'
export type FaceVowel = 'eee'
export type FaceGlance = 'left' | 'right' | 'up' | 'down' | 'upleft' | 'upright'

export interface FaceInput {
  /** Seconds since the previous step. */
  dt: number
  state: FaceState
  /** Speech loudness 0..1 (the playback analyser); used only when there is no mouth track. */
  speechLevel: number
  /** Where the mouth should be now, from the sentence's precomputed track (already on the audio clock). */
  mouth?: MouthSample
  /** Microphone loudness 0..1. */
  micLevel: number
  reduced: boolean
}

export interface FacePose {
  /** 0 (closed) to the manifest's top mouth level, fractional between mouth frames. */
  mouthLevel: number
  /** Displayed openness 0..1 before it is mapped to levels. */
  mouthOpen: number
  mouthVowel?: FaceVowel
  /** How strongly the vowel shape is blended over the mouth, 0..1. */
  vowelWeight: number
  /** Weight of the pressed-lips patch between syllables, 0..1. */
  closure: number
  blinkFrame?: string
  glance?: FaceGlance
  glanceAmount: number
  swayX: number
  swayY: number
  scale: number
  glow: number
}

export interface FaceDriver {
  step(input: FaceInput): FacePose
}

export interface FaceDriverOptions {
  blinkSequence?: readonly string[]
  blinkTimingsMs?: readonly number[]
  /** Number of mouth frames in the manifest (default 5). */
  mouthLevels?: number
  /** Inner-lip opening in px per level, index 0 being the closed base; makes level steps follow real gaps. */
  mouthOpenings?: readonly number[]
}

/** Below this the speech level is treated as silence (fallback path). */
const GATE = 0.015
/** Speech level that maps to the widest mouth (fallback path). */
const FULL = 0.25
/** Spring rates (rad/s) of the critically damped follower: a little quicker opening than closing. */
const OMEGA_OPEN = 45
const OMEGA_CLOSE = 32
/** Vowel and closure weights follow their targets with this time constant. */
const WEIGHT_EASE_S = 0.04
const VOWEL_MAX = 0.85
/** Openness at which a vowel shape is fully blended in. */
const VOWEL_FULL_AT = 0.6
const SETTLED = 0.003
/** The widest lip gap ever shown, in px at the manifest's base size (level 7 of the 12). The wider patches crop and show teeth. */
export const MAX_MOUTH_OPENING_PX = 40
/** Openness is shaped with this power so typical syllables sit mid-range (levels 3 to 5) and only the loudest approach the cap. */
const SHAPE_EXPONENT = 1.6

/** Openness 0..1 from the track to the fraction of the allowed opening that is shown: smooth, monotone, no plateau. */
export function shapeOpening(value: number): number {
  return Math.pow(Math.min(1, Math.max(0, value)), SHAPE_EXPONENT)
}
const BLINK_MIN_S = 3
const BLINK_MAX_S = 6
const GLANCE_MIN_S = 1.5
const GLANCE_MAX_S = 3
const GLANCE_EASE_S = 0.3
const GLANCES: readonly FaceGlance[] = ['left', 'right', 'up', 'down', 'upleft', 'upright']
const DEFAULT_SEQUENCE = ['blink-1', 'blink-2', 'blink-1'] as const
const DEFAULT_TIMINGS_MS = [45, 70, 60] as const

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (t: number): number => t * t * (3 - 2 * t)

export function createFaceDriver(
  rng: () => number = Math.random,
  options: FaceDriverOptions = {}
): FaceDriver {
  const sequence = options.blinkSequence ?? DEFAULT_SEQUENCE
  const timings = options.blinkTimingsMs ?? DEFAULT_TIMINGS_MS
  const between = (min: number, max: number): number => min + rng() * (max - min)

  let time = 0
  const levels = options.mouthLevels ?? 5
  const openings = options.mouthOpenings
  let open = 0
  let velocity = 0
  let ee = 0
  let closure = 0
  let blinkIn = between(BLINK_MIN_S, BLINK_MAX_S)
  let blinkAt = -1
  let glanceIn = between(GLANCE_MIN_S, GLANCE_MAX_S)
  let glanceDir: FaceGlance | undefined
  let glanceFrom = 0
  let glanceTo = 0
  let glanceT = 1
  let motion = 1

  const still: Pick<FacePose, 'swayX' | 'swayY' | 'scale' | 'glanceAmount'> = {
    swayX: 0,
    swayY: 0,
    scale: 1,
    glanceAmount: 0
  }

  function glowFor(input: FaceInput, speech: number): number {
    switch (input.state) {
      case 'listening':
        return clamp01(0.2 + clamp01(input.micLevel) * 1.6)
      case 'speaking':
        return clamp01(0.25 + speech * 0.75)
      case 'thinking':
        return input.reduced ? 0.5 : 0.5 + 0.25 * Math.sin((time * Math.PI * 2) / 2.4)
      case 'idle':
        return 0.18
    }
  }

  /** Maps openness to a fractional mouth level, through the manifest's lip gaps when they are known. */
  function levelFor(value: number): number {
    const shaped = shapeOpening(value)
    if (!openings || openings.length < 2) return shaped * levels
    const first = openings[0]!
    const top = Math.min(MAX_MOUTH_OPENING_PX, openings[openings.length - 1]!)
    const px = first + shaped * (top - first)
    for (let i = 1; i < openings.length; i++) {
      const hi = openings[i]!
      const lo = openings[i - 1]!
      if (px <= hi) return hi > lo ? i - 1 + clamp01((px - lo) / (hi - lo)) : i - 1
    }
    return levels
  }

  function resetMouth(): void {
    open = 0
    velocity = 0
    ee = 0
    closure = 0
  }

  function updateMouth(dt: number, input: FaceInput): void {
    const speaking = input.state === 'speaking'
    let target = 0
    let wantEe = 0
    let wantClosure = 0
    if (speaking && input.mouth) {
      target = clamp01(input.mouth.open)
      wantEe = clamp01(input.mouth.ee)
      wantClosure = clamp01(input.mouth.closure)
    } else if (speaking) {
      const raw = clamp01(input.speechLevel)
      target = raw < GATE ? 0 : clamp01(raw / FULL)
    }
    // Exact solution of a critically damped spring over dt, so a long frame cannot blow it up.
    const omega = target > open ? OMEGA_OPEN : OMEGA_CLOSE
    const e = open - target
    const decay = Math.exp(-omega * dt)
    const c = velocity + omega * e
    open = target + (e + c * dt) * decay
    velocity = (velocity - c * omega * dt) * decay
    if (open < 0) {
      open = 0
      velocity = 0
    }
    if (open > 1) {
      open = 1
      velocity = Math.min(0, velocity)
    }
    if (target === 0 && open < SETTLED && Math.abs(velocity) < 0.05) {
      open = 0
      velocity = 0
    }
    const k = 1 - Math.exp(-dt / WEIGHT_EASE_S)
    ee += (wantEe - ee) * k
    closure += (wantClosure - closure) * k
    if (ee < 0.002) ee = 0
    if (closure < 0.002) closure = 0
  }

  function updateBlink(dt: number): string | undefined {
    if (blinkAt >= 0) {
      blinkAt += dt * 1000
      let end = 0
      for (let i = 0; i < sequence.length; i++) {
        end += timings[i] ?? 60
        if (blinkAt < end) return sequence[i]
      }
      blinkAt = -1
      blinkIn = between(BLINK_MIN_S, BLINK_MAX_S)
      return undefined
    }
    blinkIn -= dt
    if (blinkIn > 0) return undefined
    if (open > 0.8) {
      blinkIn = between(BLINK_MIN_S, BLINK_MAX_S)
      return undefined
    }
    blinkAt = 0
    return sequence[0]
  }

  function updateGlance(dt: number, thinking: boolean): void {
    if (thinking) {
      glanceIn -= dt
      if (glanceIn <= 0) {
        glanceIn = between(GLANCE_MIN_S, GLANCE_MAX_S)
        glanceFrom = glanceAmountNow()
        glanceT = 0
        if (rng() < 0.3) glanceTo = 0
        else {
          glanceTo = 1
          glanceDir = GLANCES[Math.floor(rng() * GLANCES.length)]
        }
      }
    } else if (glanceTo !== 0) {
      glanceFrom = glanceAmountNow()
      glanceTo = 0
      glanceT = 0
    }
    if (glanceT < 1) glanceT = Math.min(1, glanceT + dt / GLANCE_EASE_S)
    if (glanceT >= 1 && glanceTo === 0) glanceDir = undefined
  }

  function glanceAmountNow(): number {
    return glanceFrom + (glanceTo - glanceFrom) * smooth(glanceT)
  }

  return {
    step(input) {
      const dt = Math.min(Math.max(input.dt, 0), 0.25)
      time += dt
      const speechRaw = input.state === 'speaking' ? clamp01(input.speechLevel) : 0
      if (input.reduced) {
        resetMouth()
        blinkAt = -1
        glanceDir = undefined
        glanceTo = 0
        glanceT = 1
        return {
          mouthLevel: 0,
          mouthOpen: 0,
          vowelWeight: 0,
          closure: 0,
          glow: glowFor(input, speechRaw < GATE ? 0 : Math.min(1, speechRaw / FULL)),
          ...still
        }
      }
      updateMouth(dt, input)
      const blinkFrame = updateBlink(dt)
      updateGlance(dt, input.state === 'thinking')
      const amount = glanceDir ? clamp01(glanceAmountNow()) : 0
      motion += ((input.state === 'idle' || input.state === 'listening' ? 1 : 0.6) - motion) * 0.05
      const pose: FacePose = {
        mouthLevel: levelFor(open),
        mouthOpen: open,
        vowelWeight: ee * Math.min(1, open / VOWEL_FULL_AT) * VOWEL_MAX,
        closure,
        glanceAmount: amount,
        swayX: Math.sin((time * Math.PI * 2) / 5) * 1.5 * motion,
        swayY: Math.sin((time * Math.PI * 2) / 7 + 1) * 1 * motion,
        scale: 1 + 0.003 * Math.sin((time * Math.PI * 2) / 4.5) * motion,
        glow: glowFor(input, input.state === 'speaking' ? open : 0)
      }
      if (ee > 0) pose.mouthVowel = 'eee'
      if (blinkFrame) pose.blinkFrame = blinkFrame
      if (glanceDir && amount > 0) pose.glance = glanceDir
      return pose
    }
  }
}
