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

it('shows the attachments block: chip states, a long row, notices, the warning and the drop overlay', () => {
  const { container } = render(DesignPreview)
  const block = container.querySelector('[data-preview-attachments]') as HTMLElement
  expect(block).toBeTruthy()
  expect(
    within(block.closest('section') ?? container).getAllByText('Attachments').length
  ).toBeGreaterThan(0)

  const states = (scope: string): string[] =>
    Array.from(
      block.querySelectorAll(`[data-preview-attachments-${scope}] [data-attachment-chip]`)
    ).map((chip) => (chip as HTMLElement).dataset.attachmentState ?? '')
  const draft = states('chips')
  expect(draft).toEqual(expect.arrayContaining(['ready', 'staging', 'error']))
  expect(
    block.querySelectorAll('[data-preview-attachments-chips] [data-attachment-chip]').length
  ).toBe(5)
  expect(block.querySelector('[data-preview-attachments-sent] [data-attachment-remove]')).toBeNull()
  expect(
    block.querySelectorAll('[data-preview-attachments-sent] [data-attachment-chip]').length
  ).toBe(3)

  expect(
    block.querySelectorAll('[data-preview-attachments-long] [data-attachment-item]').length
  ).toBe(10)

  for (const text of [
    "notes.exe can't be attached. Arc accepts images, PDFs and text files.",
    'huge.png is too large. The limit is 20 MB.',
    'A message can have at most 10 attachments.',
    "Folders can't be attached.",
    "broken.txt couldn't be read.",
    'and 2 more were refused.',
    "Codex can't read PDFs. It will be sent as a file the brain may not be able to open."
  ]) {
    expect(within(block).getAllByText(text).length).toBeGreaterThan(0)
  }
  expect(within(block).getByText('Drop to attach')).toBeTruthy()
})
