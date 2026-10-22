import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import Panel from '../../src/renderer/src/lib/components/ui/Panel.svelte'

afterEach(cleanup)

const body = createRawSnippet(() => ({ render: () => '<p>content</p>' }))

it('renders two aria-hidden, non-interactive corner brackets by default', () => {
  const { container } = render(Panel, { children: body })
  const brackets = container.querySelectorAll('[data-bracket]')
  expect(brackets).toHaveLength(2)
  for (const b of brackets) expect(b.getAttribute('aria-hidden')).toBe('true')
})

it('omits brackets when brackets is none', () => {
  const { container } = render(Panel, { brackets: 'none', children: body })
  expect(container.querySelectorAll('[data-bracket]')).toHaveLength(0)
})

it('makes the body the scroller only when scroll is set', () => {
  const a = render(Panel, { scroll: true, children: body })
  const scrolling = a.container.querySelector('[data-panel-body]')!
  expect(scrolling.className).toContain('overflow-auto')
  expect(scrolling.className).toContain('min-h-0')
  expect(scrolling.className).toContain('flex-1')
  cleanup()
  const b = render(Panel, { children: body })
  expect(b.container.querySelector('[data-panel-body]')!.className).not.toContain('overflow-auto')
})

it('exposes tone, element, rest attributes and draw-in', () => {
  const { container } = render(Panel, {
    as: 'nav',
    tone: 'attention',
    drawIn: true,
    'aria-label': 'Groups',
    children: body
  })
  const root = container.querySelector('nav')!
  expect(root.getAttribute('aria-label')).toBe('Groups')
  expect(root.getAttribute('data-tone')).toBe('attention')
  expect(root.hasAttribute('data-draw-in')).toBe(true)
})

it('renders title, header and footer', () => {
  const header = createRawSnippet(() => ({ render: () => '<span>head</span>' }))
  const footer = createRawSnippet(() => ({ render: () => '<span>foot</span>' }))
  const { getByText } = render(Panel, { title: 'Items', header, footer, children: body })
  expect(getByText('Items')).toBeTruthy()
  expect(getByText('head')).toBeTruthy()
  expect(getByText('foot')).toBeTruthy()
})
