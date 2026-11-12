import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import KnowledgeSuggestionsDialog from '../../src/renderer/src/lib/components/knowledge-suggestions/KnowledgeSuggestionsDialog.svelte'
import { knowledgeSuggestions as store } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import type { Result } from '../../src/shared/errors'
import type { KnowledgeSuggestionView } from '../../src/shared/types/knowledge-suggestion'
import { mockArc } from './helpers'

const sections = [
  { id: 'sp', groupId: 'g1', kind: 'projects', name: 'Projects' },
  { id: 'sec', groupId: 'g1', kind: 'notes', name: 'Notes' },
  { id: 'sd', groupId: 'g1', kind: 'docs', name: 'Docs' },
  { id: 'sl', groupId: 'g1', kind: 'links', name: 'Links' },
  { id: 'sc', groupId: 'g1', kind: 'custom', name: 'Runbooks' }
]
const outcome = {
  groupId: 'g1',
  sectionId: 'sec',
  sectionName: 'Notes',
  itemId: 'i1',
  name: 'Service map.md',
  edited: true
}
const newNote = (id = 'k1'): KnowledgeSuggestionView => ({
  id,
  sessionId: 's1',
  kind: 'new',
  title: 'Service map',
  reason: 'Found it.',
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'Service map.md', relPath: null },
  text: 'line one',
  createdAt: 1
})
const update = (id = 'u1'): KnowledgeSuggestionView => ({
  ...newNote(id),
  kind: 'update',
  title: 'Schema change',
  sectionId: 'sd',
  sectionName: 'Docs',
  target: { itemId: 'item', name: 'Schema.md', relPath: 'Docs/Schema.md' },
  text: undefined,
  hunks: []
})

let reply: (channel: string, request: unknown) => Result<unknown> | Promise<Result<unknown>>
const fail = (code: string, details?: Record<string, string>): Result<never> =>
  ({ ok: false, error: { code, details } }) as Result<never>
const defaults = (channel: string): Result<unknown> => {
  if (channel === 'sections:list') return { ok: true, data: sections }
  if (channel === 'knowledge-suggestions:result-text')
    return { ok: true, data: { text: 'FULL TEXT' } }
  return { ok: true, data: outcome }
}
function arc(): ReturnType<typeof mockArc> {
  return mockArc((channel, request) => reply(channel, request))
}
const acceptCalls = (invoke: ReturnType<typeof mockArc>) =>
  invoke.mock.calls.filter((c) => c[0] === 'knowledge-suggestions:accept')

beforeEach(() => {
  reply = defaults
  store.reset()
  groupDetail.groupId = null
  groupDetail.sections = []
  activeSession.header = { groupId: 'g1' } as never
  store.setSnapshot('s1', [newNote()])
  store.open()
})
afterEach(() => {
  cleanup()
  store.reset()
  activeSession.header = null
})

async function openEditor(name = 'Edit: Service map'): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name }))
  await screen.findByLabelText('Text')
}
const textBox = () => screen.getByLabelText('Text') as HTMLTextAreaElement
const nameBox = () => screen.getByLabelText('Name') as HTMLInputElement
const sectionBox = () => screen.getByLabelText('Section') as HTMLSelectElement
const editorAccept = () => screen.getByRole('button', { name: 'Accept' })

it('shows Text, Name and Section for a new note, seeded from the suggestion', async () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  expect(textBox().value).toBe('line one')
  expect(textBox().rows).toBe(10)
  expect(nameBox().value).toBe('Service map')
  await waitFor(() => expect(sectionBox().value).toBe('sec'))
})

it('Section options exclude Projects and Links', async () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await waitFor(() => expect(sectionBox().options.length).toBe(3))
  expect([...sectionBox().options].map((o) => o.textContent)).toEqual(['Notes', 'Docs', 'Runbooks'])
})

it('an update shows only Text, seeded from result-text', async () => {
  const invoke = arc()
  store.setSnapshot('s1', [update()])
  render(KnowledgeSuggestionsDialog)
  await openEditor('Edit: Schema change')
  expect(textBox().value).toBe('FULL TEXT')
  expect(invoke).toHaveBeenCalledWith('knowledge-suggestions:result-text', { id: 'u1' })
  expect(screen.queryByLabelText('Name')).toBeNull()
  expect(screen.queryByLabelText('Section')).toBeNull()
})

it('a failed result-text fetch leaves edit mode and shows the error on the card', async () => {
  reply = (channel) =>
    channel === 'knowledge-suggestions:result-text' ? fail('INTERNAL') : defaults(channel)
  arc()
  store.setSnapshot('s1', [update()])
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Edit: Schema change' }))
  await waitFor(() => expect(store.editingId).toBeNull())
  expect(screen.queryByLabelText('Text')).toBeNull()
  expect(document.querySelector('[data-knowledge-suggestion-problem]')).toBeTruthy()
})

it('editing the text sends only the text', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(textBox(), { target: { value: 'my text' } })
  await fireEvent.click(editorAccept())
  await waitFor(() => expect(acceptCalls(invoke)).toHaveLength(1))
  expect(acceptCalls(invoke)[0]?.[1]).toEqual({ id: 'k1', edits: { text: 'my text' } })
})

it('editing name, section and text sends all three', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await waitFor(() => expect(sectionBox().options.length).toBe(3))
  await fireEvent.input(textBox(), { target: { value: 'my text' } })
  await fireEvent.input(nameBox(), { target: { value: 'Map v2' } })
  await fireEvent.change(sectionBox(), { target: { value: 'sc' } })
  await fireEvent.click(editorAccept())
  await waitFor(() => expect(acceptCalls(invoke)).toHaveLength(1))
  expect(acceptCalls(invoke)[0]?.[1]).toEqual({
    id: 'k1',
    edits: { text: 'my text', name: 'Map v2', sectionId: 'sc' }
  })
})

it('an untouched editor is a plain accept', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.click(editorAccept())
  await waitFor(() => expect(acceptCalls(invoke)).toHaveLength(1))
  expect(acceptCalls(invoke)[0]?.[1]).toEqual({ id: 'k1' })
})

it('empty text shows its message and makes no call', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(textBox(), { target: { value: '  \n ' } })
  await fireEvent.click(editorAccept())
  expect(await screen.findByText('Enter some text.')).toBeTruthy()
  expect(acceptCalls(invoke)).toHaveLength(0)
})

it('an empty name shows its message and makes no call', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(nameBox(), { target: { value: '   ' } })
  await fireEvent.click(editorAccept())
  expect(await screen.findByText('Enter a name.')).toBeTruthy()
  expect(acceptCalls(invoke)).toHaveLength(0)
})

it('Cancel restores the card with the original text and makes no accept call', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(textBox(), { target: { value: 'my text' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(store.editingId).toBeNull()
  expect(screen.queryByLabelText('Text')).toBeNull()
  expect(document.querySelector('[data-suggestion-text]')?.textContent).toBe('line one')
  expect(acceptCalls(invoke)).toHaveLength(0)
  const edit = screen.getByRole('button', { name: 'Edit: Service map' })
  await waitFor(() => expect(document.activeElement).toBe(edit))
})

it('focus goes to the Text field when edit mode opens', async () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await waitFor(() => expect(document.activeElement).toBe(textBox()))
})

it('Enter in Name accepts; Enter in the text does not', async () => {
  const invoke = arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.keyDown(textBox(), { key: 'Enter' })
  expect(acceptCalls(invoke)).toHaveLength(0)
  await fireEvent.input(nameBox(), { target: { value: 'Map v2' } })
  await fireEvent.keyDown(nameBox(), { key: 'Enter' })
  await waitFor(() => expect(acceptCalls(invoke)).toHaveLength(1))
  expect(acceptCalls(invoke)[0]?.[1]).toEqual({ id: 'k1', edits: { name: 'Map v2' } })
})

it('Escape leaves edit mode and keeps the dialog; a second Escape closes it', async () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.keyDown(textBox(), { key: 'Escape' })
  expect(store.editingId).toBeNull()
  expect(store.dialogOpen).toBe(true)
  expect(screen.getByRole('dialog', { name: 'Knowledge suggestions' })).toBeTruthy()
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('a VALIDATION_FAILED reply shows its reason inline and keeps the typed text', async () => {
  reply = (channel) =>
    channel === 'knowledge-suggestions:accept'
      ? fail('VALIDATION_FAILED', { reason: 'That name cannot be used.' })
      : defaults(channel)
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(textBox(), { target: { value: 'my text' } })
  await fireEvent.click(editorAccept())
  expect(await screen.findByText('That name cannot be used.')).toBeTruthy()
  expect(store.editingId).toBe('k1')
  expect(textBox().value).toBe('my text')
})

it('the Edit button sits between Accept and Discard with a titled name', () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  const names = [...document.querySelectorAll('[data-knowledge-suggestion] button')].map((b) =>
    b.getAttribute('aria-label')
  )
  expect(names).toEqual(['Accept: Service map', 'Edit: Service map', 'Discard: Service map'])
  expect(screen.getByRole('button', { name: 'Edit: Service map' }).textContent?.trim()).toBe('Edit')
})

it('Edit is hidden on a changed card', async () => {
  reply = (channel) =>
    channel === 'knowledge-suggestions:accept' ? fail('EXTERNAL_MODIFIED') : defaults(channel)
  arc()
  store.setSnapshot('s1', [update()])
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Accept: Schema change' }))
  await screen.findByText('This note has changed since the suggestion was made.')
  expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
})

it('ITEM_NAME_TAKEN opens the editor on the Name field with the message inline', async () => {
  reply = (channel) =>
    channel === 'knowledge-suggestions:accept' ? fail('ITEM_NAME_TAKEN') : defaults(channel)
  arc()
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Accept: Service map' }))
  await screen.findByLabelText('Name')
  expect(store.editingId).toBe('k1')
  await waitFor(() => expect(document.activeElement).toBe(nameBox()))
  expect(nameBox().getAttribute('aria-invalid')).toBe('true')
  expect(screen.getAllByText('A note with this name already exists.')).toHaveLength(1)
})

it('a second name-taken from the editor stays in edit mode and refocuses Name', async () => {
  reply = (channel) =>
    channel === 'knowledge-suggestions:accept' ? fail('ITEM_NAME_TAKEN') : defaults(channel)
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(nameBox(), { target: { value: 'Taken' } })
  textBox().focus()
  await fireEvent.click(editorAccept())
  await screen.findByText('A note with this name already exists.')
  await waitFor(() => expect(document.activeElement).toBe(nameBox()))
  expect(nameBox().value).toBe('Taken')
})

it('Add as a new note opens the editor with Name and Section and sends the name', async () => {
  let calls = 0
  reply = (channel) => {
    if (channel === 'knowledge-suggestions:accept' && calls++ === 0) return fail('ITEM_NOT_FOUND')
    return defaults(channel)
  }
  const invoke = arc()
  store.setSnapshot('s1', [update()])
  render(KnowledgeSuggestionsDialog)
  await fireEvent.click(screen.getByRole('button', { name: 'Accept: Schema change' }))
  await fireEvent.click(await screen.findByRole('button', { name: 'Add as a new note' }))
  await screen.findByLabelText('Text')
  expect(nameBox().value).toBe('Schema')
  await waitFor(() => expect(sectionBox().value).toBe('sd'))
  await waitFor(() => expect(textBox().value).toBe('FULL TEXT'))
  await fireEvent.click(editorAccept())
  await waitFor(() => expect(acceptCalls(invoke)).toHaveLength(2))
  expect(acceptCalls(invoke)[1]?.[1]).toEqual({ id: 'u1', edits: { name: 'Schema' } })
})

it('a pushed list during editing keeps the typed text', async () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  await fireEvent.input(textBox(), { target: { value: 'my text' } })
  store.apply({ sessionId: 's1', waiting: [newNote(), newNote('k2')] })
  await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2))
  expect(textBox().value).toBe('my text')
  expect(store.editingId).toBe('k1')
})

it('edit mode ends when the card leaves the list or the store resets', async () => {
  arc()
  render(KnowledgeSuggestionsDialog)
  await openEditor()
  store.apply({ sessionId: 's1', waiting: [newNote('k2')] })
  expect(store.editingId).toBeNull()
  store.startEdit('k2')
  expect(store.editingId).toBe('k2')
  store.reset()
  expect(store.editingId).toBeNull()
})

it('only one card is in edit mode at a time', async () => {
  arc()
  store.setSnapshot('s1', [newNote('k1'), { ...newNote('k2'), createdAt: 2 }])
  render(KnowledgeSuggestionsDialog)
  store.startEdit('k1')
  store.startEdit('k2')
  expect(store.editingId).toBe('k2')
  await waitFor(() => expect(screen.getAllByLabelText('Text')).toHaveLength(1))
})
