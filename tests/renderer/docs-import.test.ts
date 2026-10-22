import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import DocsSection from '../../src/renderer/src/lib/components/sections/DocsSection.svelte'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import TextDocEditor from '../../src/renderer/src/lib/components/items/TextDocEditor.svelte'
import Toaster from '../../src/renderer/src/lib/components/ui/Toaster.svelte'
import { languageFor, loadLanguage } from '../../src/renderer/src/lib/editor/languages'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { importFlow } from '../../src/renderer/src/lib/stores/import-flow.svelte'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import { knowledge } from '../../src/renderer/src/lib/stores/knowledge.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { ImportReport } from '../../src/shared/types/item'
import type { Section } from '../../src/shared/types/section'
import { mockHarness } from './helpers'

const docs: Section = {
  id: 'docs1',
  groupId: 'g',
  kind: 'docs',
  name: 'Docs',
  builtIn: true,
  itemCount: 0,
  sortOrder: 4
}
const empty: ImportReport = { added: [], failed: [], conflicts: [] }

function conflict(name: string, path = `/src/${name}`): { name: string; path: string } {
  return { name, path }
}

/** Answers items:list/read with nothing and everything else through `onImport`. */
function harness(onImport: (channel: string, request: unknown) => ImportReport): {
  invoke: ReturnType<typeof mockHarness>
} {
  const invoke = mockHarness((channel, request) => {
    if (channel === 'items:list' || channel === 'sections:list') return { ok: true, data: [] }
    if (channel === 'items:pickImport' || channel === 'items:import') {
      return { ok: true, data: onImport(channel, request) }
    }
    return { ok: true, data: undefined }
  })
  return { invoke }
}

function importCalls(invoke: ReturnType<typeof mockHarness>): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === 'items:import')
}

function mount(): void {
  render(DocsSection, { section: docs })
  render(DialogHost)
  render(Toaster)
}

beforeEach(() => {
  vi.useRealTimers()
  ui.closeDialog()
  itemDraft.discard()
  groupDetail.groupId = 'g'
  groupDetail.sections = [docs]
  toasts.list = []
  knowledge.items = []
  knowledge.sectionId = null
})
afterEach(cleanup)

it('Import… invokes items:pickImport and Docs has no New button', async () => {
  const { invoke } = harness(() => empty)
  mount()
  expect(screen.queryByRole('button', { name: /^New/ })).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('items:pickImport', { sectionId: 'docs1' })
  )
})

it('dropping files invokes items:import with the getPathForFile paths', async () => {
  const { invoke } = harness(() => empty)
  const getPath = window.harness.getPathForFile as ReturnType<typeof vi.fn>
  getPath.mockImplementation((f: File) => `/dropped/${f.name}`)
  mount()
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [new File([], 'a.sql'), new File([], 'b.json')], types: ['Files'] }
  })
  screen.getAllByRole('region')[0]?.dispatchEvent(event)
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('items:import', {
      sectionId: 'docs1',
      paths: ['/dropped/a.sql', '/dropped/b.json']
    })
  )
})

it('a FILE_TOO_LARGE failure shows the spec message and valid files are not blocked', async () => {
  harness(() => ({
    ...empty,
    failed: [
      { name: 'big_dump.sql', code: 'FILE_TOO_LARGE' },
      { name: 'setup.exe', code: 'FILE_UNSUPPORTED' }
    ]
  }))
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  const toast = await screen.findByRole('status')
  expect(toast.textContent).toContain("'big_dump.sql' is larger than 20 MB and was not added.")
  expect(toast.textContent).toContain("'setup.exe' isn't a supported file type.")
})

function conflictingHarness(names: string[]): ReturnType<typeof mockHarness> {
  return harness((channel) =>
    channel === 'items:pickImport' ? { ...empty, conflicts: names.map((n) => conflict(n)) } : empty
  ).invoke
}

it('a conflict opens the dialog and Keep Both re-invokes items:import with the path', async () => {
  const invoke = conflictingHarness(['orders_schema.sql'])
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  expect(await screen.findByText("'orders_schema.sql' already exists in Docs.")).toBeTruthy()
  expect(importCalls(invoke)).toHaveLength(0)
  await fireEvent.click(screen.getByRole('button', { name: 'Keep Both' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('items:import', {
      sectionId: 'docs1',
      paths: ['/src/orders_schema.sql'],
      onConflict: { 'orders_schema.sql': 'keepBoth' }
    })
  )
})

it('Apply to all with Replace answers every conflict in one re-invoke', async () => {
  const invoke = conflictingHarness(['a.sql', 'b.sql', 'c.sql'])
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  await screen.findByText("'a.sql' already exists in Docs.")
  await fireEvent.click(screen.getByLabelText('Apply to all remaining conflicts'))
  await fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
  await waitFor(() => expect(importCalls(invoke)).toHaveLength(1))
  expect(importCalls(invoke)[0]?.[1]).toEqual({
    sectionId: 'docs1',
    paths: ['/src/a.sql', '/src/b.sql', '/src/c.sql'],
    onConflict: { 'a.sql': 'replace', 'b.sql': 'replace', 'c.sql': 'replace' }
  })
  expect(importFlow.prompt).toBeNull()
})

it('without Apply to all each conflict is asked, and Cancel sends nothing for that file', async () => {
  const invoke = conflictingHarness(['a.sql', 'b.sql'])
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  await screen.findByText("'a.sql' already exists in Docs.")
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await screen.findByText("'b.sql' already exists in Docs.")
  await fireEvent.click(screen.getByRole('button', { name: 'Keep Both' }))
  await waitFor(() => expect(importCalls(invoke)).toHaveLength(1))
  expect(importCalls(invoke)[0]?.[1]).toEqual({
    sectionId: 'docs1',
    paths: ['/src/b.sql'],
    onConflict: { 'b.sql': 'keepBoth' }
  })
})

it('Cancel on the only conflict does not re-invoke items:import', async () => {
  const invoke = conflictingHarness(['a.sql'])
  mount()
  await fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  await screen.findByText("'a.sql' already exists in Docs.")
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(importFlow.prompt).toBeNull())
  expect(importCalls(invoke)).toHaveLength(0)
})

it('picks the SQL language for .sql and plain text for .txt', async () => {
  expect(languageFor('orders_schema.sql')).toBe('sql')
  expect(languageFor('x.YML')).toBe('yaml')
  expect(languageFor('notes.txt')).toBeNull()
  expect(await loadLanguage('sql')).toBeTruthy()

  const { container, unmount } = render(TextDocEditor, {
    value: 'select 1',
    fileName: 'orders_schema.sql',
    onchange: () => {}
  })
  await waitFor(() =>
    expect(container.querySelector('[data-language]')?.getAttribute('data-language')).toBe('sql')
  )
  unmount()
  const plain = render(TextDocEditor, { value: 'x', fileName: 'a.txt', onchange: () => {} })
  expect(plain.container.querySelector('[data-language]')?.getAttribute('data-language')).toBe(
    'plain'
  )
})
