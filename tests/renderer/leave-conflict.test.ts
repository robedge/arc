import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import GroupSidebar from '../../src/renderer/src/lib/components/shell/GroupSidebar.svelte'
import SectionNav from '../../src/renderer/src/lib/components/shell/SectionNav.svelte'
import ItemSection from '../../src/renderer/src/lib/components/sections/ItemSection.svelte'
import { registerCloseFlush } from '../../src/renderer/src/lib/close-flush'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import { leaveGuard } from '../../src/renderer/src/lib/stores/leave-guard.svelte'
import { knowledge } from '../../src/renderer/src/lib/stores/knowledge.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { Result } from '../../src/shared/errors'
import type { ItemSummary } from '../../src/shared/types/item'
import type { Section } from '../../src/shared/types/section'
import { mockHarness } from './helpers'

function item(id: string, title: string): ItemSummary {
  return {
    id,
    sectionId: 's1',
    title,
    fileName: `${title}.md`,
    description: '',
    kind: 'note',
    editable: true,
    revision: 'r0'
  }
}

const section: Section = {
  id: 's1',
  groupId: 'g1',
  kind: 'notes',
  name: 'Notes',
  builtIn: true,
  itemCount: 2,
  sortOrder: 1
}

const CONFLICT = 'You have unsaved changes to Alpha that conflict with the file on disk.'

let diskRevision = 'r0'

function setup(): ReturnType<typeof mockHarness> {
  diskRevision = 'r0'
  return mockHarness((channel): Result<unknown> => {
    if (channel === 'items:list') return { ok: true, data: [item('a', 'Alpha'), item('b', 'Beta')] }
    if (channel === 'items:read')
      return { ok: true, data: { type: 'text', content: 'disk', revision: diskRevision } }
    if (channel === 'items:save') return { ok: true, data: { revision: 'saved' } }
    if (channel === 'items:create') return { ok: true, data: item('new', 'Alpha (conflict)') }
    return { ok: true, data: [] }
  })
}

/** Waits for the confirm dialog and checks its sentence (split across elements by emphasis). */
async function confirm(text: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent?.replace(/\s+/g, ' ')).toContain(text)
  return dialog
}

const calls = (invoke: ReturnType<typeof mockHarness>, channel: string): unknown[][] =>
  invoke.mock.calls.filter((c) => c[0] === channel)

/** Opens Alpha, types, and reports an outside change so the banner state is active. */
async function conflicted(): Promise<ReturnType<typeof mockHarness>> {
  const invoke = setup()
  ui.selectedGroupId = 'g1'
  groupDetail.groupId = 'g1'
  groupDetail.sections = [section]
  ui.selectItem('a')
  render(ItemSection, { section })
  render(DialogHost)
  await waitFor(() => expect(itemDraft.itemId).toBe('a'))
  await waitFor(() => expect(itemDraft.loading).toBe(false))
  itemDraft.edit('mine')
  diskRevision = 'r9'
  await itemDraft.applyExternal('a', 'r9')
  expect(itemDraft.external).toBe('changed')
  return invoke
}

beforeEach(() => {
  leaveGuard.prompt = null
  itemDraft.discard()
  ui.closeDialog()
  ui.selectGroup(null)
  knowledge.sectionId = null
  knowledge.items = []
  groups.list = [
    { id: 'g1', name: 'One', createdAt: 1, updatedAt: 1 },
    { id: 'g2', name: 'Two', createdAt: 2, updatedAt: 2 }
  ]
})
afterEach(cleanup)

it('item switch: shows the conflict confirm and Cancel stays on the item', async () => {
  await conflicted()
  await fireEvent.click(await screen.findByRole('button', { name: /Beta/ }))
  expect(await confirm(CONFLICT)).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(ui.selectedItemId).toBe('a')
  expect(itemDraft.text).toBe('mine')
  expect(itemDraft.external).toBe('changed')
})

it('item switch: Keep mine overwrites disk with the local text, then switches', async () => {
  const invoke = await conflicted()
  await fireEvent.click(await screen.findByRole('button', { name: /Beta/ }))
  const dialog = await confirm(CONFLICT)
  await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep mine' }))
  await waitFor(() => expect(ui.selectedItemId).toBe('b'))
  expect(calls(invoke, 'items:save')[0]?.[1]).toEqual({
    itemId: 'a',
    content: 'mine',
    baseRevision: 'r9'
  })
})

it('item switch: Discard mine switches without writing anything', async () => {
  const invoke = await conflicted()
  await fireEvent.click(await screen.findByRole('button', { name: /Beta/ }))
  await confirm(CONFLICT)
  await fireEvent.click(screen.getByRole('button', { name: 'Discard mine' }))
  await waitFor(() => expect(ui.selectedItemId).toBe('b'))
  expect(calls(invoke, 'items:save')).toHaveLength(0)
})

it('deleted on disk: Save as new creates the item with the local text, then switches', async () => {
  const invoke = await conflicted()
  await itemDraft.applyExternal('a', null)
  expect(itemDraft.external).toBe('deleted')
  await fireEvent.click(await screen.findByRole('button', { name: /Beta/ }))
  const dialog = await confirm('and the file was deleted on disk')
  expect(within(dialog).queryByRole('button', { name: 'Keep mine' })).toBeNull()
  await fireEvent.click(within(dialog).getByRole('button', { name: 'Save as new' }))
  await waitFor(() => expect(ui.selectedItemId).toBe('b'))
  expect(calls(invoke, 'items:create')[0]?.[1]).toEqual({ sectionId: 's1', title: 'Alpha' })
  expect(calls(invoke, 'items:save')[0]?.[1]).toMatchObject({ itemId: 'new', content: 'mine' })
})

it('a clean or normally dirty item switches without any confirm', async () => {
  const invoke = setup()
  ui.selectedGroupId = 'g1'
  groupDetail.groupId = 'g1'
  ui.selectItem('a')
  render(ItemSection, { section })
  render(DialogHost)
  await waitFor(() => expect(itemDraft.itemId).toBe('a'))
  await waitFor(() => expect(itemDraft.loading).toBe(false))
  itemDraft.edit('plain edit')
  await fireEvent.click(await screen.findByRole('button', { name: /Beta/ }))
  await waitFor(() => expect(ui.selectedItemId).toBe('b'))
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(calls(invoke, 'items:save')).toHaveLength(1))
  expect(calls(invoke, 'items:save')[0]?.[1]).toMatchObject({ itemId: 'a', content: 'plain edit' })
})

it('section switch asks first and Cancel keeps the section', async () => {
  await conflicted()
  groupDetail.sections = [section, { ...section, id: 's2', name: 'Docs', kind: 'docs' }]
  ui.selectSection('s1')
  render(SectionNav)
  await fireEvent.click(screen.getByRole('tab', { name: 'Docs' }))
  await confirm(CONFLICT)
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(ui.selectedSectionId).toBe('s1')
})

it('section switch: Discard mine proceeds', async () => {
  await conflicted()
  groupDetail.sections = [section, { ...section, id: 's2', name: 'Docs', kind: 'docs' }]
  render(SectionNav)
  await fireEvent.click(screen.getByRole('tab', { name: 'Docs' }))
  await confirm(CONFLICT)
  await fireEvent.click(screen.getByRole('button', { name: 'Discard mine' }))
  await waitFor(() => expect(ui.selectedSectionId).toBe('s2'))
})

it('group switch asks first; Keep mine saves then switches', async () => {
  const invoke = await conflicted()
  render(GroupSidebar)
  await fireEvent.click(screen.getByRole('button', { name: 'Two' }))
  const dialog = await confirm(CONFLICT)
  expect(ui.selectedGroupId).toBe('g1')
  await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep mine' }))
  await waitFor(() => expect(ui.selectedGroupId).toBe('g2'))
  expect(calls(invoke, 'items:save')[0]?.[1]).toMatchObject({ itemId: 'a', content: 'mine' })
})

it('window close with a pending conflict saves a "(conflict)" copy and still replies', async () => {
  const invoke = await conflicted()
  let listener: (() => void) | undefined
  const on = vi.fn((event: string, cb: () => void) => {
    if (event === 'app:before-close') listener = cb
    return () => {}
  })
  Object.defineProperty(window, 'harness', {
    configurable: true,
    value: { invoke, on, getPathForFile: vi.fn(() => '') }
  })
  registerCloseFlush()
  listener?.()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:close-ready', {}))
  expect(calls(invoke, 'items:create')[0]?.[1]).toEqual({
    sectionId: 's1',
    title: 'Alpha (conflict)'
  })
  expect(calls(invoke, 'items:save').at(-1)?.[1]).toMatchObject({ itemId: 'new', content: 'mine' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
