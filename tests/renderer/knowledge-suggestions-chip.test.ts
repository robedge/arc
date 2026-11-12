import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import KnowledgeSuggestionsChip from '../../src/renderer/src/lib/components/ui/KnowledgeSuggestionsChip.svelte'

afterEach(cleanup)

it('renders nothing at zero', () => {
  render(KnowledgeSuggestionsChip, { count: 0, onclick: vi.fn() })
  expect(document.querySelector('[data-knowledge-suggestions-chip]')).toBeNull()
})

it('shows the text and accessible name, and calls onclick', async () => {
  const onclick = vi.fn()
  render(KnowledgeSuggestionsChip, { count: 3, onclick })
  const button = screen.getByRole('button', { name: 'Knowledge suggestions, 3 waiting' })
  expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('Suggestions 3')
  expect(button.getAttribute('aria-haspopup')).toBe('dialog')
  await fireEvent.click(button)
  expect(onclick).toHaveBeenCalledOnce()
})

it('does not animate', () => {
  render(KnowledgeSuggestionsChip, { count: 2, onclick: vi.fn() })
  const button = document.querySelector('[data-knowledge-suggestions-chip]') as HTMLElement
  expect(button.className).not.toMatch(/animate|pulse/)
  expect(button.hasAttribute('data-pulse')).toBe(false)
})
