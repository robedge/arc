import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { readFileSync } from 'node:fs'
import AttentionBadge from '../../src/renderer/src/lib/components/ui/AttentionBadge.svelte'
import AttentionDialog from '../../src/renderer/src/lib/components/ui/attention/AttentionDialog.svelte'
import PermissionCard from '../../src/renderer/src/lib/components/ui/attention/PermissionCard.svelte'
import QuestionCard from '../../src/renderer/src/lib/components/ui/attention/QuestionCard.svelte'
import StructuredQuestionCard from '../../src/renderer/src/lib/components/ui/attention/StructuredQuestionCard.svelte'
import { motion } from '../../src/renderer/src/lib/stores/motion.svelte'
import type { AttentionRequest } from '../../src/renderer/src/lib/components/ui/attention/types'

const tokens = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-motion')
})

const requests: AttentionRequest[] = [
  {
    id: 'p1',
    kind: 'permission',
    from: 'W1 api-retry · via brain',
    action: 'rm -rf build',
    reason: 'Clean'
  },
  { id: 'q1', kind: 'question', from: 'W2 docs', question: 'Which branch?' }
]

function openDialog() {
  const fns = {
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onAlwaysAllow: vi.fn(),
    onAnswer: vi.fn(),
    onClose: vi.fn()
  }
  render(AttentionDialog, { open: true, requests, ...fns })
  return fns
}

function stubMotion(matches: boolean): () => void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  return motion.start()
}

it('badge names the count and pulses when motion is allowed', () => {
  const stop = stubMotion(false)
  render(AttentionBadge, { count: 2, onclick: () => {} })
  const badge = screen.getByRole('button', { name: 'Needs attention, 2 waiting' })
  expect(badge.getAttribute('data-pulse')).toBe('true')
  stop()
})

it('badge does not pulse when motion is reduced', () => {
  const stop = stubMotion(true)
  render(AttentionBadge, { count: 2, onclick: () => {} })
  expect(screen.getByRole('button', { name: /Needs attention/ }).hasAttribute('data-pulse')).toBe(
    false
  )
  stop()
})

it('badge click calls onclick', async () => {
  const onclick = vi.fn()
  render(AttentionBadge, { count: 1, onclick })
  await fireEvent.click(screen.getByRole('button'))
  expect(onclick).toHaveBeenCalledOnce()
})

it('Escape only calls onClose', async () => {
  const fns = openDialog()
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(fns.onClose).toHaveBeenCalledOnce()
  expect(fns.onApprove).not.toHaveBeenCalled()
  expect(fns.onDeny).not.toHaveBeenCalled()
  expect(fns.onAnswer).not.toHaveBeenCalled()
})

it('the Close button is labeled Close and only calls onClose', async () => {
  const fns = openDialog()
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(fns.onClose).toHaveBeenCalledOnce()
  expect(fns.onApprove).not.toHaveBeenCalled()
  expect(fns.onDeny).not.toHaveBeenCalled()
})

it('dialog titles the count and lists both cards in a scrolling list', () => {
  openDialog()
  expect(screen.getByRole('dialog', { name: 'Needs attention · 2' })).toBeTruthy()
  expect(document.querySelector('[data-attention-list]')!.className).toContain('overflow-y-auto')
  expect(document.querySelector('[data-kind="permission"]')).toBeTruthy()
  expect(document.querySelector('[data-kind="question"]')).toBeTruthy()
})

it('shows the action in a mono box', () => {
  render(PermissionCard, {
    id: 'p',
    from: 'W1',
    action: 'ls -la',
    onApprove: () => {},
    onDeny: () => {},
    onAlwaysAllow: () => {}
  })
  const box = screen.getByText('ls -la')
  expect(box.className).toContain('font-mono')
  expect(box.hasAttribute('data-action')).toBe(true)
})

it('Approve and Deny are at least 44px tall and report the id', async () => {
  const onApprove = vi.fn()
  const onDeny = vi.fn()
  render(PermissionCard, {
    id: 'p9',
    from: 'W1',
    action: 'x',
    onApprove,
    onDeny,
    onAlwaysAllow: () => {}
  })
  for (const name of ['Approve', 'Deny']) {
    expect(screen.getByRole('button', { name }).className).toContain('min-h-[var(--size-hit)]')
  }
  expect(tokens).toMatch(/--size-hit:\s*44px/)
  await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  expect(onApprove).toHaveBeenCalledWith('p9')
  expect(onDeny).toHaveBeenCalledWith('p9')
})

it('Send is disabled while the answer is empty and sends the text', async () => {
  const onSend = vi.fn()
  render(QuestionCard, { id: 'q', from: 'W2', question: 'Which?', onSend })
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  const input = screen.getByLabelText('Your answer')
  await fireEvent.input(input, { target: { value: '   ' } })
  expect(send.disabled).toBe(true)
  await fireEvent.input(input, { target: { value: 'main' } })
  expect(send.disabled).toBe(false)
  await fireEvent.click(send)
  expect(onSend).toHaveBeenCalledWith('q', 'main')
})

it('Always allow reports the id and is a 44px target', async () => {
  const onAlwaysAllow = vi.fn()
  render(PermissionCard, {
    id: 'p5',
    from: 'W1',
    action: 'x',
    onApprove: () => {},
    onDeny: () => {},
    onAlwaysAllow
  })
  const button = screen.getByRole('button', { name: 'Always allow this in this session' })
  expect(button.className).toContain('min-h-[var(--size-hit)]')
  await fireEvent.click(button)
  expect(onAlwaysAllow).toHaveBeenCalledWith('p5')
})

const single = {
  question: 'Where should the review open?',
  header: 'Review',
  multiSelect: false,
  options: [{ label: 'In the app', description: 'Opens in Arc.' }, { label: 'In the editor' }]
}
const multi = {
  question: 'Which colors?',
  header: 'Colors',
  multiSelect: true,
  options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
}

function renderStructured(questions: (typeof single)[]) {
  const onSubmit = vi.fn()
  const onDecline = vi.fn()
  render(StructuredQuestionCard, {
    id: 'sq1',
    from: 'W2 · /awos:spec',
    questions,
    onSubmit,
    onDecline
  })
  return { onSubmit, onDecline }
}

it('structured: Submit stays disabled until every question has an answer', async () => {
  renderStructured([single, multi as never])
  const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  await fireEvent.click(screen.getByRole('button', { name: /In the app/ }))
  expect(submit.disabled).toBe(true)
  await fireEvent.click(screen.getByLabelText('Red'))
  expect(submit.disabled).toBe(false)
  await fireEvent.click(screen.getByLabelText('Red'))
  expect(submit.disabled).toBe(true)
})

it('structured: shows label, header, descriptions and sends one chosen label', async () => {
  const { onSubmit } = renderStructured([single])
  expect(screen.getByText('W2 · /awos:spec')).toBeTruthy()
  expect(screen.getByText('Review')).toBeTruthy()
  expect(screen.getByText('Opens in Arc.')).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: /In the editor/ }))
  await fireEvent.click(screen.getByRole('button', { name: /In the app/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(onSubmit).toHaveBeenCalledWith('sq1', { 'Where should the review open?': ['In the app'] })
})

it('structured: multi-select sends the chosen labels as an array', async () => {
  const { onSubmit } = renderStructured([multi as never])
  await fireEvent.click(screen.getByLabelText('Red'))
  await fireEvent.click(screen.getByLabelText('Blue'))
  await fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(onSubmit).toHaveBeenCalledWith('sq1', { 'Which colors?': ['Red', 'Blue'] })
})

it('structured: typed Other text replaces the choice and clearing restores it', async () => {
  const { onSubmit } = renderStructured([single])
  await fireEvent.click(screen.getByRole('button', { name: /In the app/ }))
  const other = screen.getByLabelText('Other')
  await fireEvent.input(other, { target: { value: ' somewhere else ' } })
  expect(screen.getByRole('button', { name: /In the app/ }).getAttribute('aria-pressed')).toBe(
    'false'
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(onSubmit).toHaveBeenLastCalledWith('sq1', {
    'Where should the review open?': ['somewhere else']
  })
  await fireEvent.input(other, { target: { value: '' } })
  expect(screen.getByRole('button', { name: /In the app/ }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})

it('structured: two questions go in one submit', async () => {
  const { onSubmit } = renderStructured([single, multi as never])
  await fireEvent.click(screen.getByRole('button', { name: /In the editor/ }))
  await fireEvent.click(screen.getByLabelText('Green'))
  await fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith('sq1', {
    'Where should the review open?': ['In the editor'],
    'Which colors?': ['Green']
  })
})

it('structured: Decline sends decline and an error stays on the card', async () => {
  const onDecline = vi.fn().mockResolvedValue('Could not decline.')
  render(StructuredQuestionCard, {
    id: 'sq1',
    from: 'W2',
    questions: [single],
    onSubmit: vi.fn(),
    onDecline
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
  expect(onDecline).toHaveBeenCalledWith('sq1')
  expect((await screen.findByRole('alert')).textContent).toContain('Could not decline.')
  expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
})

it('dialog mounts the structured card only for questions with questions[]; plain stays', () => {
  const fns = {
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onAlwaysAllow: vi.fn(),
    onAnswer: vi.fn(),
    onClose: vi.fn()
  }
  render(AttentionDialog, {
    open: true,
    requests: [
      { id: 'q1', kind: 'question', from: 'W2 docs', question: 'Which branch?' },
      { id: 'sq', kind: 'question', from: 'W3', question: 'x', questions: [single] }
    ],
    ...fns
  })
  expect(document.querySelectorAll('[data-kind="question"]').length).toBe(2)
  expect(document.querySelectorAll('[data-structured]').length).toBe(1)
  expect(screen.getByLabelText('Your answer')).toBeTruthy()
})

it('structured: the submitted answers can cross the IPC bridge (structured clone)', async () => {
  const { onSubmit } = renderStructured([multi as never])
  await fireEvent.click(screen.getByLabelText('Red'))
  await fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  const payload = onSubmit.mock.calls[0]![1] as Record<string, string[]>
  expect(structuredClone(payload)).toEqual({ 'Which colors?': ['Red'] })
})
