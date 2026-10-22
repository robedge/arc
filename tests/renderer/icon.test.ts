import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import Icon from '../../src/renderer/src/lib/components/ui/Icon.svelte'
import { icons } from '../../src/renderer/src/lib/components/ui/icons'

afterEach(cleanup)

it('is decorative by default', () => {
  const { container } = render(Icon, { name: 'info' })
  const svg = container.querySelector('svg')!
  expect(svg.getAttribute('aria-hidden')).toBe('true')
  expect(svg.hasAttribute('role')).toBe(false)
  expect(svg.querySelectorAll('path').length).toBe(icons.info.length)
})

it('becomes role=img with an accessible name when titled', () => {
  render(Icon, { name: 'warning', title: 'Warning' })
  const img = screen.getByRole('img', { name: 'Warning' })
  expect(img.hasAttribute('aria-hidden')).toBe(false)
})
