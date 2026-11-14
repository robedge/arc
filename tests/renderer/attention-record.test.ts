import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import { recordText } from '../../src/shared/attention-record'
import type { AttentionRecordPrompt, SessionMessage } from '../../src/shared/types/session'

afterEach(cleanup)

function recordMessage(prompt: AttentionRecordPrompt): SessionMessage {
  return {
    id: 1,
    sessionId: 's1',
    role: 'system',
    content: recordText(prompt),
    state: 'complete',
    planId: null,
    prompt,
    createdAt: 1,
    updatedAt: 1
  }
}

const approved: AttentionRecordPrompt = {
  kind: 'attention-record',
  decision: 'approved',
  subject: 'git push origin arc/fix',
  from: 'Brain'
}
const answered: AttentionRecordPrompt = {
  kind: 'attention-record',
  decision: 'answered',
  subject: 'Which database?',
  answer: 'Postgres',
  from: 'Worker 2'
}

it.each([
  [approved, 'Approved: git push origin arc/fix (Brain)'],
  [answered, 'Answered: Which database? → Postgres (Worker 2)']
])('draws a record as one quiet truncated line', (prompt, text) => {
  const { container } = render(MessageBubble, { message: recordMessage(prompt) })
  const records = container.querySelectorAll('[data-record]')
  expect(records).toHaveLength(1)
  const line = records[0] as HTMLElement
  expect(line.textContent?.trim()).toBe(text)
  expect(line.getAttribute('title')).toBe(text)
  expect(line.getAttribute('data-record-decision')).toBe(prompt.decision)
  expect(line.classList.contains('truncate')).toBe(true)
  expect(line.className).not.toMatch(/\bborder\b|bg-|rounded/)
  expect(container.querySelector('[data-message-role]')).toBeNull()
  expect(container.querySelector('button')).toBeNull()
})

it('an ordinary system message is still the bubble', () => {
  const message: SessionMessage = { ...recordMessage(approved), prompt: undefined, content: 'Hi' }
  const { container } = render(MessageBubble, { message })
  expect(container.querySelector('[data-record]')).toBeNull()
  expect(container.querySelector('[data-message-role="system"]')?.className).toContain('border')
})

const branchRecord: AttentionRecordPrompt = {
  kind: 'attention-record',
  decision: 'branch',
  subject: 'api',
  answer: 'Bring them along',
  from: 'Arc'
}

it('a failed record says it did not work and carries data-record-failed', () => {
  const { container } = render(MessageBubble, {
    message: recordMessage({ ...branchRecord, failed: true })
  })
  const line = container.querySelector('[data-record]') as HTMLElement
  expect(line.textContent?.trim()).toBe(
    'Unsaved changes in api: Bring them along did not work (Arc)'
  )
  expect(line.getAttribute('title')).toBe(line.textContent?.trim())
  expect(line.hasAttribute('data-record-failed')).toBe(true)
})

it('a record that did not fail has no data-record-failed', () => {
  const { container } = render(MessageBubble, { message: recordMessage(branchRecord) })
  expect(container.querySelector('[data-record]')?.hasAttribute('data-record-failed')).toBe(false)
})

it('a message pushed again with the same id replaces the line in place', async () => {
  const { container, rerender } = render(MessageBubble, { message: recordMessage(branchRecord) })
  await rerender({ message: recordMessage({ ...branchRecord, failed: true }) })
  const records = container.querySelectorAll('[data-record]')
  expect(records).toHaveLength(1)
  expect(records[0]?.textContent?.trim()).toBe(
    'Unsaved changes in api: Bring them along did not work (Arc)'
  )
  expect(records[0]?.hasAttribute('data-record-failed')).toBe(true)
})
