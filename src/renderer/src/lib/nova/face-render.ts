import type { FaceAssets } from './face-assets'
import type { FacePose } from './face-driver'

/** Small zoom so the sway never shows an edge of the portrait. */
const MARGIN = 1.012

/** The lip gap in px at a fractional level, when the manifest gives the gaps. */
function pxAt(assets: FaceAssets, level: number): number | undefined {
  const o = assets.mouthOpenings
  if (!o || o.length < 2) return undefined
  const lo = Math.min(o.length - 2, Math.floor(level))
  return o[lo]! + (o[lo + 1]! - o[lo]!) * (level - lo)
}

/** The vowel patch whose lip gap is closest to the mouth's current one (variants `-2`, `-3`... exist for some vowels). */
function vowelPatch(assets: FaceAssets, vowel: string, level: number): string {
  const ids = [`vowel-${vowel}`, `vowel-${vowel}-2`].filter((id) => assets.patches.has(id))
  if (ids.length < 2 || !assets.mouthOpenings) return ids[0] ?? `vowel-${vowel}`
  const px = pxAt(assets, level) ?? 0
  let best = ids[0]!
  for (const id of ids) {
    const gap = assets.openings.get(id) ?? 0
    if (Math.abs(gap - px) < Math.abs((assets.openings.get(best) ?? 0) - px)) best = id
  }
  return best
}

/** Draws one frame: base, then the blended mouth patches, then the eye patch. */
export function drawFace(
  ctx: CanvasRenderingContext2D,
  assets: FaceAssets,
  pose: FacePose,
  size: number,
  dpr: number
): void {
  const k = size / assets.baseSize
  const s = k * pose.scale * MARGIN
  const offset = (size - assets.baseSize * s) / 2
  ctx.setTransform(s, 0, 0, s, offset + pose.swayX * dpr, offset + pose.swayY * dpr)
  ctx.globalAlpha = 1
  ctx.clearRect(-size, -size, size * 3, size * 3)
  ctx.drawImage(assets.base, 0, 0)

  const patch = (id: string | undefined, alpha: number): void => {
    if (!id || alpha <= 0.003) return
    const found = assets.patches.get(id)
    if (!found) return
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.drawImage(found.image, found.rect[0], found.rect[1])
  }

  const top = assets.mouthLevels
  const level = Math.min(top, Math.max(0, pose.mouthLevel))
  const lo = Math.floor(level)
  const frac = level - lo
  // Pressed lips between syllables, fading out as the mouth opens.
  patch('mouth-closed', pose.closure * (1 - Math.min(1, level)))
  if (lo >= 1) {
    patch(`mouth-${lo}`, 1)
    if (lo < top) patch(`mouth-${lo + 1}`, frac)
  } else {
    patch('mouth-1', frac)
  }
  if (pose.mouthVowel && pose.vowelWeight > 0) {
    const id = vowelPatch(assets, pose.mouthVowel, level)
    // A vowel shape wider than the mouth is now would jump out of the cap; fade it in as the mouth reaches its gap.
    const gap = assets.openings.get(id)
    const px = pxAt(assets, level)
    const fit = gap && px !== undefined ? Math.min(1, px / gap) : 1
    patch(id, pose.vowelWeight * fit)
  }

  if (pose.blinkFrame) patch(pose.blinkFrame, 1)
  else if (pose.glance) patch(`glance-${pose.glance}`, pose.glanceAmount)
  ctx.globalAlpha = 1
}
