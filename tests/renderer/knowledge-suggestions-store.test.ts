import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Result } from '../../src/shared/errors'
import { knowledgeSuggestions as store } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import type {
  AcceptOutcome,
  KnowledgeSuggestionView
} from '../../src/shared/types/knowledge-suggestion'
import { mockArc } from './helpers'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'

const make = (id: string, sessionId = 's1'): KnowledgeSuggestionView => ({
  id,
  sessionId,
  kind: 'new',
  title: `Title ${id}`,
  reason: 'Learned it.',
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'Service map.md', relPath: null },
  text: 'body',
  createdAt: 1
})

beforeEach(() => store.reset())
afterEach(() => store.reset())

it('snapshot and push replace the list', () => {
  store.setSnapshot('s1', [make('a'), make('b')])
  expect(store.count).toBe(2)
  store.apply({ sessionId: 's1', waiting: [make('c')] })
  expect(store.list.map((s) => s.id)).toEqual(['c'])
})

it('ignores a push for another session', () => {
  store.setSnapshot('s1', [make('a')])
  store.apply({ sessionId: 's2', waiting: [] })
  expect(store.count).toBe(1)
})

it('discard removes at once and invokes the channel', async () => {
  const invoke = mockArc(() => ({ ok: true, data: undefined }))
  store.setSnapshot('s1', [make('a'), make('b')])
  const done = store.discard('a')
  expect(store.list.map((s) => s.id)).toEqual(['b'])
  await done
  expect(invoke).toHaveBeenCalledWith('knowledge-suggestions:discard', { id: 'a' })
  expect(store.list.map((s) => s.id)).toEqual(['b'])
})

it('a failed discard restores the card at its original index', async () => {
  mockArc(() => ({ ok: false, error: { code: 'ITEM_NOT_FOUND', message: 'x' } }))
  store.setSnapshot('s1', [make('a'), make('b'), make('c')])
  await store.discard('b')
  expect(store.list.map((s) => s.id)).toEqual(['a', 'b', 'c'])
})

it('reset clears', () => {
  store.setSnapshot('s1', [make('a')])
  store.open()
  store.reset()
  expect(store.list).toEqual([])
  expect(store.sessionId).toBeNull()
  expect(store.dialogOpen).toBe(false)
})

const outcome: AcceptOutcome = {
  groupId: 'g1',
  sectionId: 'sec',
  sectionName: 'Notes',
  itemId: 'i1',
  name: 'Service map.md',
  edited: false
}
const fail = (code: string, details?: object): Result<AcceptOutcome> =>
  ({ ok: false, error: { code, details } }) as Result<AcceptOutcome>

it('accept removes the card, records a confirmation and invokes the channel', async () => {
  const invoke = mockArc(() => ({ ok: true, data: outcome }))
  store.setSnapshot('s1', [make('a'), make('b')])
  await store.accept('a')
  expect(invoke).toHaveBeenCalledWith('knowledge-suggestions:accept', { id: 'a' })
  expect(store.list.map((s) => s.id)).toEqual(['b'])
  expect(store.confirmations).toEqual([{ id: 'a', outcome }])
  expect(store.busyIds.has('a')).toBe(false)
})

it('confirmations are newest first and clear on close and reset', async () => {
  mockArc(() => ({ ok: true, data: outcome }))
  store.setSnapshot('s1', [make('a'), make('b')])
  await store.accept('a')
  await store.accept('b')
  expect(store.confirmations.map((c) => c.id)).toEqual(['b', 'a'])
  store.close()
  expect(store.confirmations).toEqual([])
  store.setSnapshot('s1', [make('c')])
  await store.accept('c')
  store.reset()
  expect(store.confirmations).toEqual([])
})

it('the card is busy while the call is in flight', async () => {
  let release: (r: Result<AcceptOutcome>) => void = () => {}
  mockArc(() => new Promise((resolve) => (release = resolve)))
  store.setSnapshot('s1', [make('a')])
  const done = store.accept('a')
  expect(store.busyIds.has('a')).toBe(true)
  void store.accept('a')
  release({ ok: true, data: outcome })
  await done
  expect(store.busyIds.has('a')).toBe(false)
})

it.each([
  ['ITEM_NAME_TAKEN', undefined, { kind: 'name-taken' }],
  ['IO_FAILED', { location: '/notes' }, { kind: 'save-failed', location: '/notes' }],
  ['KNOWLEDGE_ROOT_MISSING', { location: '/gone' }, { kind: 'save-failed', location: '/gone' }],
  ['STORAGE_BUSY', undefined, { kind: 'storage-busy' }]
])('%s keeps the card and sets its problem', async (code, details, problem) => {
  mockArc(() => fail(code, details))
  store.setSnapshot('s1', [make('a')])
  await store.accept('a')
  expect(store.list.map((s) => s.id)).toEqual(['a'])
  expect(store.problems['a']).toEqual(problem)
  expect(store.confirmations).toEqual([])
  expect(store.busyIds.has('a')).toBe(false)
})

it('an unknown error keeps the card with its message', async () => {
  mockArc(() => fail('VALIDATION_FAILED'))
  store.setSnapshot('s1', [make('a')])
  await store.accept('a')
  expect(store.list).toHaveLength(1)
  expect(store.problems['a']?.kind).toBe('failed')
})

it('SUGGESTION_NOT_FOUND removes the card quietly', async () => {
  mockArc(() => fail('SUGGESTION_NOT_FOUND'))
  store.setSnapshot('s1', [make('a'), make('b')])
  await store.accept('a')
  expect(store.list.map((s) => s.id)).toEqual(['b'])
  expect(store.problems['a']).toBeUndefined()
  expect(store.confirmations).toEqual([])
})

it('a pushed list keeps the problem of a card still present and drops it for one that left', async () => {
  mockArc(() => fail('ITEM_NAME_TAKEN'))
  store.setSnapshot('s1', [make('a'), make('b')])
  await store.accept('a')
  await store.accept('b')
  store.apply({ sessionId: 's1', waiting: [make('a')] })
  expect(store.problems['a']).toEqual({ kind: 'name-taken' })
  expect(store.problems['b']).toBeUndefined()
})

it('Try again re-invokes and clears the problem on success', async () => {
  let n = 0
  const invoke = mockArc(() =>
    n++ === 0 ? fail('IO_FAILED', { location: '/notes' }) : { ok: true, data: outcome }
  )
  store.setSnapshot('s1', [make('a')])
  await store.accept('a')
  expect(store.problems['a']?.kind).toBe('save-failed')
  await store.accept('a')
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(store.problems['a']).toBeUndefined()
  expect(store.list).toEqual([])
})

it('reset clears problems and busy ids', async () => {
  mockArc(() => fail('ITEM_NAME_TAKEN'))
  store.setSnapshot('s1', [make('a')])
  await store.accept('a')
  store.reset()
  expect(store.problems).toEqual({})
  expect(store.busyIds.size).toBe(0)
})

const makeUpdate = (id: string, itemId: string | null = 'i1'): KnowledgeSuggestionView => ({
  ...make(id),
  kind: 'update',
  text: undefined,
  hunks: [],
  target: { itemId, name: 'Schema.md', relPath: 'Docs/Schema.md' }
})

it('EXTERNAL_MODIFIED sets changed and keeps the card', async () => {
  mockArc(() => fail('EXTERNAL_MODIFIED'))
  store.setSnapshot('s1', [makeUpdate('a')])
  await store.accept('a')
  expect(store.list).toHaveLength(1)
  expect(store.problems['a']).toEqual({ kind: 'changed' })
})

it('ITEM_NOT_FOUND on accept sets missing and keeps the card', async () => {
  mockArc(() => fail('ITEM_NOT_FOUND'))
  store.setSnapshot('s1', [makeUpdate('a')])
  await store.accept('a')
  expect(store.list).toHaveLength(1)
  expect(store.problems['a']).toEqual({ kind: 'missing' })
})

it('showCurrent stores the fetched text and clears with the problem', async () => {
  const invoke = mockArc((channel) =>
    channel === 'knowledge-suggestions:current'
      ? { ok: true, data: { text: 'live text' } }
      : { ok: true, data: outcome }
  )
  store.setSnapshot('s1', [makeUpdate('a')])
  await store.showCurrent('a')
  expect(invoke).toHaveBeenCalledWith('knowledge-suggestions:current', { id: 'a' })
  expect(store.currentTexts['a']).toBe('live text')
  await store.discard('a')
  expect(store.currentTexts['a']).toBeUndefined()
})

it('showCurrent turns into missing on ITEM_NOT_FOUND', async () => {
  mockArc(() => fail('ITEM_NOT_FOUND') as Result<unknown>)
  store.setSnapshot('s1', [makeUpdate('a')])
  await store.showCurrent('a')
  expect(store.problems['a']).toEqual({ kind: 'missing' })
  expect(store.currentTexts['a']).toBeUndefined()
})

it('addAsNew opens the editor for a missing note; accepting sends the name', async () => {
  let accepts = 0
  const invoke = mockArc((channel) => {
    if (channel === 'knowledge-suggestions:result-text') return { ok: true, data: { text: 'full' } }
    return accepts++ === 0
      ? (fail('ITEM_NOT_FOUND') as Result<unknown>)
      : { ok: true, data: outcome }
  })
  store.setSnapshot('s1', [makeUpdate('a')])
  await store.accept('a')
  expect(store.problems['a']).toEqual({ kind: 'missing' })
  await store.addAsNew('a')
  expect(store.editingId).toBe('a')
  expect(store.editsAsNew).toBe(true)
  expect(store.editSeedText).toBe('full')
  expect(invoke.mock.calls.filter((c) => c[0] === 'knowledge-suggestions:accept')).toHaveLength(1)
  await store.accept('a', { name: 'Schema' })
  expect(invoke).toHaveBeenLastCalledWith('knowledge-suggestions:accept', {
    id: 'a',
    edits: { name: 'Schema' }
  })
  expect(store.list).toEqual([])
  expect(store.editingId).toBeNull()
  expect(store.confirmations).toEqual([{ id: 'a', outcome }])
})

it('a name-taken reply in the editor keeps edit mode, marks the name and asks for focus', async () => {
  mockArc((channel) =>
    channel === 'knowledge-suggestions:result-text'
      ? { ok: true, data: { text: 'full' } }
      : (fail('ITEM_NAME_TAKEN') as Result<unknown>)
  )
  store.setSnapshot('s1', [makeUpdate('a')])
  await store.startEdit('a')
  const before = store.editFocus.n
  await store.accept('a', { name: 'Schema' })
  expect(store.list).toHaveLength(1)
  expect(store.editingId).toBe('a')
  expect(store.problems['a']).toEqual({ kind: 'name-taken' })
  expect(store.editFocus).toEqual({ field: 'name', n: before + 1 })
})

it('the unsaved-edits guard blocks the IPC call', async () => {
  const invoke = mockArc(() => ({ ok: true, data: outcome }))
  store.setSnapshot('s1', [makeUpdate('a', 'i1')])
  itemDraft.itemId = 'i1'
  itemDraft.dirty = true
  try {
    await store.accept('a')
    expect(invoke).not.toHaveBeenCalled()
    expect(store.problems['a']).toEqual({ kind: 'unsaved-edits' })
    expect(store.list).toHaveLength(1)
  } finally {
    itemDraft.itemId = null
    itemDraft.dirty = false
  }
})
