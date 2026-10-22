import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import TitleBar from '../../src/renderer/src/lib/components/ui/TitleBar.svelte'

afterEach(cleanup)

it('renders a full-width drag region sized by the titlebar token', () => {
  const { container } = render(TitleBar)
  const bar = container.querySelector('[data-titlebar]')!
  expect(bar.classList.contains('drag-region')).toBe(true)
  expect(bar.className).toContain('--size-titlebar')
  expect(bar.className).toContain('w-full')
})
