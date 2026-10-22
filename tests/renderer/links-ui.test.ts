import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import LinksSection from '../../src/renderer/src/lib/components/sections/LinksSection.svelte'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import Toaster from '../../src/renderer/src/lib/components/ui/Toaster.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { knowledge } from '../../src/renderer/src/lib/stores/knowledge.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { ItemSummary } from '../../src/shared/types/item'
import type { Section } from '../../src/shared/types/section'
import { mockHarness } from './helpers'

const links: Section = {
  id: 'links1',
  groupId: 'g',
  kind: 'links',
  name: 'Links',
  builtIn: true,
  itemCount: 0,
  sortOrder: 3
}
const INVALID = 'Enter a full web address starting with http:// or https://.'

function link(id: string, url: string, title = url, description = ''): ItemSummary {
  return {
    id,
    sectionId: links.id,
    title,
    fileName: `${id}.md`,
    description,
    kind: 'link',
    url,
    editable: false,
    revision: '1'
  }
}

/** A tiny in-memory links:upsert/items:list/items:delete backend. */
function harness(initial: ItemSummary[] = []): ReturnType<typeof mockHarness> {
  let store = [...initial]
  return mockHarness((channel, request) => {
    const req = request as Record<string, string | undefined>
    if (channel === 'items:list') return { ok: true, data: store }
    if (channel === 'sections:list') return { ok: true, data: [links] }
    if (channel === 'links:upsert') {
      const item = link(
        req.itemId ?? `n${store.length}`,
        req.url!,
        req.title || req.url,
        req.description
      )
      store = req.itemId ? store.map((i) => (i.id === req.itemId ? item : i)) : [...store, item]
      return { ok: true, data: item }
    }
    if (channel === 'items:delete') {
      store = store.filter((i) => i.id !== req.itemId)
      return { ok: true, data: undefined }
    }
    return { ok: true, data: undefined }
  })
}

function mount(): void {
  render(LinksSection, { section: links })
  render(DialogHost)
  render(Toaster)
}

async function fillForm(url: string, title?: string): Promise<void> {
  await fireEvent.input(screen.getByLabelText('Address'), { target: { value: url } })
  if (title)
    await fireEvent.input(screen.getByLabelText('Title (optional)'), { target: { value: title } })
}

beforeEach(() => {
  vi.useRealTimers()
  ui.closeDialog()
  groupDetail.groupId = 'g'
  groupDetail.sections = [links]
  toasts.list = []
  knowledge.items = []
  knowledge.sectionId = null
})
afterEach(cleanup)

it('adds a titled link and lists it', async () => {
  const invoke = harness()
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Add Link' }))
  await fillForm('https://wiki.example.com/orders', 'Orders wiki')
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(screen.getByText('Orders wiki')).toBeTruthy())
  expect(invoke).toHaveBeenCalledWith('links:upsert', {
    sectionId: 'links1',
    url: 'https://wiki.example.com/orders',
    title: 'Orders wiki'
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('shows the address as the title when no title is given', async () => {
  harness()
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Add Link' }))
  await fillForm('https://wiki.example.com/orders')
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await waitFor(() =>
    expect(screen.getAllByText('https://wiki.example.com/orders')).toHaveLength(2)
  )
})

it('rejects an address without http(s) inline and does not call main', async () => {
  const invoke = harness()
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Add Link' }))
  await fillForm('wiki.example.com')
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect((await screen.findByRole('alert')).textContent).toBe(INVALID)
  expect(invoke.mock.calls.some((c) => c[0] === 'links:upsert')).toBe(false)
})

it('maps a server LINK_URL_INVALID to the same message', async () => {
  mockHarness((channel) => {
    if (channel === 'links:upsert') {
      return { ok: false, error: { code: 'LINK_URL_INVALID' } }
    }
    return { ok: true, data: [] }
  })
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Add Link' }))
  await fillForm('https://ok.example.com')
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect((await screen.findByRole('alert')).textContent).toBe(INVALID)
})

it('clicking the address invokes shell:openLink with the item id', async () => {
  const invoke = harness([link('a1', 'https://wiki.example.com/orders', 'Orders wiki')])
  mount()
  await fireEvent.click(
    await screen.findByRole('button', { name: 'https://wiki.example.com/orders' })
  )
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('shell:openLink', { itemId: 'a1' }))
})

it('edits a link with the form prefilled', async () => {
  const invoke = harness([link('a1', 'https://a.example.com', 'Old', 'desc')])
  mount()
  await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('https://a.example.com')
  expect((screen.getByLabelText('Title (optional)') as HTMLInputElement).value).toBe('Old')
  await fillForm('https://b.example.com', 'New')
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.getByText('New')).toBeTruthy())
  expect(invoke).toHaveBeenCalledWith('links:upsert', {
    sectionId: 'links1',
    itemId: 'a1',
    url: 'https://b.example.com',
    title: 'New',
    description: 'desc'
  })
})

it('deletes a link after confirmation', async () => {
  harness([link('a1', 'https://a.example.com', 'Doomed')])
  mount()
  await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(screen.queryByText('Doomed')).toBeNull())
  expect(screen.getByText('No links yet')).toBeTruthy()
})

it('a form-level server error shows the error icon beside the exact text', async () => {
  mockHarness((channel) => {
    if (channel === 'links:upsert') return { ok: false, error: { code: 'VALIDATION_FAILED' } }
    return { ok: true, data: [] }
  })
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Add Link' }))
  await fillForm('https://ok.example.com')
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent?.length).toBeGreaterThan(0)
  expect(alert.querySelector('[data-icon="error"]')).not.toBeNull()
  expect(alert.firstElementChild?.tagName.toLowerCase()).toBe('svg')
})

it('link rows are hud-rows and both row actions share the secondary weight', async () => {
  harness([link('a1', 'https://wiki.example.com/orders', 'Orders wiki')])
  mount()
  const edit = await screen.findByRole('button', { name: 'Edit' })
  const del = screen.getByRole('button', { name: 'Delete' })
  expect(edit.closest('li')!.classList.contains('hud-row')).toBe(true)
  expect(edit.getAttribute('data-variant')).toBe('secondary')
  expect(del.getAttribute('data-variant')).toBe('secondary')
})
