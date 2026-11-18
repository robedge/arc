/** Silero VAD v5 works on 512-sample frames at 16 kHz. */
export const VAD_FRAME_MS = 32
/** Raised rule while Nova speaks (N3): a high probability held for a while, so a cough or Nova's echo does not count. */
export const BARGE_IN_THRESHOLD = 0.65
export const BARGE_IN_MIN_MS = 400
/** Frames below the threshold that do not break a run of speech. */
export const BARGE_IN_MAX_GAP_FRAMES = 2

export interface BargeInRule {
  threshold: number
  minMs: number
  maxGapFrames: number
  frameMs: number
}

const DEFAULT_RULE: BargeInRule = {
  threshold: BARGE_IN_THRESHOLD,
  minMs: BARGE_IN_MIN_MS,
  maxGapFrames: BARGE_IN_MAX_GAP_FRAMES,
  frameMs: VAD_FRAME_MS
}

/** Decides from per-frame speech probabilities whether the user is talking over Nova. */
export class BargeInDetector {
  private readonly rule: BargeInRule
  /** Frames since the run began (including tolerated gaps), 0 when no run is open. */
  private span = 0
  private gap = 0

  constructor(rule: Partial<BargeInRule> = {}) {
    this.rule = { ...DEFAULT_RULE, ...rule }
  }

  /** Feeds one frame; true once the run of speech is long enough (and the detector starts over). */
  push(probability: number): boolean {
    if (probability >= this.rule.threshold) {
      this.span += this.gap + 1
      this.gap = 0
      if (this.span * this.rule.frameMs >= this.rule.minMs) {
        this.reset()
        return true
      }
      return false
    }
    if (this.span === 0) return false
    this.gap++
    if (this.gap > this.rule.maxGapFrames) this.reset()
    return false
  }

  reset(): void {
    this.span = 0
    this.gap = 0
  }
}
