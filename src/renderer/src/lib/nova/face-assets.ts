import manifestData from '../../assets/nova/manifest.json'

export interface FaceFrame {
  id: string
  kind: 'mouth' | 'blink' | 'glance'
  level?: number
  /** Inner-lip gap in px at baseSize. */
  opening?: number
  variant?: number
  vowel?: string
  dir?: string
  src: string
  rect: [number, number, number, number]
  feather: number
}

export interface FaceManifest {
  version: number
  mouthLevels?: number
  /** Inner-lip gap of the base mouth (level 0). */
  mouthBaseOpening?: number
  baseSize: number
  bases: { id: string; src: string }[]
  frames: FaceFrame[]
  blinkSequence: string[]
  blinkTimingsMs: number[]
}

export interface FacePatch {
  image: CanvasImageSource
  rect: [number, number, number, number]
}

export interface FaceAssets {
  baseSize: number
  base: CanvasImageSource
  /** Patches by manifest id (mouth-3, vowel-eee, blink-1, glance-left, ...). */
  patches: ReadonlyMap<string, FacePatch>
  blinkSequence: readonly string[]
  blinkTimingsMs: readonly number[]
  /** Number of numbered mouth frames. */
  mouthLevels: number
  /** Lip gap in px for levels 0..mouthLevels when the manifest gives them all, else undefined. */
  mouthOpenings?: readonly number[]
  /** Lip gap of a patch by id (vowel variants), when known. */
  openings: ReadonlyMap<string, number>
}

const urls = import.meta.glob('../../assets/nova/*.webp', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

function urlFor(src: string): string {
  const url = urls[`../../assets/nova/${src}`]
  if (!url) throw new Error(`missing face image ${src}`)
  return url
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`face image failed: ${url}`))
    image.src = url
  })
}

/** Loads the base and every patch listed in the manifest; rejects if any of it is missing. */
export async function loadFaceAssets(
  manifest: FaceManifest = manifestData as FaceManifest
): Promise<FaceAssets> {
  const baseEntry = manifest.bases[0]
  if (!baseEntry) throw new Error('face manifest has no base')
  const [base, ...loaded] = await Promise.all([
    loadImage(urlFor(baseEntry.src)),
    ...manifest.frames.map((frame) => loadImage(urlFor(frame.src)))
  ])
  const patches = new Map<string, FacePatch>()
  manifest.frames.forEach((frame, i) => {
    patches.set(frame.id, { image: loaded[i]!, rect: frame.rect })
  })
  const mouths = manifest.frames
    .filter((f) => f.kind === 'mouth' && f.level !== undefined)
    .sort((a, b) => a.level! - b.level!)
  const mouthLevels = manifest.mouthLevels ?? mouths.length
  const gaps = mouths.map((f) => f.opening)
  const complete = mouths.length === mouthLevels && gaps.every((g) => typeof g === 'number')
  const openings = new Map<string, number>()
  for (const frame of manifest.frames) {
    if (frame.opening !== undefined) openings.set(frame.id, frame.opening)
  }
  return {
    mouthLevels,
    mouthOpenings: complete ? [manifest.mouthBaseOpening ?? 0, ...(gaps as number[])] : undefined,
    openings,
    baseSize: manifest.baseSize,
    base: base!,
    patches,
    blinkSequence: manifest.blinkSequence,
    blinkTimingsMs: manifest.blinkTimingsMs
  }
}
