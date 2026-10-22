import { afterEach, expect, it, vi } from 'vitest'
import { motion } from '../../src/renderer/src/lib/stores/motion.svelte'

type Listener = (e: MediaQueryListEvent) => void

function mockMatchMedia(matches: boolean): { fire: (m: boolean) => void; remove: () => void } {
  let listener: Listener | null = null
  const remove = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      addEventListener: (_: string, l: Listener) => (listener = l),
      removeEventListener: (_: string, l: Listener) => {
        remove()
        if (listener === l) listener = null
      }
    }))
  })
  return { fire: (m) => listener?.({ matches: m } as MediaQueryListEvent), remove }
}

afterEach(() => {
  document.documentElement.removeAttribute('data-motion')
})

it('reduced is true and data-motion is set when the media query matches', () => {
  mockMatchMedia(true)
  const stop = motion.start()
  expect(motion.reduced).toBe(true)
  expect(document.documentElement.getAttribute('data-motion')).toBe('reduced')
  stop()
})

it('reduced is false and data-motion absent when it does not match', () => {
  mockMatchMedia(false)
  const stop = motion.start()
  expect(motion.reduced).toBe(false)
  expect(document.documentElement.hasAttribute('data-motion')).toBe(false)
  stop()
})

it('follows change events and stops listening on cleanup', () => {
  const mm = mockMatchMedia(false)
  const stop = motion.start()
  mm.fire(true)
  expect(motion.reduced).toBe(true)
  expect(document.documentElement.getAttribute('data-motion')).toBe('reduced')
  mm.fire(false)
  expect(motion.reduced).toBe(false)
  expect(document.documentElement.hasAttribute('data-motion')).toBe(false)
  stop()
  expect(mm.remove).toHaveBeenCalledOnce()
})
