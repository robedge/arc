import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ItemDetail from '../../src/renderer/src/lib/components/items/ItemDetail.svelte'
import GroupView from '../../src/renderer/src/lib/components/shell/GroupView.svelte'
import { reconcileOpenItem } from '../../src/renderer/src/lib/reconcile'
import { revealInFinder } from '../../src/renderer/src/lib/reveal'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import {
  knowledge,
  KNOWLEDGE_REFRESH_DEBOUNCE_MS
} from '../../src/renderer/src/lib/stores/knowledge.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { Result } from '../../src/shared/errors'
import type { ItemSummary } from '../../src/shared/types/item'
import { mockHarness } from './helpers'

function item(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 'i1',
    sectionId: 's1',
    title: 'Service map',
    fileName: 'Service map.md',
    description: '',
    kind: 'note',
    editable: true,
    revision: 'r0',
    ...over
  }
}

interface Disk {
  content: string
  revision: string
  missing: boolean
}

/** A fake main process: one text item whose disk state the test controls. */
function setup(disk: Disk): ReturnType<typeof mockHarness> {
  return mockHarness((channel): Result<unknown> => {
    if (channel === 'items:read') {
      return disk.missing
        ? { ok: false, error: { code: 'INTERNAL' } }
        : { ok: true, data: { type: 'text', content: disk.content, revision: disk.revision } }
    }
    if (channel === 'items:save') return { ok: true, data: { revision: 'saved' } }
    if (channel === 'items:create') return { ok: true, data: item({ id: 'new', revision: 'n0' }) }
    if (channel === 'items:list') return { ok: true, data: [item()] }
    if (channel === 'sections:list' || channel === 'projects:list') return { ok: true, data: [] }
    return { ok: true, data: undefined }
  })
}

const calls = (invoke: ReturnType<typeof mockHarness>, channel: string): unknown[][] =>
  invoke.mock.calls.filter((c) => c[0] === channel)

beforeEach(() => {
  vi.useRealTimers()
  itemDraft.discard()
  ui.selectGroup(null)
  groupDetail.groupId = 'g1'
  knowledge.sectionId = null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ---- pure reconcile ----

it('reconcile: same revision is the app own echo and is ignored, dirty or not', () => {
  expect(reconcileOpenItem({ held: 'a', dirty: false, incoming: 'a' })).toBe('ignore')
  expect(reconcileOpenItem({ held: 'a', dirty: true, incoming: 'a' })).toBe('ignore')
})

it('reconcile: a different revision replaces a clean editor', () => {
  expect(reconcileOpenItem({ held: 'a', dirty: false, incoming: 'b' })).toBe('replace')
})

it('reconcile: a different revision with unsaved edits is a conflict', () => {
  expect(reconcileOpenItem({ held: 'a', dirty: true, incoming: 'b' })).toBe('conflict')
})

it('reconcile: a null revision means deleted, whether or not the editor is dirty', () => {
  expect(reconcileOpenItem({ held: 'a', dirty: false, incoming: null })).toBe('deleted')
  expect(reconcileOpenItem({ held: 'a', dirty: true, incoming: null })).toBe('deleted')
})

// ---- draft reconcile ----

it('a clean open item is replaced with the disk content', async () => {
  const disk = { content: 'v1', revision: 'r0', missing: false }
  setup(disk)
  await itemDraft.open('i1')
  disk.content = 'v2'
  disk.revision = 'r1'
  await itemDraft.applyExternal('i1', 'r1')
  expect(itemDraft.text).toBe('v2')
  expect(itemDraft.lastSavedRevision).toBe('r1')
  expect(itemDraft.external).toBeNull()
})

it('the revision returned by the own save is ignored without a read', async () => {
  const disk = { content: 'v1', revision: 'r0', missing: false }
  const invoke = setup(disk)
  await itemDraft.open('i1')
  itemDraft.edit('mine')
  await itemDraft.flush()
  invoke.mockClear()
  await itemDraft.applyExternal('i1', 'saved')
  expect(invoke).not.toHaveBeenCalled()
  expect(itemDraft.text).toBe('mine')
  expect(itemDraft.external).toBeNull()
})

it('a dirty draft keeps its text, shows the changed state and never autosaves', async () => {
  vi.useFakeTimers()
  const invoke = setup({ content: 'v1', revision: 'r0', missing: false })
  await itemDraft.open('i1')
  itemDraft.edit('typed')
  await itemDraft.applyExternal('i1', 'r9')
  expect(itemDraft.external).toBe('changed')
  expect(itemDraft.text).toBe('typed')
  itemDraft.edit('typed more')
  await vi.advanceTimersByTimeAsync(5000)
  expect(calls(invoke, 'items:save')).toHaveLength(0)
})

// ---- store refresh ----

it('knowledge:changed bursts coalesce into one list refresh after 150 ms', async () => {
  vi.useFakeTimers()
  const invoke = setup({ content: '', revision: 'r0', missing: false })
  knowledge.sectionId = 's1'
  for (let i = 0; i < 3; i++) {
    knowledge.handleChanged({ groupId: 'g1', sectionIds: ['s1'], reason: 'external' })
    await vi.advanceTimersByTimeAsync(KNOWLEDGE_REFRESH_DEBOUNCE_MS - 50)
  }
  expect(calls(invoke, 'items:list')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(KNOWLEDGE_REFRESH_DEBOUNCE_MS)
  expect(calls(invoke, 'items:list')).toHaveLength(1)
})

it('events for another group or another section do not refresh the list', async () => {
  vi.useFakeTimers()
  const invoke = setup({ content: '', revision: 'r0', missing: false })
  knowledge.sectionId = 's1'
  knowledge.handleChanged({ groupId: 'other', sectionIds: ['s1'], reason: 'external' })
  knowledge.handleChanged({ groupId: 'g1', sectionIds: ['s2'], reason: 'external' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(calls(invoke, 'items:list')).toHaveLength(0)
})

it('sectionsChanged re-runs sections:list', async () => {
  vi.useFakeTimers()
  const invoke = setup({ content: '', revision: 'r0', missing: false })
  knowledge.handleChanged({
    groupId: 'g1',
    sectionIds: [],
    sectionsChanged: true,
    reason: 'external'
  })
  await vi.advanceTimersByTimeAsync(KNOWLEDGE_REFRESH_DEBOUNCE_MS + 10)
  expect(calls(invoke, 'sections:list')).toHaveLength(1)
})

it('a slower earlier list response never overwrites a newer one', async () => {
  const resolvers: Array<(r: Result<unknown>) => void> = []
  mockHarness(
    (channel) =>
      new Promise<Result<unknown>>((resolve) => {
        if (channel === 'items:list') resolvers.push(resolve)
        else resolve({ ok: true, data: [] })
      })
  )
  const first = knowledge.load('s1')
  const second = knowledge.refresh()
  resolvers[1]?.({ ok: true, data: [item({ title: 'new' })] })
  await second
  resolvers[0]?.({ ok: true, data: [item({ title: 'stale' })] })
  await first
  expect(knowledge.items.map((i) => i.title)).toEqual(['new'])
})

it('a change event deleting the open item sets the deleted state before the list refresh', async () => {
  vi.useFakeTimers()
  setup({ content: 'v1', revision: 'r0', missing: false })
  await itemDraft.open('i1')
  knowledge.sectionId = 's1'
  knowledge.handleChanged({
    groupId: 'g1',
    sectionIds: ['s1'],
    items: [{ id: 'i1', sectionId: 's1', revision: null }],
    reason: 'external'
  })
  await vi.advanceTimersByTimeAsync(KNOWLEDGE_REFRESH_DEBOUNCE_MS + 10)
  expect(itemDraft.external).toBe('deleted')
})

it('an un-enumerated change rechecks the open item and detects deletion', async () => {
  vi.useFakeTimers()
  const disk = { content: 'v1', revision: 'r0', missing: false }
  setup(disk)
  await itemDraft.open('i1')
  disk.missing = true
  knowledge.sectionId = 's1'
  knowledge.handleChanged({ groupId: 'g1', sectionIds: ['s1'], reason: 'external' })
  await vi.advanceTimersByTimeAsync(KNOWLEDGE_REFRESH_DEBOUNCE_MS + 10)
  expect(itemDraft.external).toBe('deleted')
})

// ---- banner actions ----

async function openDirty(disk: Disk): Promise<ReturnType<typeof mockHarness>> {
  const invoke = setup(disk)
  await itemDraft.open('i1')
  render(ItemDetail, { item: item() })
  itemDraft.edit('typed')
  disk.content = 'from disk'
  disk.revision = 'r9'
  await itemDraft.applyExternal('i1', 'r9')
  return invoke
}

it('Keep mine keeps the text, adopts the disk revision as base and saves with it', async () => {
  const invoke = await openDirty({ content: 'v1', revision: 'r0', missing: false })
  await fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }))
  await waitFor(() => expect(calls(invoke, 'items:save')).toHaveLength(1))
  expect(calls(invoke, 'items:save')[0]?.[1]).toEqual({
    itemId: 'i1',
    content: 'typed',
    baseRevision: 'r9'
  })
  expect(itemDraft.external).toBeNull()
  expect(itemDraft.text).toBe('typed')
})

it('Reload discards local edits and loads the disk content', async () => {
  const invoke = await openDirty({ content: 'v1', revision: 'r0', missing: false })
  await fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
  await waitFor(() => expect(itemDraft.text).toBe('from disk'))
  expect(itemDraft.dirty).toBe(false)
  expect(itemDraft.lastSavedRevision).toBe('r9')
  expect(itemDraft.external).toBeNull()
  expect(calls(invoke, 'items:save')).toHaveLength(0)
})

it('deleted: Save as new creates an item in the same section with the editor text', async () => {
  const disk = { content: 'v1', revision: 'r0', missing: false }
  const invoke = setup(disk)
  await itemDraft.open('i1')
  render(ItemDetail, { item: item() })
  itemDraft.edit('keep me')
  await itemDraft.applyExternal('i1', null)
  await fireEvent.click(await screen.findByRole('button', { name: 'Save as new' }))
  await waitFor(() => expect(calls(invoke, 'items:save')).toHaveLength(1))
  expect(calls(invoke, 'items:create')[0]?.[1]).toEqual({ sectionId: 's1', title: 'Service map' })
  expect(calls(invoke, 'items:save')[0]?.[1]).toEqual({
    itemId: 'new',
    content: 'keep me',
    baseRevision: 'n0'
  })
  await waitFor(() => expect(ui.selectedItemId).toBe('new'))
})

it('deleted: Close drops the draft and deselects the item', async () => {
  setup({ content: 'v1', revision: 'r0', missing: false })
  await itemDraft.open('i1')
  ui.selectItem('i1')
  render(ItemDetail, { item: item() })
  await itemDraft.applyExternal('i1', null)
  await fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
  expect(itemDraft.itemId).toBeNull()
  expect(ui.selectedItemId).toBeNull()
})

// ---- Show in Finder ----

it('the group storage settings Show in Finder invokes shell:reveal with the group id', async () => {
  const invoke = setup({ content: '', revision: 'r0', missing: false })
  groups.list = [{ id: 'g1', name: 'Shop' } as (typeof groups.list)[number]]
  ui.selectedGroupId = 'g1'
  render(GroupView)
  await fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }))
  expect(invoke).toHaveBeenCalledWith('shell:reveal', { groupId: 'g1' })
})

it('the item Show in Finder invokes shell:reveal with group, section and item ids', async () => {
  const invoke = setup({ content: '', revision: 'r0', missing: false })
  ui.selectedGroupId = 'g1'
  render(ItemDetail, { item: item() })
  await fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }))
  expect(invoke).toHaveBeenCalledWith('shell:reveal', {
    groupId: 'g1',
    sectionId: 's1',
    itemId: 'i1'
  })
})

it('a reveal failure shows the mapped message as a toast', async () => {
  mockHarness(() => ({ ok: false, error: { code: 'KNOWLEDGE_ROOT_MISSING' } }))
  toasts.list = []
  await revealInFinder({ groupId: 'g1' })
  expect(toasts.list.map((t) => t.message)).toEqual(['Knowledge folder not found'])
})
