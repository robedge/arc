import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import BrainCard from '../../src/renderer/src/lib/components/sessions/BrainCard.svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'

afterEach(cleanup)

it('shows Waiting on you with the attention tone when the brain waits on the user', () => {
  const { container } = render(BrainCard, { state: 'waiting' })
  expect(screen.getByRole('status').textContent).toBe('Waiting on you')
  expect(container.querySelector('[data-tone="attention"]')).toBeTruthy()
})

it('shows Thinking and Idle', () => {
  const { unmount } = render(BrainCard, { state: 'thinking' })
  expect(screen.getByRole('status').textContent).toBe('Thinking')
  unmount()
  render(BrainCard, { state: 'idle' })
  expect(screen.getByRole('status').textContent).toBe('Idle')
})

it('conversation items never shrink inside the scrolling list', () => {
  const { container } = render(MessageBubble, {
    message: {
      id: 1,
      sessionId: 's',
      role: 'brain',
      content: 'hi',
      state: 'complete',
      planId: null,
      createdAt: 1,
      updatedAt: 1
    }
  })
  expect(container.querySelector('[data-message-role]')?.classList.contains('shrink-0')).toBe(true)
})

it('shows Claude (Codex unavailable) with the reason when the brain fell back', () => {
  render(BrainCard, {
    state: 'idle',
    runningOn: {
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: "Codex isn't signed in."
    }
  })
  const tag = document.querySelector('[data-brain-model]') as HTMLElement
  expect(tag.textContent).toContain('Claude (Codex unavailable)')
  expect(tag.getAttribute('title')).toBe("Codex isn't signed in.")
  expect(tag.textContent).toContain("Codex isn't signed in.")
})
