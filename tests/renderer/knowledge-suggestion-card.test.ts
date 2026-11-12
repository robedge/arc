import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import KnowledgeSuggestionCard from '../../src/renderer/src/lib/components/knowledge-suggestions/KnowledgeSuggestionCard.svelte'
import { destinationText } from '../../src/renderer/src/lib/knowledge-suggestions/destination'
import type { DiffHunk } from '../../src/shared/types/review'
import type { KnowledgeSuggestionView } from '../../src/shared/types/knowledge-suggestion'

afterEach(cleanup)

const base: KnowledgeSuggestionView = {
  id: 'k1',
  sessionId: 's1',
  kind: 'new',
  title: 'Service map',
  reason: 'Found while tracing checkout.',
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'Service map.md', relPath: null },
  text: 'line one\nline two',
  createdAt: 1
}

it('drops a trailing .md from a new note name', () => {
  render(KnowledgeSuggestionCard, { suggestion: base, ondiscard: vi.fn(), onaccept: vi.fn() })
  expect(screen.getByText('Notes › New note: Service map')).toBeTruthy()
})

it('keeps other extensions', () => {
  const s = { ...base, target: { ...base.target, name: 'schema.sql' } }
  expect(destinationText(s)).toBe('Notes › New note: schema.sql')
})

it('words an update as section › note', () => {
  const s: KnowledgeSuggestionView = {
    ...base,
    kind: 'update',
    sectionName: 'Docs',
    target: { itemId: 'i1', name: 'Database schema.md', relPath: 'Docs/Database schema.md' },
    text: undefined,
    hunks: []
  }
  render(KnowledgeSuggestionCard, { suggestion: s, ondiscard: vi.fn(), onaccept: vi.fn() })
  expect(screen.getByText('Docs › Database schema')).toBeTruthy()
  expect(document.querySelector('pre')).toBeNull()
})

it('shows the new note text in a pre and discards by id', async () => {
  const ondiscard = vi.fn()
  render(KnowledgeSuggestionCard, { suggestion: base, ondiscard, onaccept: vi.fn() })
  expect(document.querySelector('pre')?.textContent).toBe('line one\nline two')
  expect(screen.getByRole('article', { name: /Service map/ })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: /Discard/ }))
  expect(ondiscard).toHaveBeenCalledWith('k1')
})

const update: KnowledgeSuggestionView = {
  ...base,
  kind: 'update',
  target: { itemId: 'i1', name: 'Database schema.md', relPath: 'Docs/Database schema.md' },
  text: undefined,
  hunks: []
}

it('shows Accept, Edit, Discard in that order with titled names', () => {
  render(KnowledgeSuggestionCard, { suggestion: base, ondiscard: vi.fn(), onaccept: vi.fn() })
  const buttons = screen.getAllByRole('button')
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
    'Accept: Service map',
    'Edit: Service map',
    'Discard: Service map'
  ])
  expect(screen.getByRole('button', { name: 'Accept: Service map' }).textContent?.trim()).toBe(
    'Accept'
  )
})

it('Accept calls onaccept with the id', async () => {
  const onaccept = vi.fn()
  render(KnowledgeSuggestionCard, { suggestion: base, ondiscard: vi.fn(), onaccept })
  await fireEvent.click(screen.getByRole('button', { name: 'Accept: Service map' }))
  expect(onaccept).toHaveBeenCalledWith('k1')
})

it('Accept is disabled while busy', () => {
  render(KnowledgeSuggestionCard, {
    suggestion: base,
    ondiscard: vi.fn(),
    onaccept: vi.fn(),
    busy: true
  })
  expect(
    (screen.getByRole('button', { name: 'Accept: Service map' }) as HTMLButtonElement).disabled
  ).toBe(true)
})

it('name-taken shows its message and no retry', () => {
  render(KnowledgeSuggestionCard, {
    suggestion: base,
    ondiscard: vi.fn(),
    onaccept: vi.fn(),
    problem: { kind: 'name-taken' }
  })
  expect(screen.getByRole('alert').textContent).toContain('A note with this name already exists.')
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

it('save-failed names the location and offers Try again', async () => {
  const onaccept = vi.fn()
  render(KnowledgeSuggestionCard, {
    suggestion: base,
    ondiscard: vi.fn(),
    onaccept,
    problem: { kind: 'save-failed', location: '/Users/me/notes' }
  })
  expect(screen.getByRole('alert').textContent).toContain("Couldn't save to /Users/me/notes.")
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onaccept).toHaveBeenCalledWith('k1')
})

it('storage-busy has its own message and Try again', async () => {
  const onaccept = vi.fn()
  render(KnowledgeSuggestionCard, {
    suggestion: base,
    ondiscard: vi.fn(),
    onaccept,
    problem: { kind: 'storage-busy' }
  })
  expect(screen.getByRole('alert').textContent).toContain('Storage is being moved')
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onaccept).toHaveBeenCalledWith('k1')
})

it('an unknown failure shows its message', () => {
  render(KnowledgeSuggestionCard, {
    suggestion: base,
    ondiscard: vi.fn(),
    onaccept: vi.fn(),
    problem: { kind: 'failed', message: 'Something went wrong. Please try again.' }
  })
  expect(screen.getByRole('alert').textContent).toContain('Something went wrong.')
})

const hunks: DiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
      { kind: 'del', oldNo: 2, text: 'old line' },
      { kind: 'add', newNo: 2, text: 'new line' }
    ]
  }
]
const withHunks: KnowledgeSuggestionView = { ...update, hunks }
const props = () => ({ ondiscard: vi.fn(), onaccept: vi.fn() })

it('an update card shows the diff under "Changes to" and an Accept button', () => {
  render(KnowledgeSuggestionCard, { suggestion: withHunks, ...props() })
  expect(screen.getByRole('region', { name: 'Changes to Database schema' })).toBeTruthy()
  expect(document.querySelector('[data-diff-line="add"]')).toBeTruthy()
  expect(document.querySelector('[data-diff-line="del"]')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Accept/ })).toBeTruthy()
})

it('empty hunks say the note is too large and still offer Accept', () => {
  render(KnowledgeSuggestionCard, { suggestion: update, ...props() })
  expect(screen.getByText('This note is too large to show the changes here.')).toBeTruthy()
  expect(document.querySelector('[data-diff-snippet]')).toBeNull()
  expect(screen.getByRole('button', { name: /^Accept/ })).toBeTruthy()
})

it('changed shows its message with Show current and Discard, and no Accept or Try again', async () => {
  const onshowcurrent = vi.fn()
  render(KnowledgeSuggestionCard, {
    suggestion: withHunks,
    ...props(),
    onshowcurrent,
    problem: { kind: 'changed' }
  })
  expect(screen.getByRole('alert').textContent).toContain(
    'This note has changed since the suggestion was made.'
  )
  expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(screen.getByRole('button', { name: /^Discard/ })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Show current' }))
  expect(onshowcurrent).toHaveBeenCalledWith('k1')
})

it('Show current text renders in a read-only labelled block', () => {
  render(KnowledgeSuggestionCard, {
    suggestion: withHunks,
    ...props(),
    problem: { kind: 'changed' },
    currentText: 'the live note\nsecond'
  })
  const block = screen.getByRole('region', { name: 'Current note' })
  expect(block.textContent).toBe('the live note\nsecond')
  expect(block.getAttribute('tabindex')).toBe('0')
  expect(block.hasAttribute('data-current-note')).toBe(true)
})

it('missing offers Add as a new note and Discard, no Accept', async () => {
  const onaddasnew = vi.fn()
  render(KnowledgeSuggestionCard, {
    suggestion: withHunks,
    ...props(),
    onaddasnew,
    problem: { kind: 'missing' }
  })
  expect(screen.getByRole('alert').textContent).toContain('This note no longer exists.')
  expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^Discard/ })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Add as a new note' }))
  expect(onaddasnew).toHaveBeenCalledWith('k1')
})

it('unsaved-edits shows its message and keeps Accept', () => {
  render(KnowledgeSuggestionCard, {
    suggestion: withHunks,
    ...props(),
    problem: { kind: 'unsaved-edits' }
  })
  expect(screen.getByRole('alert').textContent).toContain(
    'Save or discard your edits to this note first.'
  )
  expect(screen.getByRole('button', { name: /^Accept/ })).toBeTruthy()
})
