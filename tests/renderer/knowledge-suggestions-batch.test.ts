import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import KnowledgeSuggestionsDialog from '../../src/renderer/src/lib/components/knowledge-suggestions/KnowledgeSuggestionsDialog.svelte'
import { knowledgeSuggestions as store } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import type { KnowledgeSuggestionView } from '../../src/shared/types/knowledge-suggestion'
import { mockArc } from './helpers'

vi.mock('../../src/renderer/src/lib/navigate-knowledge', () => ({ openKnowledgeItem: vi.fn() }))

const outcomeFor = (id: string): Record<string, unknown> => ({
  groupId: 'g1',
  sectionId: 'sec',
  sectionName: 'Notes',
  itemId: `i-${id}`,
  name: `${id}.md`,
  edited: false
})

const make = (id: string, createdAt: number): KnowledgeSuggestionView => ({
  id,
  sessionId: 's1',
  kind: 'new',
  title: `Title ${id}`,
  reason: `Reason ${id}`,
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: `${id}.md`, relPath: null },
  text: `Text ${id}`,
  createdAt
})

const three = (): KnowledgeSuggestionView[] => [make('a', 1), make('b', 2), make('c', 3)]

beforeEach(() => {
  mockArc(() => ({ ok: true, data: undefined }))
  store.reset()
  store.setSnapshot('s1', [make('a', 1), make('b', 2)])
  store.open()
})
afterEach(() => {
  cleanup()
  store.reset()
})

const btn = (name: string): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

it('shows no batch buttons with one waiting suggestion', () => {
  store.setSnapshot('s1', [make('a', 1)])
  render(KnowledgeSuggestionsDialog)
  expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Discard all' })).toBeNull()
  expect(btn('Close')).toBeTruthy()
})

it('shows both batch buttons before Close with two waiting', () => {
  render(KnowledgeSuggestionsDialog)
  const names = [...document.querySelectorAll('[data-knowledge-suggestions-footer] button')].map(
    (b) => b.textContent?.trim()
  )
  expect(names).toEqual(['Accept all', 'Discard all', 'Close'])
})

it('disables both while editing', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Edit: Title b' }))
  expect(btn('Accept all').disabled).toBe(true)
  expect(btn('Discard all').disabled).toBe(true)
})

it('disables both while a batch runs', async () => {
  let release: (r: unknown) => void = () => {}
  mockArc(() => new Promise((resolve) => (release = resolve)) as never)
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Accept all'))
  await waitFor(() => expect(btn('Accept all').disabled).toBe(true))
  expect(btn('Discard all').disabled).toBe(true)
  release({ ok: true, data: { results: [] } })
  await waitFor(() => expect(btn('Accept all').disabled).toBe(false))
})

it('Accept all applies three: confirmations, empty list, dialog stays open', async () => {
  store.setSnapshot('s1', three())
  const invoke = mockArc((channel) =>
    channel === 'knowledge-suggestions:accept-all'
      ? {
          ok: true,
          data: {
            results: ['a', 'b', 'c'].map((id) => ({ id, outcome: outcomeFor(id) }))
          }
        }
      : { ok: true, data: undefined }
  )
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Accept all'))
  await waitFor(() =>
    expect(document.querySelectorAll('[data-knowledge-suggestion-confirmation]')).toHaveLength(3)
  )
  expect(invoke).toHaveBeenCalledWith('knowledge-suggestions:accept-all', { sessionId: 's1' })
  expect(document.querySelectorAll('[data-knowledge-suggestion]')).toHaveLength(0)
  expect(screen.getByText('No suggestions waiting.')).toBeTruthy()
  expect(screen.getByRole('dialog', { name: 'Knowledge suggestions' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull()
})

it('a partial result leaves the failed cards with their problems', async () => {
  store.setSnapshot('s1', three())
  mockArc((channel) => {
    if (channel === 'knowledge-suggestions:accept-all') {
      return {
        ok: true,
        data: {
          results: [
            { id: 'a', error: { code: 'ITEM_NAME_TAKEN' } },
            { id: 'b', error: { code: 'EXTERNAL_MODIFIED' } },
            { id: 'c', outcome: outcomeFor('c') }
          ]
        }
      }
    }
    return { ok: true, data: undefined }
  })
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Accept all'))
  await waitFor(() =>
    expect(document.querySelectorAll('[data-knowledge-suggestion-confirmation]')).toHaveLength(1)
  )
  expect(document.querySelectorAll('[data-knowledge-suggestion]')).toHaveLength(2)
  expect(screen.getByText('This note has changed since the suggestion was made.')).toBeTruthy()
  expect(screen.getAllByText('A note with this name already exists.').length).toBeGreaterThan(0)
  // The name-taken card opens its editor, as after a single accept.
  expect(store.editingId).toBe('a')
  expect(store.problems['b']).toEqual({ kind: 'changed' })
})

it('SUGGESTION_NOT_FOUND in a batch drops the card quietly', async () => {
  mockArc((channel) =>
    channel === 'knowledge-suggestions:accept-all'
      ? {
          ok: true,
          data: {
            results: [
              { id: 'a', error: { code: 'SUGGESTION_NOT_FOUND' } },
              { id: 'b', outcome: outcomeFor('b') }
            ]
          }
        }
      : { ok: true, data: undefined }
  )
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Accept all'))
  await waitFor(() => expect(store.list).toHaveLength(0))
  expect(store.problems).toEqual({})
})

it('unsaved edits on any card stop the whole batch before it runs', async () => {
  itemDraft.itemId = 'i-existing'
  itemDraft.dirty = true
  const update = {
    ...make('b', 2),
    kind: 'update' as const,
    target: { itemId: 'i-existing', name: 'x.md', relPath: 'x.md' }
  }
  store.setSnapshot('s1', [make('a', 1), update])
  const invoke = mockArc(() => ({ ok: true, data: { results: [] } }))
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Accept all'))
  expect(invoke).not.toHaveBeenCalled()
  expect(store.problems['b']).toEqual({ kind: 'unsaved-edits' })
  expect(store.list).toHaveLength(2)
  itemDraft.itemId = null
  itemDraft.dirty = false
})

it('a failed Accept all call keeps the cards and shows a toast', async () => {
  const show = vi.spyOn(toasts, 'show')
  mockArc(() => ({ ok: false, error: { code: 'IO_FAILED' } }))
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Accept all'))
  await waitFor(() => expect(show).toHaveBeenCalled())
  expect(store.list).toHaveLength(2)
  show.mockRestore()
})

it('Discard all shows the inline confirmation with the count and focuses Keep', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Discard all'))
  const footer = document.querySelector('[data-knowledge-suggestions-footer]') as HTMLElement
  expect(footer.textContent).toContain('Discard all 2 suggestions?')
  expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(btn('Keep')))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
})

it('Keep restores the footer, invokes nothing and refocuses Discard all', async () => {
  const invoke = mockArc(() => ({ ok: true, data: undefined }))
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Discard all'))
  await fireEvent.click(btn('Keep'))
  expect(invoke).not.toHaveBeenCalled()
  expect(btn('Accept all')).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(btn('Discard all')))
  expect(store.list).toHaveLength(2)
})

it('Discard invokes the channel, empties the list and closes the dialog', async () => {
  const invoke = mockArc(() => ({ ok: true, data: undefined }))
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Discard all'))
  await fireEvent.click(btn('Discard'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(invoke).toHaveBeenCalledWith('knowledge-suggestions:discard-all', { sessionId: 's1' })
  expect(store.list).toEqual([])
})

it('a failed Discard all restores the cards, keeps the dialog open and toasts', async () => {
  const show = vi.spyOn(toasts, 'show')
  mockArc(() => ({ ok: false, error: { code: 'IO_FAILED' } }))
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Discard all'))
  await fireEvent.click(btn('Discard'))
  await waitFor(() => expect(show).toHaveBeenCalled())
  expect(store.list.map((s) => s.id)).toEqual(['a', 'b'])
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('Title a')).toBeTruthy()
  show.mockRestore()
})

it('Escape cancels the confirmation without closing the dialog; a second Escape closes', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Discard all'))
  await fireEvent.keyDown(btn('Keep'), { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(btn('Discard all')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(btn('Discard all')))
  await fireEvent.keyDown(btn('Discard all'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('Escape in the editor cancels only the editor, not the dialog', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Edit: Title b' }))
  const group = screen.getByRole('group', { name: /Edit suggestion/ })
  await fireEvent.keyDown(group, { key: 'Escape' })
  expect(store.editingId).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('the confirmation goes away when the list drops to one', async () => {
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(btn('Discard all'))
  store.apply({ sessionId: 's1', waiting: [make('a', 1)] })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull())
  expect(btn('Close')).toBeTruthy()
})

it('focus goes to the next card Accept after a single removal with the footer present', async () => {
  store.setSnapshot('s1', three())
  render(KnowledgeSuggestionsDialog)
  const discard = screen.getByRole('button', { name: 'Discard: Title c' })
  discard.focus()
  await fireEvent.click(discard)
  await waitFor(() => expect(screen.queryByText('Title c')).toBeNull())
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Accept: Title b' }))
  )
})

it('focus goes to the first remaining card after a partial batch', async () => {
  store.setSnapshot('s1', three())
  mockArc((channel) =>
    channel === 'knowledge-suggestions:accept-all'
      ? {
          ok: true,
          data: {
            results: [
              { id: 'a', outcome: outcomeFor('a') },
              { id: 'b', error: { code: 'EXTERNAL_MODIFIED' } },
              { id: 'c', outcome: outcomeFor('c') }
            ]
          }
        }
      : { ok: true, data: undefined }
  )
  render(KnowledgeSuggestionsDialog)
  const all = btn('Accept all')
  all.focus()
  await fireEvent.click(all)
  await waitFor(() => expect(store.list.map((s) => s.id)).toEqual(['b']))
  const card = document.querySelector('[data-knowledge-suggestion="b"]') as HTMLElement
  await waitFor(() => expect(card.contains(document.activeElement)).toBe(true))
})

it('focus goes to a confirmation Open button after a full batch', async () => {
  mockArc((channel) =>
    channel === 'knowledge-suggestions:accept-all'
      ? {
          ok: true,
          data: { results: ['a', 'b'].map((id) => ({ id, outcome: outcomeFor(id) })) }
        }
      : { ok: true, data: undefined }
  )
  render(KnowledgeSuggestionsDialog)
  const all = btn('Accept all')
  all.focus()
  await fireEvent.click(all)
  const open = await screen.findAllByRole('button', { name: /^Open/ })
  await waitFor(() => expect(document.activeElement).toBe(open[0]))
})

function live(): HTMLElement {
  return document.querySelector('[aria-live="polite"]') as HTMLElement
}

it('has a visually hidden polite live region that starts empty', () => {
  render(KnowledgeSuggestionsDialog)
  expect(live()).toBeTruthy()
  expect(live().classList.contains('sr-only')).toBe(true)
  expect(live().textContent?.trim()).toBe('')
})

it('announces the plural count after a removal and the singular after the next', async () => {
  store.setSnapshot('s1', three())
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Discard: Title c' }))
  await waitFor(() => expect(live().textContent).toBe('2 suggestions waiting'))
  await fireEvent.click(screen.getByRole('button', { name: 'Discard: Title b' }))
  await waitFor(() => expect(live().textContent).toBe('1 suggestion waiting'))
})

it('announces after a pushed list and says No suggestions waiting at zero', async () => {
  render(KnowledgeSuggestionsDialog)
  store.apply({ sessionId: 's1', waiting: three() })
  await waitFor(() => expect(live().textContent).toBe('3 suggestions waiting'))
  store.confirmations = [{ id: 'x', outcome: outcomeFor('x') as never }]
  store.apply({ sessionId: 's1', waiting: [] })
  await waitFor(() => expect(live().textContent).toBe('No suggestions waiting'))
})

it('is reachable in DOM order by keyboard with no positive tabindex', () => {
  render(KnowledgeSuggestionsDialog)
  const panel = screen.getByRole('dialog')
  const order = [...panel.querySelectorAll<HTMLElement>('button:not([disabled])')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent?.trim()
  )
  const accepts = order.filter((n) => n?.startsWith('Accept: '))
  expect(order.indexOf('Accept: Title b')).toBeLessThan(order.indexOf('Accept: Title a'))
  expect(accepts).toHaveLength(2)
  expect(order.slice(-3)).toEqual(['Accept all', 'Discard all', 'Close'])
  const lastCardButton = order.findLastIndex((n) => /: Title/.test(n ?? ''))
  expect(lastCardButton).toBeLessThan(order.indexOf('Accept all'))
  for (const el of panel.querySelectorAll('[tabindex]')) {
    expect(Number(el.getAttribute('tabindex'))).toBeLessThanOrEqual(0)
  }
})
