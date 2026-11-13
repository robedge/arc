import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import AttachmentChip from '../../src/renderer/src/lib/components/ui/AttachmentChip.svelte'
import AttachmentRow from '../../src/renderer/src/lib/components/ui/AttachmentRow.svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import { attachments, sessionKey } from '../../src/renderer/src/lib/stores/attachments.svelte'
import { formatBytes } from '../../src/renderer/src/lib/format-bytes'
import type { Result } from '../../src/shared/errors'
import type { SessionMessage } from '../../src/shared/types/session'
import { mockArc } from './helpers'

const DRAFT = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const DRAFT2 = '01HZZZZZZZZZZZZZZZZZZZZZZB'
const meta = (id: string, name: string, size = 100) => ({
  id,
  name,
  kind: 'text' as const,
  mime: 'text/plain',
  size
})

let invoke: ReturnType<typeof mockArc>
let drafts: string[]
let pickReply: () => Promise<Result<unknown>> | Result<unknown>

beforeEach(() => {
  attachments.reset()
  drafts = [DRAFT, DRAFT2]
  pickReply = () => ({
    ok: true,
    data: { attachments: [meta('01HZZZZZZZZZZZZZZZZZZZZZ01', 'a.txt', 2048)], refused: [] }
  })
  invoke = mockArc((channel) => {
    if (channel === 'attachments:new-draft') return { ok: true, data: { draftId: drafts.shift() } }
    if (channel === 'attachments:pick') return pickReply()
    return { ok: true, data: undefined }
  })
})
afterEach(cleanup)

const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)

it('formats sizes for people', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(2048)).toBe('2 KB')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
})

it('creates the draft lazily on the first pick and reuses it', async () => {
  const key = sessionKey('s1')
  expect(attachments.draftIdFor(key)).toBeNull()
  expect(attachments.list(key)).toEqual([])
  expect(calls('attachments:new-draft')).toHaveLength(0)
  expect(await attachments.pick(key)).toBeNull()
  expect(attachments.draftIdFor(key)).toBe(DRAFT)
  await attachments.pick(key)
  expect(calls('attachments:new-draft')).toHaveLength(1)
  expect(calls('attachments:pick')[0]![1]).toEqual({ draftId: DRAFT })
})

it('a pick adds ready items in order and keeps the refused ones on the draft', async () => {
  pickReply = () => ({
    ok: true,
    data: {
      attachments: [
        meta('01HZZZZZZZZZZZZZZZZZZZZZ01', 'a.txt'),
        meta('01HZZZZZZZZZZZZZZZZZZZZZ02', 'b.txt')
      ],
      refused: [{ name: 'x.zip', reason: 'unsupported' }]
    }
  })
  const key = sessionKey('s1')
  await attachments.pick(key)
  expect(attachments.list(key).map((i) => [i.name, i.state, i.id])).toEqual([
    ['a.txt', 'ready', '01HZZZZZZZZZZZZZZZZZZZZZ01'],
    ['b.txt', 'ready', '01HZZZZZZZZZZZZZZZZZZZZZ02']
  ])
  expect(attachments.refused(key)).toEqual([{ name: 'x.zip', reason: 'unsupported' }])
  expect(attachments.ready(key)).toHaveLength(2)
  expect(attachments.isStaging(key)).toBe(false)
})

it('is staging while the picker is open, and a cancelled picker adds nothing', async () => {
  let finish!: (r: Result<unknown>) => void
  pickReply = () => new Promise((resolve) => (finish = resolve))
  const key = sessionKey('s1')
  const pending = attachments.pick(key)
  await waitFor(() => expect(attachments.isStaging(key)).toBe(true))
  finish({ ok: true, data: { attachments: [], refused: [] } })
  await pending
  expect(attachments.isStaging(key)).toBe(false)
  expect(attachments.list(key)).toEqual([])
})

it('an in-flight result lands in the draft that started it after a switch', async () => {
  let finish!: (r: Result<unknown>) => void
  pickReply = () => new Promise((resolve) => (finish = resolve))
  const first = sessionKey('s1')
  const pending = attachments.pick(first)
  await waitFor(() => expect(calls('attachments:pick')).toHaveLength(1))
  // The user moves to another session and attaches there.
  pickReply = () => ({
    ok: true,
    data: { attachments: [meta('01HZZZZZZZZZZZZZZZZZZZZZ09', 'other.txt')], refused: [] }
  })
  await attachments.pick(sessionKey('s2'))
  finish({
    ok: true,
    data: { attachments: [meta('01HZZZZZZZZZZZZZZZZZZZZZ01', 'late.txt')], refused: [] }
  })
  await pending
  expect(attachments.list(first).map((i) => i.name)).toEqual(['late.txt'])
  expect(attachments.list(sessionKey('s2')).map((i) => i.name)).toEqual(['other.txt'])
})

it('returns the error of a failed pick and adds nothing', async () => {
  pickReply = () => ({ ok: false, error: { code: 'INTERNAL' } })
  const key = sessionKey('s1')
  expect(await attachments.pick(key)).toMatchObject({ code: 'INTERNAL' })
  expect(attachments.list(key)).toEqual([])
  expect(attachments.isStaging(key)).toBe(false)
})

it('remove drops the item and tells main; clear forgets the draft', async () => {
  const key = sessionKey('s1')
  await attachments.pick(key)
  const item = attachments.list(key)[0]!
  await attachments.remove(key, item.localId)
  expect(attachments.list(key)).toEqual([])
  expect(calls('attachments:remove')[0]![1]).toEqual({ draftId: DRAFT, id: item.id })
  await attachments.pick(key)
  attachments.clear(key)
  expect(attachments.list(key)).toEqual([])
  expect(attachments.draftIdFor(key)).toBeNull()
})

it('chip shows icon, truncated name with a title, size and a named remove button', async () => {
  let removed = 0
  const { container } = render(AttachmentChip, {
    name: 'a-very-long-report-name.pdf',
    size: 2048,
    onremove: () => removed++
  })
  const chip = container.querySelector('[data-attachment-chip]')!
  expect(chip.querySelector('[data-icon="file"]')).not.toBeNull()
  const name = chip.querySelector('[data-attachment-name]')!
  expect(name.textContent).toBe('a-very-long-report-name.pdf')
  expect(name.getAttribute('title')).toBe('a-very-long-report-name.pdf')
  expect(name.className).toContain('truncate')
  expect(chip.querySelector('[data-attachment-size]')?.textContent).toBe('2 KB')
  await fireEvent.click(screen.getByRole('button', { name: 'Remove a-very-long-report-name.pdf' }))
  expect(removed).toBe(1)
})

it('read-only chip has no remove button', () => {
  render(AttachmentChip, { name: 'a.txt', size: 10 })
  expect(screen.queryByRole('button')).toBeNull()
})

it('row lists the items and reports which one was removed', async () => {
  const removed: string[] = []
  render(AttachmentRow, {
    items: [
      { key: 'k1', name: 'a.txt', size: 10 },
      { key: 'k2', name: 'b.pdf', size: 20 }
    ],
    onremove: (key: string) => removed.push(key)
  })
  expect(screen.getByRole('list', { name: 'Attached files' })).not.toBeNull()
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  await fireEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }))
  expect(removed).toEqual(['k2'])
})

const message = (over: Partial<SessionMessage>): SessionMessage =>
  ({
    id: 1,
    sessionId: 's1',
    role: 'user',
    content: 'look at these',
    state: 'complete',
    planId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }) as SessionMessage

it('MessageBubble shows a read-only row after the text', () => {
  const { container } = render(MessageBubble, {
    message: message({
      attachments: [{ id: 'x', name: 'shot.txt', kind: 'text', size: 4096 }]
    })
  })
  expect(container.querySelector('p')?.textContent).toBe('look at these')
  expect(screen.getByText('shot.txt')).not.toBeNull()
  expect(screen.getByText('4 KB')).not.toBeNull()
  expect(screen.getByRole('list', { name: 'Attached files' })).not.toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

it('an attachments-only message has no empty text paragraph', () => {
  const { container } = render(MessageBubble, {
    message: message({
      content: '',
      attachments: [{ id: 'x', name: 'a.txt', kind: 'text', size: 5 }]
    })
  })
  expect(container.querySelector('p')).toBeNull()
  expect(screen.getByText('a.txt')).not.toBeNull()
})
