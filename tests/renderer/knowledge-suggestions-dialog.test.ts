import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import KnowledgeSuggestionsDialog from '../../src/renderer/src/lib/components/knowledge-suggestions/KnowledgeSuggestionsDialog.svelte'
import { knowledgeSuggestions as store } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import type { KnowledgeSuggestionView } from '../../src/shared/types/knowledge-suggestion'
import { mockArc } from './helpers'

const navigate = vi.hoisted(() => ({ openKnowledgeItem: vi.fn() }))
vi.mock('../../src/renderer/src/lib/navigate-knowledge', () => navigate)

const outcome = {
  groupId: 'g1',
  sectionId: 'sec',
  sectionName: 'Notes',
  itemId: 'i1',
  name: 'Service map.md',
  edited: false
}

const make = (id: string, createdAt: number): KnowledgeSuggestionView => ({
  id,
  sessionId: 's1',
  kind: 'new',
  title: `Title ${id}`,
  reason: `Reason ${id}`,
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'Service map.md', relPath: null },
  text: `Text ${id}`,
  createdAt
})

beforeEach(() => {
  navigate.openKnowledgeItem.mockReset()
  mockArc((channel) => ({ ok: true, data: channel.endsWith(':accept') ? outcome : undefined }))
  store.reset()
  store.setSnapshot('s1', [make('old', 1), make('new', 2)])
  store.open()
})
afterEach(() => {
  cleanup()
  store.reset()
})

it('is named and lists cards newest first with their content', () => {
  render(KnowledgeSuggestionsDialog)
  expect(screen.getByRole('dialog', { name: 'Knowledge suggestions' })).toBeTruthy()
  const cards = [...document.querySelectorAll('[data-knowledge-suggestion]')]
  expect(cards.map((c) => c.getAttribute('data-knowledge-suggestion'))).toEqual(['new', 'old'])
  expect(screen.getByText('Title new')).toBeTruthy()
  expect(screen.getByText('Reason new')).toBeTruthy()
  expect(screen.getByText('Text new')).toBeTruthy()
  expect(screen.getAllByText('Notes › New note: Service map')).toHaveLength(2)
})

it('Discard removes a card', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Discard: Title new' }))
  await waitFor(() => expect(screen.queryByText('Title new')).toBeNull())
  expect(screen.getByText('Title old')).toBeTruthy()
})

it('closes when the list empties with nothing to confirm', async () => {
  render(KnowledgeSuggestionsDialog)
  store.apply({ sessionId: 's1', waiting: [] })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(store.dialogOpen).toBe(false)
})

it('Escape closes', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('moves focus to the next card after a discard so the keyboard keeps working and Escape closes', async () => {
  render(KnowledgeSuggestionsDialog)
  const discard = screen.getByRole('button', { name: 'Discard: Title new' })
  discard.focus()
  await fireEvent.click(discard)
  await waitFor(() => expect(screen.queryByText('Title new')).toBeNull())
  const next = screen.getByRole('button', { name: 'Accept: Title old' })
  await waitFor(() => expect(document.activeElement).toBe(next))
  await fireEvent.keyDown(next, { key: 'Escape' })
  expect(store.dialogOpen).toBe(false)
})

async function acceptOnly(): Promise<void> {
  store.setSnapshot('s1', [make('only', 1)])
  render(KnowledgeSuggestionsDialog)
  const accept = screen.getByRole('button', { name: 'Accept: Title only' })
  accept.focus()
  await fireEvent.click(accept)
}

it('accepting the only card keeps the dialog open with the confirmation and the empty line', async () => {
  await acceptOnly()
  await waitFor(() => expect(screen.queryByText('Title only')).toBeNull())
  expect(screen.getByRole('dialog', { name: 'Knowledge suggestions' })).toBeTruthy()
  const row = document.querySelector('[data-knowledge-suggestion-confirmation]')
  expect(row?.getAttribute('role')).toBe('status')
  expect(row?.textContent).toContain('Added to Notes › Service map')
  expect(screen.getByRole('button', { name: /^Open/ })).toBeTruthy()
  expect(screen.getByText('No suggestions waiting.')).toBeTruthy()
})

it('keeps the dialog open when the pushed empty list arrives before the reply', async () => {
  let release: (r: unknown) => void = () => {}
  mockArc(() => new Promise((resolve) => (release = resolve)) as never)
  store.setSnapshot('s1', [make('only', 1)])
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Accept: Title only' }))
  store.apply({ sessionId: 's1', waiting: [] })
  await new Promise((r) => setTimeout(r, 20))
  expect(screen.getByRole('dialog')).toBeTruthy()
  release({ ok: true, data: outcome })
  await waitFor(() => expect(screen.getByText(/Added to Notes/)).toBeTruthy())
})

it('moves focus to the confirmation Open button when no card remains', async () => {
  await acceptOnly()
  const open = await screen.findByRole('button', { name: /^Open/ })
  await waitFor(() => expect(document.activeElement).toBe(open))
})

it('moves focus to the next card Accept after an accept', async () => {
  render(KnowledgeSuggestionsDialog)
  const accept = screen.getByRole('button', { name: 'Accept: Title new' })
  accept.focus()
  await fireEvent.click(accept)
  const next = await screen.findByRole('button', { name: 'Accept: Title old' })
  await waitFor(() => expect(document.activeElement).toBe(next))
})

it('Open navigates with the outcome', async () => {
  await acceptOnly()
  await fireEvent.click(await screen.findByRole('button', { name: /^Open/ }))
  expect(navigate.openKnowledgeItem).toHaveBeenCalledWith(outcome)
})

it('shows a problem on the card and keeps it listed', async () => {
  mockArc(() => ({ ok: false, error: { code: 'ITEM_NAME_TAKEN' } }))
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Accept: Title new' }))
  expect(await screen.findByText('A note with this name already exists.')).toBeTruthy()
  expect(screen.getByText('Title new')).toBeTruthy()
})

it('Escape closes after an accept and clears the confirmations', async () => {
  await acceptOnly()
  await screen.findByText(/Added to Notes/)
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(store.confirmations).toEqual([])
})

it('discarding the only card still closes the dialog', async () => {
  store.setSnapshot('s1', [make('only', 1)])
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Discard: Title only' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
