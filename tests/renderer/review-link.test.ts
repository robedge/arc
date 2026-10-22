import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Conversation from '../../src/renderer/src/lib/components/sessions/Conversation.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { SessionHeader as Header, SessionMessage } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

function msg(over: Partial<SessionMessage>): SessionMessage {
  return {
    id: 1,
    sessionId: 's1',
    role: 'brain',
    content: 'Everything is merged.',
    state: 'complete',
    planId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function load(messages: SessionMessage[], changedFileCount = 2): void {
  activeSession.setSnapshot({
    header,
    messages,
    events: [],
    brainState: 'idle',
    changedFileCount,
    plan: null,
    workers: [],
    attention: [],
    seq: 0
  })
}

beforeEach(() => {
  mockHarness(() => ({ ok: true, data: undefined }))
})

afterEach(() => {
  cleanup()
  activeSession.close()
  review.reset()
  vi.restoreAllMocks()
})

const link = (): HTMLElement | null => screen.queryByRole('button', { name: 'Review changes' })

it('shows the link after a tagged brain message and not after an untagged one', () => {
  load([msg({ id: 1 }), msg({ id: 2, prompt: { kind: 'review-link' } })])
  render(Conversation)
  expect(screen.getAllByRole('button', { name: 'Review changes' })).toHaveLength(1)
  const tagged = document.querySelectorAll('[data-message-role="brain"]')[1]
  expect(tagged?.contains(link())).toBe(true)
})

it('shows the link under the fallback system message', () => {
  load([
    msg({ id: 3, role: 'system', content: 'All work is merged.', prompt: { kind: 'review-link' } })
  ])
  render(Conversation)
  expect(document.querySelector('[data-message-role="system"]')?.contains(link())).toBe(true)
})

it('clicking the link opens the review for the session', async () => {
  const open = vi.spyOn(review, 'openReview').mockResolvedValue()
  load([msg({ prompt: { kind: 'review-link' } })])
  render(Conversation)
  await fireEvent.click(link()!)
  expect(open).toHaveBeenCalledWith('s1')
})

it('is disabled with a tooltip when nothing changed', async () => {
  const open = vi.spyOn(review, 'openReview').mockResolvedValue()
  load([msg({ prompt: { kind: 'review-link' } })], 0)
  render(Conversation)
  expect(link()!.getAttribute('aria-disabled')).toBe('true')
  expect(link()!.parentElement!.getAttribute('title')).toBe('No changes yet')
  await fireEvent.click(link()!)
  expect(open).not.toHaveBeenCalled()
})

it('a second push of the same message id adds the link', async () => {
  load([msg({ id: 5 })])
  render(Conversation)
  expect(link()).toBeNull()
  activeSession.applyMessage({
    sessionId: 's1',
    seq: 1,
    message: msg({ id: 5, prompt: { kind: 'review-link' } })
  })
  await waitFor(() => expect(link()).not.toBeNull())
  expect(activeSession.messages).toHaveLength(1)
})
