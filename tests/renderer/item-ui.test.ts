import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ItemDetail from '../../src/renderer/src/lib/components/items/ItemDetail.svelte'
import ItemList from '../../src/renderer/src/lib/components/items/ItemList.svelte'
import MarkdownPreview from '../../src/renderer/src/lib/components/items/MarkdownPreview.svelte'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import type { ItemSummary } from '../../src/shared/types/item'
import { mockHarness } from './helpers'

function item(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 'i1',
    sectionId: 's',
    title: 'Service map',
    fileName: 'Service map.md',
    description: '',
    kind: 'note',
    editable: true,
    revision: 'r',
    ...over
  }
}

beforeEach(() => {
  vi.useRealTimers()
  itemDraft.discard()
})
afterEach(cleanup)

it('ItemList shows the description under the title', () => {
  render(ItemList, {
    items: [item({ description: 'How services talk' }), item({ id: 'i2', title: 'Other' })],
    selectedId: 'i1',
    onselect: () => {}
  })
  expect(screen.getByText('Service map')).toBeTruthy()
  expect(screen.getByText('How services talk')).toBeTruthy()
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
})

it('ItemDetail with an empty title shows the error and does not rename', async () => {
  const invoke = mockHarness(() => ({ ok: true, data: undefined }))
  render(ItemDetail, { item: item() })
  const input = screen.getByLabelText('Title')
  await fireEvent.input(input, { target: { value: '   ' } })
  await fireEvent.blur(input)
  expect(await screen.findByText('Title is required.')).toBeTruthy()
  await waitFor(() => expect(invoke).not.toHaveBeenCalledWith('items:rename', expect.anything()))
})

it('MarkdownPreview renders heading, list and code block', () => {
  const { container } = render(MarkdownPreview, { source: '# H\n\n- a\n\n```\ncode\n```\n' })
  expect(container.querySelector('h1')?.textContent).toBe('H')
  expect(container.querySelector('ul li')?.textContent).toBe('a')
  expect(container.querySelector('pre')?.textContent).toContain('code')
})

it('MarkdownPreview root carries the typography styling hook', () => {
  const { container } = render(MarkdownPreview, { source: '# H' })
  expect(container.firstElementChild?.classList.contains('markdown-preview')).toBe(true)
})

it('MarkdownPreview strips scripts and raw HTML', () => {
  const { container } = render(MarkdownPreview, {
    source: 'hi <script>window.__pwn = 1</script> <b>bold</b> <img src=x onerror="1">'
  })
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('b')).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  expect(container.textContent).toContain('hi')
})

it('ItemList groups nested items under collapsible folder headers, top-level files first', async () => {
  const onselect = vi.fn()
  render(ItemList, {
    items: [
      item({ id: 'n1', title: 'Nested A', folder: '001-x' }),
      item({ id: 't1', title: 'Top' }),
      item({ id: 'n2', title: 'Deep B', folder: '002-y/sub' }),
      item({ id: 'n3', title: 'Nested C', folder: '001-x' })
    ],
    selectedId: null,
    onselect
  })
  const labels = screen.getAllByRole('listitem').map((li) => li.textContent?.trim())
  expect(labels[0]).toBe('Top')
  const header = screen.getByRole('button', { name: '001-x' })
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: '002-y/sub' })).toBeTruthy()
  expect(screen.getByText('Nested A')).toBeTruthy()
  expect(screen.getByText('Nested C')).toBeTruthy()

  await fireEvent.click(header)
  expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Nested A')).toBeNull()
  expect(screen.getByText('Deep B')).toBeTruthy()

  await fireEvent.click(screen.getByText('Deep B'))
  expect(onselect).toHaveBeenCalledWith('n2')
})

it('ItemList collapses groups by default when there are many items', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    item({ id: `m${i}`, title: `M${i}`, folder: `f${i % 4}` })
  )
  render(ItemList, { items: many, selectedId: null, onselect: () => {} })
  expect(screen.getByRole('button', { name: 'f0' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('M0')).toBeNull()
})

it('ItemList expands the group holding the selected item', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    item({ id: `m${i}`, title: `M${i}`, folder: `f${i % 4}` })
  )
  render(ItemList, { items: many, selectedId: 'm1', onselect: () => {} })
  expect(screen.getByRole('button', { name: 'f1' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('M1')).toBeTruthy()
})
