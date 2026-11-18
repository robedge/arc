// @spec: 016-voice-companion
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toneFor } from '../../src/renderer/src/lib/nova/engines'
import { loadFaceAssets, type FaceManifest } from '../../src/renderer/src/lib/nova/face-assets'
import { computeMouthTrack } from '../../src/renderer/src/lib/nova/mouth-track'

const RATE = 24000

describe('fake speech', () => {
  it('closes between the fake syllables and has a pause of 200 ms or more', () => {
    const sentence = 'Here is the first sentence of the answer, long enough to hum.'
    const tone = toneFor(sentence)
    expect(toneFor(sentence)).toEqual(tone)
    expect(tone.length).toBe(Math.round((RATE * (250 + sentence.length * 40)) / 1000))
    const track = computeMouthTrack(tone, RATE)
    expect(track.nuclei.length).toBeGreaterThan(4)
    let longest = 0
    let run = 0
    for (let t = 0; t < track.duration; t += 0.01) {
      run = track.sample(t).open < 0.02 ? run + 0.01 : 0
      longest = Math.max(longest, run)
    }
    expect(longest).toBeGreaterThanOrEqual(0.2)
    const vowels = new Set(track.nuclei.map((n) => n.vowel))
    expect(vowels.has('aa') || vowels.has('ee')).toBe(true)
  })
})

describe('manifest levels', () => {
  it('reads the level count and lip gaps from the manifest, not a fixed five', async () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({
      id: `mouth-${i + 1}`,
      kind: 'mouth' as const,
      level: i + 1,
      opening: 3 + i * 6,
      src: 'base.webp',
      rect: [0, 0, 1, 1] as [number, number, number, number],
      feather: 1
    }))
    const manifest: FaceManifest = {
      version: 2,
      mouthLevels: 12,
      mouthBaseOpening: 0.1,
      baseSize: 1024,
      bases: [{ id: 'base', src: 'base.webp' }],
      frames,
      blinkSequence: [],
      blinkTimingsMs: []
    }
    const original = globalThis.Image
    globalThis.Image = class {
      onload: (() => void) | undefined
      set src(_: string) {
        queueMicrotask(() => this.onload?.())
      }
    } as unknown as typeof Image
    try {
      const assets = await loadFaceAssets(manifest)
      expect(assets.mouthLevels).toBe(12)
      expect(assets.mouthOpenings).toHaveLength(13)
      expect(assets.mouthOpenings![0]).toBe(0.1)
      expect(assets.mouthOpenings![12]).toBe(69)
    } finally {
      globalThis.Image = original
    }
  })
})

describe('the open-vowel patch is gone', () => {
  const dir = join(process.cwd(), 'src/renderer/src')
  it('is neither in the manifest nor on disk nor referenced by face code', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'assets/nova/manifest.json'), 'utf8'))
    expect(JSON.stringify(manifest)).not.toContain('aaa')
    expect(existsSync(join(dir, 'assets/nova/vowel-aaa.webp'))).toBe(false)
    for (const file of ['face-driver.ts', 'face-render.ts', 'face-assets.ts']) {
      expect(readFileSync(join(dir, 'lib/nova', file), 'utf8')).not.toMatch(/aaa/)
    }
  })
})
