import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import Wordmark from '../../src/renderer/src/lib/components/ui/Wordmark.svelte'
import { motion } from '../../src/renderer/src/lib/stores/motion.svelte'

function setReduced(matches: boolean): () => void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }))
  })
  return motion.start()
}

afterEach(cleanup)

it('renders ARC with a spinning ring', () => {
  const stop = setReduced(false)
  const { container } = render(Wordmark)
  expect(screen.getByText('ARC')).toBeTruthy()
  const ring = container.querySelector('svg')!
  expect(ring.getAttribute('aria-hidden')).toBe('true')
  expect(ring.hasAttribute('data-spin')).toBe(true)
  stop()
})

it('does not spin when motion is reduced', () => {
  const stop = setReduced(true)
  const { container } = render(Wordmark)
  expect(container.querySelector('svg')!.hasAttribute('data-spin')).toBe(false)
  stop()
  setReduced(false)()
})
