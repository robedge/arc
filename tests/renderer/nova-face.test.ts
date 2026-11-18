// @spec: 016-voice-companion
import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import NovaFace from '../../src/renderer/src/lib/components/nova/NovaFace.svelte'
import type { FaceAssets } from '../../src/renderer/src/lib/nova/face-assets'
import { setEngines } from '../../src/renderer/src/lib/nova/engines'
import { motion } from '../../src/renderer/src/lib/stores/motion.svelte'
import { nova } from '../../src/renderer/src/lib/stores/nova.svelte'

const base = { id: 'base' } as unknown as CanvasImageSource
const patch = (
  id: string
): { image: CanvasImageSource; rect: [number, number, number, number] } => ({
  image: { id } as unknown as CanvasImageSource,
  rect: [0, 0, 10, 10]
})
const assets: FaceAssets = {
  baseSize: 1024,
  base,
  patches: new Map(
    ['mouth-1', 'mouth-2', 'mouth-3', 'mouth-4', 'mouth-5', 'vowel-eee', 'blink-1', 'blink-2'].map(
      (id) => [id, patch(id)]
    )
  ),
  blinkSequence: ['blink-1', 'blink-2', 'blink-1'],
  blinkTimingsMs: [45, 70, 60],
  mouthLevels: 5,
  openings: new Map()
}

let drawn: unknown[] = []
let callbacks: FrameRequestCallback[] = []

beforeEach(() => {
  drawn = []
  callbacks = []
  const ctx = {
    setTransform: () => {},
    clearRect: () => {},
    drawImage: (image: unknown) => drawn.push(image),
    globalAlpha: 1
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => callbacks.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  setEngines({ player: { play: () => Promise.resolve(), flush: () => {}, level: 0.5 } })
  nova.state = 'speaking'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  nova.state = 'idle'
  setEngines()
  document.documentElement.removeAttribute('data-motion')
})

/** Runs `seconds` of animation frames at 60 fps. */
function advance(seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const next = callbacks
    callbacks = []
    for (const cb of next) cb(i * (1000 / 60))
  }
}

it('draws mouth patches while speaking (control for the base-only cases)', async () => {
  const { container } = render(NovaFace, { load: () => Promise.resolve(assets) })
  await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
  await tick()
  advance(2)
  expect(drawn.length).toBeGreaterThan(0)
  expect(drawn.some((image) => image !== base)).toBe(true)
})

it('draws only the base when reduced motion is on', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  const stop = motion.start()
  const { container } = render(NovaFace, { load: () => Promise.resolve(assets) })
  await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
  await tick()
  advance(15)
  expect(drawn.length).toBeGreaterThan(0)
  expect(drawn.every((image) => image === base)).toBe(true)
  stop()
})

it('shows the plain base image and logs once when the manifest fails', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { container } = render(NovaFace, { load: () => Promise.reject(new Error('no manifest')) })
  await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
  await tick()
  advance(3)
  expect(container.querySelector('canvas')).toBeNull()
  expect(container.querySelector('img[data-nova-plain]')).not.toBeNull()
  expect(drawn).toEqual([])
  expect(error).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
    "Nova's portrait"
  )
})

it('exposes the pose only when asked to', async () => {
  const { container, unmount } = render(NovaFace, {
    load: () => Promise.resolve(assets),
    exposePose: true
  })
  await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
  await tick()
  advance(1)
  expect(container.querySelector('[data-nova-pose]')?.getAttribute('data-nova-pose')).toContain(
    'mouthLevel'
  )
  unmount()
  const second = render(NovaFace, { load: () => Promise.resolve(assets) })
  await waitFor(() => expect(second.container.querySelector('canvas')).not.toBeNull())
  await tick()
  advance(1)
  expect(second.container.querySelector('[data-nova-pose]')).toBeNull()
})
