import { expect, it } from 'vitest'
import { canAcceptNow } from '../../src/renderer/src/lib/knowledge-suggestions/guards'
import type { KnowledgeSuggestionView } from '../../src/shared/types/knowledge-suggestion'

const base: KnowledgeSuggestionView = {
  id: 'k1',
  sessionId: 's1',
  kind: 'new',
  title: 't',
  reason: 'r',
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'a.md', relPath: null },
  text: 'x',
  createdAt: 1
}
const update = (itemId: string | null): KnowledgeSuggestionView => ({
  ...base,
  kind: 'update',
  target: { itemId, name: 'a.md', relPath: 'Notes/a.md' },
  hunks: []
})
const draft = (itemId: string | null, dirty: boolean, hasConflict: boolean) => ({
  itemId,
  dirty,
  hasConflict
})

it('a new note is always acceptable', () => {
  expect(canAcceptNow(base, draft('i1', true, true))).toBe(true)
})
it('an update on a different item is acceptable', () => {
  expect(canAcceptNow(update('i1'), draft('i2', true, true))).toBe(true)
})
it('the same item, clean, is acceptable', () => {
  expect(canAcceptNow(update('i1'), draft('i1', false, false))).toBe(true)
})
it('the same item, dirty, is blocked', () => {
  expect(canAcceptNow(update('i1'), draft('i1', true, false))).toBe(false)
})
it('the same item, in conflict, is blocked', () => {
  expect(canAcceptNow(update('i1'), draft('i1', false, true))).toBe(false)
})
it('an update with no item id is acceptable', () => {
  expect(canAcceptNow(update(null), draft(null, true, true))).toBe(true)
})
