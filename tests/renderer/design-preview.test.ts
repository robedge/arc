import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import DesignPreview from '../../src/renderer/src/lib/preview/DesignPreview.svelte'

beforeEach(() => {
  Object.defineProperty(window, 'arc', {
    configurable: true,
    get() {
      throw new Error('DesignPreview must not touch window.arc')
    }
  })
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).arc
})

it('labels samples and has the Design Preview heading', () => {
  render(DesignPreview)
  expect(screen.getByRole('heading', { name: 'Design Preview' })).toBeTruthy()
  expect(screen.getAllByText('Sample').length).toBeGreaterThan(10)
})

it('opens the attention dialog with one permission and one question; Escape keeps count 2', async () => {
  render(DesignPreview)
  const badge = screen.getByRole('button', { name: 'Needs attention, 2 waiting' })
  expect(badge.querySelector('[data-count]')?.textContent).toBe('2')
  await fireEvent.click(badge)
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelectorAll('[data-kind="permission"]')).toHaveLength(1)
  expect(dialog.querySelectorAll('[data-kind="question"]')).toHaveLength(1)
  expect(within(dialog).getByText('git push origin arc/fix-order-sync')).toBeTruthy()
  await fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Needs attention, 2 waiting' }).querySelector('[data-count]')
      ?.textContent
  ).toBe('2')
})

it('shows the knowledge suggestions block: chip counts, diff snippet and one card per state', async () => {
  const { container } = render(DesignPreview)
  const chips = ['1', '3', '12'].map((n) =>
    screen.getByRole('button', { name: `Knowledge suggestions, ${n} waiting` })
  )
  expect(chips.map((c) => c.querySelector('[data-count]')?.textContent)).toEqual(['1', '3', '12'])
  await fireEvent.click(chips[1]!)

  const block = container.querySelector('[data-preview-knowledge-suggestions]') as HTMLElement
  expect(block).toBeTruthy()
  const snippets = block.querySelectorAll('[data-diff-snippet]')
  expect(snippets.length).toBeGreaterThanOrEqual(2)
  expect(block.querySelector('[data-diff-snippet] [data-diff-separator]')).toBeTruthy()

  const cards = block.querySelectorAll('[data-knowledge-suggestion]')
  expect(cards.length).toBeGreaterThanOrEqual(11)
  for (const state of [
    'new',
    'update',
    'too-large',
    'changed',
    'missing',
    'name-taken',
    'save-failed',
    'storage-busy',
    'unsaved-edits',
    'failed',
    'busy',
    'editing'
  ]) {
    expect(block.querySelector(`[data-preview-card="${state}"]`), state).toBeTruthy()
  }
  expect(block.querySelector('[data-current-note]')).toBeTruthy()
  expect(block.querySelector('[data-knowledge-suggestion-editor]')).toBeTruthy()
  expect(block.querySelector('[data-too-large]')).toBeTruthy()
})
