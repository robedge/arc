import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { attachments } from '../../src/renderer/src/lib/stores/attachments.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import type { Result } from '../../src/shared/errors'
import { mockArc } from './helpers'

const DRAFT = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const A = '01HZZZZZZZZZZZZZZZZZZZZZ01'
const B = '01HZZZZZZZZZZZZZZZZZZZZZ02'
const meta = (id: string, name: string, size: number) => ({
  id,
  name,
  kind: 'text' as const,
  mime: 'text/plain',
  size
})

let invoke: ReturnType<typeof mockArc>
let sendReply: Result<unknown>
let pickReply: () => Promise<Result<unknown>> | Result<unknown>

beforeEach(() => {
  sendReply = {
    ok: true,
    data: { messageId: 7, attachments: [{ id: 'm1', name: 'a.txt', kind: 'text', size: 2048 }] }
  }
  pickReply = () => ({
    ok: true,
    data: { attachments: [meta(A, 'a.txt', 2048), meta(B, 'b.txt', 10)], refused: [] }
  })
  invoke = mockArc((channel) => {
    if (channel === 'attachments:new-draft') return { ok: true, data: { draftId: DRAFT } }
    if (channel === 'attachments:pick') return pickReply()
    if (channel === 'sessions:send-message') return sendReply
    if (channel === 'commands:list') return { ok: true, data: [] }
    return { ok: true, data: undefined }
  })
  attachments.reset()
  providers.reset()
  activeSession.close()
  activeSession.sessionId = 's1'
  activeSession.setDraft('s1', '')
})
afterEach(cleanup)

const sent = () => invoke.mock.calls.filter(([c]) => c === 'sessions:send-message')
const box = () => screen.getByLabelText('Message to the brain') as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
const clip = () => screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement
const attach = async () => {
  await fireEvent.click(clip())
  await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0))
}

it('has an Attach files button with the paperclip icon next to Send', () => {
  const { container } = render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(clip().querySelector('[data-icon="paperclip"]')).not.toBeNull()
  expect(clip().nextElementSibling).toBe(sendButton())
  expect(container.querySelector('textarea')!.parentElement!.contains(clip())).toBe(false)
})

it('the picker adds the files under the box with name and size', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach()
  expect(screen.getByText('a.txt')).not.toBeNull()
  expect(screen.getByText('2 KB')).not.toBeNull()
  expect(screen.getByText('b.txt')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Remove a.txt' })).not.toBeNull()
})

it('Send is enabled with attachments only', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(sendButton().disabled).toBe(true)
  await attach()
  expect(sendButton().disabled).toBe(false)
})

it('Send is disabled while a file is staging', async () => {
  let finish!: (r: Result<unknown>) => void
  pickReply = () => new Promise((resolve) => (finish = resolve))
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: 'hi' } })
  await fireEvent.click(clip())
  await waitFor(() => expect(sendButton().disabled).toBe(true))
  await fireEvent.keyDown(box(), { key: 'Enter' })
  expect(sent()).toHaveLength(0)
  finish({ ok: true, data: { attachments: [], refused: [] } })
  await waitFor(() => expect(sendButton().disabled).toBe(false))
})

it('Enter sends attachments only, with the draft id and ordered ids, and shows the returned files', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach()
  await fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() => expect(sent()).toHaveLength(1))
  expect(sent()[0]![1]).toEqual({
    sessionId: 's1',
    text: '',
    draftId: DRAFT,
    attachmentIds: [A, B]
  })
  await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0))
  expect(activeSession.messages.at(-1)).toMatchObject({
    id: 7,
    content: '',
    attachments: [{ id: 'm1', name: 'a.txt', kind: 'text', size: 2048 }]
  })
  expect(attachments.draftIdFor('session:s1')).toBeNull()
})

it('removing a file leaves the others in the request', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach()
  await fireEvent.click(screen.getByRole('button', { name: 'Remove a.txt' }))
  await fireEvent.input(box(), { target: { value: 'go' } })
  await fireEvent.click(sendButton())
  await waitFor(() => expect(sent()).toHaveLength(1))
  expect(sent()[0]![1]).toEqual({ sessionId: 's1', text: 'go', draftId: DRAFT, attachmentIds: [B] })
})

it('keeps text and attachments and shows the message when the send fails', async () => {
  sendReply = { ok: false, error: { code: 'ATTACHMENT_UNREADABLE', details: { name: 'a.txt' } } }
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: 'keep' } })
  await attach()
  await fireEvent.click(sendButton())
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('a.txt'))
  expect(box().value).toBe('keep')
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
})

it.each([
  ['ATTACHMENTS_WITH_COMMAND', "Attachments can't be sent with a command.", '/review'],
  ['ATTACHMENTS_WITH_PLAN_FEEDBACK', "Attachments can't be added to plan feedback.", 'change it']
])('%s keeps the text and every attachment and marks nothing', async (code, message, typed) => {
  sendReply = { ok: false, error: { code } as never }
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: typed } })
  await attach()
  await fireEvent.click(sendButton())
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message))
  expect(sent()[0]![1]).toMatchObject({ text: typed, draftId: DRAFT, attachmentIds: [A, B] })
  expect(box().value).toBe(typed)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(document.querySelectorAll('[data-attachment-state="error"]')).toHaveLength(0)
  expect(sendButton().disabled).toBe(false)
})

it('the paperclip is disabled while sending', async () => {
  let finish!: (r: Result<unknown>) => void
  sendReply = undefined as never
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'attachments:new-draft') return { ok: true, data: { draftId: DRAFT } }
    if (channel === 'attachments:pick') return pickReply()
    return new Promise((resolve) => (finish = resolve))
  })
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach()
  await fireEvent.click(sendButton())
  await waitFor(() => expect(clip().disabled).toBe(true))
  finish({ ok: true, data: { messageId: 1, attachments: [] } })
  await waitFor(() => expect(clip().disabled).toBe(false))
})

it('the draft survives a remount (session switch)', async () => {
  const first = render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach()
  first.unmount()
  const other = render(Composer, { sessionId: 's2', brainState: 'idle' })
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  other.unmount()
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(sendButton().disabled).toBe(false)
})

it('has accessible names and no unlabelled controls (a11y sweep)', async () => {
  const { container } = render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach()
  for (const control of container.querySelectorAll('button, textarea')) {
    const name = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? ''
    const labelled = (control as HTMLTextAreaElement).labels?.length ?? 0
    expect(name.length > 0 || labelled > 0).toBe(true)
  }
  for (const svg of container.querySelectorAll('svg')) {
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  }
  expect(container.querySelector('ul[aria-label="Attached files"]')).not.toBeNull()
})
