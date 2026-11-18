import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import type { SessionMessage } from '../../src/shared/types/session'

afterEach(cleanup)

const notice: SessionMessage = {
  id: 7,
  sessionId: 's1',
  role: 'system',
  content: 'The brain stopped unexpectedly: the brain crashed',
  state: 'complete',
  planId: null,
  prompt: { kind: 'error-notice' },
  createdAt: 1,
  updatedAt: 1
}

it('draws a brain error notice as a danger-styled system bubble with the text', () => {
  const { container } = render(MessageBubble, { message: notice })
  const bubble = container.querySelector('[data-message-role="system"]') as HTMLElement
  expect(bubble).not.toBeNull()
  expect(bubble.hasAttribute('data-error-notice')).toBe(true)
  expect(bubble.textContent).toContain('The brain stopped unexpectedly: the brain crashed')
  expect(bubble.className).toContain('border-danger')
  expect(bubble.getAttribute('role')).toBe('alert')
})

it('an ordinary system message has no error styling', () => {
  const { container } = render(MessageBubble, {
    message: { ...notice, prompt: undefined, content: 'Hi' }
  })
  const bubble = container.querySelector('[data-message-role="system"]') as HTMLElement
  expect(bubble.hasAttribute('data-error-notice')).toBe(false)
  expect(bubble.className).not.toContain('border-danger')
})
