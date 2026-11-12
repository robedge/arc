import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Conversation from '../../src/renderer/src/lib/components/sessions/Conversation.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { knowledgeSuggestions } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import { suggestionsLine } from '../../src/renderer/src/lib/knowledge-suggestions/line'
import type { KnowledgeSuggestionView } from '../../src/shared/types/knowledge-suggestion'
import type { SessionHeader as Header, SessionMessage } from '../../src/shared/types/session'
import { mockArc } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

const waiting = (id: string): KnowledgeSuggestionView => ({
  id,
  sessionId: 's1',
  kind: 'new',
  title: `Title ${id}`,
  reason: 'Learned it.',
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'Service map.md', relPath: null },
  text: 'body',
  createdAt: 1
})

function msg(over: Partial<SessionMessage>): SessionMessage {
  return {
    id: 1,
    sessionId: 's1',
    role: 'brain',
    content: 'Noted a few things.',
    state: 'complete',
    planId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function load(messages: SessionMessage[], waitingCount: number): void {
  const list = Array.from({ length: waitingCount }, (_, i) => waiting(`k${i}`))
  activeSession.setSnapshot({
    header,
    messages,
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers: [],
    attention: [],
    knowledgeSuggestions: list,
    seq: 0
  })
  knowledgeSuggestions.setSnapshot('s1', list)
}

beforeEach(() => {
  mockArc(() => ({ ok: true, data: undefined }))
  knowledgeSuggestions.reset()
})
afterEach(() => {
  cleanup()
  activeSession.close()
  knowledgeSuggestions.reset()
})

const PLURAL = "I have 2 suggestions for this group's knowledge."
const SINGULAR = "I have 1 suggestion for this group's knowledge."
const line = (): HTMLElement | null => document.querySelector('[data-knowledge-suggestions-line]')

it('helper words the sentence from the count', () => {
  expect(suggestionsLine(2)).toBe(PLURAL)
  expect(suggestionsLine(1)).toBe(SINGULAR)
})

it('renders a button with the plural sentence that opens the dialog', async () => {
  load([msg({ prompt: { kind: 'knowledge-suggestions', count: 2 } })], 2)
  render(Conversation)
  const button = screen.getByRole('button', { name: PLURAL })
  expect(button.hasAttribute('data-knowledge-suggestions-line')).toBe(true)
  expect(knowledgeSuggestions.dialogOpen).toBe(false)
  await fireEvent.click(button)
  expect(knowledgeSuggestions.dialogOpen).toBe(true)
})

it('uses the singular sentence for one', () => {
  load([msg({ prompt: { kind: 'knowledge-suggestions', count: 1 } })], 1)
  render(Conversation)
  expect(screen.getByRole('button', { name: SINGULAR })).toBeTruthy()
})

it('a system message shows the sentence once, as the line', () => {
  load(
    [msg({ role: 'system', content: PLURAL, prompt: { kind: 'knowledge-suggestions', count: 2 } })],
    2
  )
  render(Conversation)
  expect(screen.getAllByText(PLURAL)).toHaveLength(1)
  expect(screen.getByRole('button', { name: PLURAL })).toBeTruthy()
})

it('with nothing waiting the sentence is plain text, not a button', () => {
  load([msg({ prompt: { kind: 'knowledge-suggestions', count: 2 } })], 0)
  render(Conversation)
  expect(line()?.textContent?.trim()).toBe(PLURAL)
  expect(screen.queryByRole('button')).toBeNull()
})

it('plain and review-link messages render as before', () => {
  load([msg({ id: 1 }), msg({ id: 2, prompt: { kind: 'review-link' } })], 2)
  render(Conversation)
  expect(line()).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Review changes' })).toHaveLength(1)
})
