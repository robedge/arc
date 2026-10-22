import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import Modal from '../../src/renderer/src/lib/components/ui/Modal.svelte'
import ItemList from '../../src/renderer/src/lib/components/items/ItemList.svelte'
import SectionNav from '../../src/renderer/src/lib/components/shell/SectionNav.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { ItemSummary } from '../../src/shared/types/item'

afterEach(cleanup)

const body = createRawSnippet(() => ({ render: () => '<div></div>' }))

it('Modal title is uppercase and tracked, with text content unchanged', () => {
  render(Modal, { title: 'New Group', onsubmit: () => {}, oncancel: () => {}, children: body })
  const h = screen.getByRole('heading', { name: 'New Group' })
  expect(h.textContent?.trim()).toBe('New Group')
  expect(h.classList.contains('uppercase')).toBe(true)
  expect(h.className).toMatch(/tracking-/)
})

it('ItemList shows file names in the mono font', () => {
  const items: ItemSummary[] = [
    {
      id: 'i1',
      sectionId: 's',
      title: 'orders_schema.sql',
      fileName: 'orders_schema.sql',
      description: '',
      kind: 'note',
      editable: true,
      revision: 'r'
    }
  ]
  render(ItemList, { items, selectedId: null, onselect: () => {} })
  expect(screen.getByText('orders_schema.sql').classList.contains('font-mono')).toBe(true)
})

beforeEach(() => {
  ui.selectedGroupId = 'g'
  groupDetail.groupId = 'g'
  groupDetail.sections = []
})

it('SectionNav panel has corner brackets', () => {
  const { container } = render(SectionNav)
  expect(container.querySelectorAll('[data-bracket]')).toHaveLength(2)
})
