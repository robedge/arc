import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import AttachmentRow from '../../src/renderer/src/lib/components/ui/AttachmentRow.svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import DropZone from '../../src/renderer/src/lib/components/ui/DropZone.svelte'
import { createRawSnippet } from 'svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { attachments } from '../../src/renderer/src/lib/stores/attachments.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { attachmentUrl } from '../../src/renderer/src/lib/attachment-url'
import { extractPasted } from '../../src/renderer/src/lib/attach-input'
import type { Result } from '../../src/shared/errors'
import type { SessionMessage } from '../../src/shared/types/session'
import PreviewInModal from './fixtures/PreviewInModal.svelte'
import { mockArc } from './helpers'

const DRAFT = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const idOf = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`

let invoke: ReturnType<typeof mockArc>
let counter: number
let pastedCount: number
let bytesReply: (() => Promise<Result<unknown>>) | null
const filePaths = new Map<File, string>()

const stored = (name: string, kind: 'image' | 'text' = 'text') => ({
  id: idOf(++counter),
  name,
  kind,
  mime: kind === 'image' ? 'image/png' : 'text/plain',
  size: 100
})

beforeEach(() => {
  counter = 0
  pastedCount = 0
  bytesReply = null
  filePaths.clear()
  invoke = mockArc((channel, request) => {
    if (channel === 'attachments:new-draft') return { ok: true, data: { draftId: DRAFT } }
    if (channel === 'attachments:stage-paths') {
      const { paths } = request as { paths: string[] }
      return {
        ok: true,
        data: { attachments: paths.map((p) => stored(p.split('/').pop()!)), refused: [] }
      }
    }
    if (channel === 'attachments:stage-bytes') {
      if (bytesReply) return bytesReply()
      return {
        ok: true,
        data: { attachments: [stored(`Pasted image ${++pastedCount}`, 'image')], refused: [] }
      }
    }
    return { ok: true, data: undefined }
  })
  ;(window.arc.getPathForFile as Mock).mockImplementation((file: File) => filePaths.get(file) ?? '')
  attachments.reset()
  providers.reset()
  activeSession.close()
  activeSession.sessionId = 's1'
  activeSession.setDraft('s1', '')
})
afterEach(cleanup)

const box = () => screen.getByLabelText('Message to the brain') as HTMLTextAreaElement
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)
const withPath = (path: string) => {
  const file = new File(['x'], path.split('/').pop()!, { type: 'text/plain' })
  filePaths.set(file, path)
  return file
}
const screenshot = () => new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
const clipboard = (files: File[], text = '') => ({
  clipboardData: { files, getData: (type: string) => (type === 'text/plain' ? text : '') }
})
/** True when the default paste was left alone. */
const paste = (files: File[], text = '') => fireEvent.paste(box(), clipboard(files, text))

// ---- paste rules

it('rule 1: text only is left to the browser and stages nothing', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(await paste([], 'hello')).toBe(true)
  expect(calls('attachments:stage-paths')).toHaveLength(0)
  expect(calls('attachments:stage-bytes')).toHaveLength(0)
})

it('rule 2: a Finder file with a path is staged by path, default prevented', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(await paste([withPath('/Users/me/notes.txt')], 'notes.txt')).toBe(false)
  await waitFor(() => expect(screen.getByText('notes.txt')).not.toBeNull())
  expect(calls('attachments:stage-paths')[0]![1]).toEqual({
    draftId: DRAFT,
    paths: ['/Users/me/notes.txt']
  })
  expect(box().value).toBe('')
})

it('rule 3: a screenshot is staged as bytes with the blob type, default prevented', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(await paste([screenshot()])).toBe(false)
  await waitFor(() => expect(screen.getByText('Pasted image 1')).not.toBeNull())
  const request = calls('attachments:stage-bytes')[0]![1] as {
    bytes: Uint8Array
    mime: string
  }
  expect(request.bytes).toBeInstanceOf(Uint8Array)
  expect([...request.bytes]).toEqual([1, 2, 3])
  expect(request.mime).toBe('image/png')
})

it('rule 4: a path-less image with text/plain is treated as text', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(await paste([screenshot()], 'a\tb\n1\t2')).toBe(true)
  expect(calls('attachments:stage-bytes')).toHaveLength(0)
  expect(attachments.list('session:s1')).toEqual([])
})

it('rule 5: mixed path and path-less files stage both, and only then is the default prevented', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(await paste([withPath('/Users/me/a.txt'), screenshot()], 'a.txt')).toBe(false)
  await waitFor(() => expect(screen.getByText('Pasted image 1')).not.toBeNull())
  expect(screen.getByText('a.txt')).not.toBeNull()
})

it('a path-less file that is not an image attaches nothing and is reported as unreadable', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  const blob = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
  expect(await paste([blob])).toBe(false)
  expect(calls('attachments:stage-bytes')).toHaveLength(0)
  await waitFor(() =>
    expect(attachments.refused('session:s1')).toEqual([{ name: 'x.bin', reason: 'unreadable' }])
  )
})

it('extractPasted returns nothing for a null clipboard', () => {
  expect(extractPasted(null)).toEqual({ paths: [], images: [], unreadable: [] })
})

it('two pasted screenshots are listed as Pasted image 1 and Pasted image 2', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await paste([screenshot(), screenshot()])
  await waitFor(() => expect(screen.getByText('Pasted image 2')).not.toBeNull())
  const names = [...document.querySelectorAll('[data-attachment-name]')].map((n) => n.textContent)
  expect(names).toEqual(['Pasted image 1', 'Pasted image 2'])
  expect(calls('attachments:stage-bytes')).toHaveLength(2)
})

it('shows a staging chip while the call is in flight', async () => {
  let finish!: (r: Result<unknown>) => void
  bytesReply = () => new Promise((resolve) => (finish = resolve))
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await paste([screenshot()])
  await waitFor(() =>
    expect(document.querySelector('[data-attachment-state="staging"]')).not.toBeNull()
  )
  expect(attachments.isStaging('session:s1')).toBe(true)
  finish({ ok: true, data: { attachments: [stored('Pasted image 1', 'image')], refused: [] } })
  await waitFor(() =>
    expect(document.querySelector('[data-attachment-state="staging"]')).toBeNull()
  )
  expect(screen.getByText('Pasted image 1')).not.toBeNull()
})

// ---- drop

const dropEvent = (files: File[]) => ({ dataTransfer: { types: ['Files'], files } })
const zone = () => document.querySelector('[data-attach-field]')!.parentElement!

it('shows "Drop to attach" while files are dragged over and hides it on leave', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(screen.queryByText('Drop to attach')).toBeNull()
  await fireEvent.dragEnter(zone(), dropEvent([]))
  expect(screen.getByText('Drop to attach')).not.toBeNull()
  await fireEvent.dragLeave(zone(), { relatedTarget: null })
  expect(screen.queryByText('Drop to attach')).toBeNull()
})

it('a drop attaches two files by path', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.drop(zone(), dropEvent([withPath('/a/one.txt'), withPath('/a/two.txt')]))
  await waitFor(() => expect(screen.getByText('two.txt')).not.toBeNull())
  expect(screen.getByText('one.txt')).not.toBeNull()
  expect(calls('attachments:stage-paths')[0]![1]).toEqual({
    draftId: DRAFT,
    paths: ['/a/one.txt', '/a/two.txt']
  })
})

it('a dropped file with no path is recorded as unreadable, the others still attach', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  const web = new File(['x'], 'from-browser.png', { type: 'image/png' })
  await fireEvent.drop(zone(), dropEvent([withPath('/a/one.txt'), web]))
  await waitFor(() => expect(attachments.list('session:s1')).toHaveLength(1))
  await waitFor(() =>
    expect(attachments.refused('session:s1')).toEqual([
      { name: 'from-browser.png', reason: 'unreadable' }
    ])
  )
})

it('a drop of only path-less files is recorded, not silently lost', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.drop(zone(), dropEvent([new File(['x'], 'a.png'), new File(['y'], 'b.png')]))
  await waitFor(() => expect(attachments.refused('session:s1')).toHaveLength(2))
  expect(calls('attachments:stage-paths')).toHaveLength(0)
})

it('DropZone without a label looks and behaves as before', async () => {
  const ondrop = vi.fn()
  const child = createRawSnippet(() => ({ render: () => '<span>inside</span>' }))
  const { container } = render(DropZone, { ondrop, children: child })
  const root = container.firstElementChild!
  await fireEvent.dragEnter(root, dropEvent([]))
  expect(container.querySelector('[data-drop-label]')).toBeNull()
  expect(root.className).toContain('border-accent')
  await fireEvent.drop(root, dropEvent([withPath('/a/x.txt'), new File(['x'], 'y.txt')]))
  expect(ondrop).toHaveBeenCalledWith(['/a/x.txt'])
})

// ---- thumbnails

const image = { key: 'k1', id: idOf(1), name: 'shot.png', kind: 'image' as const, size: 2048 }
const doc = { key: 'k2', id: idOf(2), name: 'notes.txt', kind: 'text' as const, size: 10 }

it('an image chip shows the staged thumbnail; other kinds keep the file icon', () => {
  const { container } = render(AttachmentRow, { items: [image, doc], onremove: () => {} })
  const img = container.querySelector('[data-attachment-thumb]') as HTMLImageElement
  expect(img.getAttribute('src')).toBe(`arc-attachment://staged/${idOf(1)}?thumb=1`)
  expect(img.getAttribute('alt')).toBe('shot.png')
  const chips = container.querySelectorAll('[data-attachment-chip]')
  expect(chips[1]!.querySelector('[data-attachment-thumb]')).toBeNull()
  expect(chips[1]!.querySelector('[data-icon="file"]')).not.toBeNull()
})

it('a staging image chip shows the image icon, and a failed thumbnail falls back to it', async () => {
  const { container } = render(AttachmentRow, {
    items: [{ key: 'p', name: 'Pasted image', kind: 'image', state: 'staging' }, image],
    onremove: () => {}
  })
  expect(container.querySelector('[data-icon="image"]')).not.toBeNull()
  await fireEvent.error(container.querySelector('[data-attachment-thumb]')!)
  expect(container.querySelector('[data-attachment-thumb]')).toBeNull()
  expect(container.querySelectorAll('[data-icon="image"]')).toHaveLength(2)
})

it('attachmentUrl builds the staged, sent and thumbnail forms', () => {
  expect(attachmentUrl('staged', 'a')).toBe('arc-attachment://staged/a')
  expect(attachmentUrl('sent', 'a', true)).toBe('arc-attachment://sent/a?thumb=1')
})

const message = (over: Partial<SessionMessage>): SessionMessage =>
  ({
    id: 1,
    sessionId: 's1',
    role: 'user',
    content: 'look',
    state: 'complete',
    planId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }) as SessionMessage

const sentMessage = () =>
  message({
    attachments: [
      { id: 'img1', name: 'shot.png', kind: 'image', size: 4096 },
      { id: 'doc1', name: 'a.txt', kind: 'text', size: 5 }
    ]
  })

it('a sent message shows the sent thumbnail for images and a static chip for files', () => {
  const { container } = render(MessageBubble, { message: sentMessage() })
  const img = container.querySelector('[data-attachment-thumb]') as HTMLImageElement
  expect(img.getAttribute('src')).toBe('arc-attachment://sent/img1?thumb=1')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Preview shot.png' })).not.toBeNull()
})

// ---- preview

it('opens the full-size image from a draft chip, Escape closes it and focus returns', async () => {
  render(AttachmentRow, { items: [image], onremove: () => {} })
  const opener = screen.getByRole('button', { name: 'Preview shot.png' })
  opener.focus()
  await fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'shot.png' })
  expect(dialog.querySelector('img')!.getAttribute('src')).toBe(
    `arc-attachment://staged/${idOf(1)}`
  )
  await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(opener)
})

it('opens from an image on a sent message with the sent url', async () => {
  render(MessageBubble, { message: sentMessage() })
  await fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png' }))
  const dialog = screen.getByRole('dialog', { name: 'shot.png' })
  expect(dialog.querySelector('img')!.getAttribute('src')).toBe('arc-attachment://sent/img1')
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('a non-image opens nothing', async () => {
  render(AttachmentRow, { items: [doc], onremove: () => {} })
  expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull()
  const chip = document.querySelector<HTMLElement>('[data-attachment-chip]')!
  chip.focus()
  await fireEvent.keyDown(chip, { key: 'Enter' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('Escape in a preview opened from a Modal closes only the preview', async () => {
  const oncancel = vi.fn()
  render(PreviewInModal, { oncancel, items: [{ ...image }] })
  const chip = document.querySelector<HTMLElement>('[data-attachment-chip]')!
  chip.focus()
  await fireEvent.keyDown(chip, { key: 'Enter' })
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
  expect(oncancel).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Outer' })).not.toBeNull()
  expect(document.activeElement).toBe(chip)
  await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(oncancel).toHaveBeenCalledTimes(1)
})

// ---- keyboard model

const three = [
  { key: 'a', name: 'a.txt', kind: 'text' as const, size: 1 },
  { key: 'b', name: 'b.png', kind: 'image' as const, id: idOf(5), size: 1 },
  { key: 'c', name: 'c.txt', kind: 'text' as const, size: 1 }
]
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-attachment-chip]')]

it('is a toolbar named Attachments with one tab stop', () => {
  render(AttachmentRow, { items: three, onremove: () => {} })
  expect(screen.getByRole('toolbar', { name: 'Attachments' })).not.toBeNull()
  expect(chips().map((c) => c.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  expect(screen.getByRole('button', { name: 'Remove a.txt' }).getAttribute('tabindex')).toBe('-1')
})

it('arrows, Home and End move focus and the tab stop follows', async () => {
  render(AttachmentRow, { items: three, onremove: () => {} })
  const [a, b, c] = chips() as [HTMLElement, HTMLElement, HTMLElement]
  a.focus()
  await fireEvent.keyDown(a, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(b)
  expect(chips().map((x) => x.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  await fireEvent.keyDown(b, { key: 'End' })
  expect(document.activeElement).toBe(c)
  await fireEvent.keyDown(c, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(c)
  await fireEvent.keyDown(c, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(b)
  await fireEvent.keyDown(b, { key: 'Home' })
  expect(document.activeElement).toBe(a)
})

it('Enter or Space opens an image preview', async () => {
  render(AttachmentRow, { items: three, onremove: () => {} })
  const b = chips()[1]!
  b.focus()
  await fireEvent.keyDown(b, { key: ' ' })
  expect(screen.getByRole('dialog', { name: 'b.png' })).not.toBeNull()
  await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await fireEvent.keyDown(b, { key: 'Enter' })
  expect(screen.getByRole('dialog', { name: 'b.png' })).not.toBeNull()
})

function Removable() {
  const removed: string[] = []
  return { removed }
}

it('Delete removes the focused chip and focus goes to the next, else the previous', async () => {
  const { removed } = Removable()
  const { rerender } = render(AttachmentRow, {
    items: three,
    onremove: (key: string) => removed.push(key)
  })
  const b = chips()[1]!
  b.focus()
  await fireEvent.keyDown(b, { key: 'Delete' })
  expect(removed).toEqual(['b'])
  await rerender({ items: [three[0]!, three[2]!] })
  await waitFor(() => expect(document.activeElement).toBe(chips()[1]))
  expect(chips()[1]!.getAttribute('aria-label')).toBe('c.txt')
  await fireEvent.keyDown(chips()[1]!, { key: 'Backspace' })
  expect(removed).toEqual(['b', 'c'])
  await rerender({ items: [three[0]!] })
  await waitFor(() => expect(document.activeElement).toBe(chips()[0]))
})

it('removing the last chip with the keyboard focuses the message box', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await paste([withPath('/a/only.txt')])
  await waitFor(() => expect(attachments.ready('session:s1')).toHaveLength(1))
  const chip = chips()[0]!
  chip.focus()
  await fireEvent.keyDown(chip, { key: 'Delete' })
  await waitFor(() => expect(document.activeElement).toBe(box()))
  expect(attachments.list('session:s1')).toEqual([])
})

it('the remove button stays clickable by name', async () => {
  const onremove = vi.fn()
  render(AttachmentRow, { items: three, onremove })
  await fireEvent.click(screen.getByRole('button', { name: 'Remove c.txt' }))
  expect(onremove).toHaveBeenCalledWith('c')
})

it('DropZone with forceActive shows the label and the active border without a drag', () => {
  const child = createRawSnippet(() => ({ render: () => '<span>inside</span>' }))
  const { container } = render(DropZone, {
    ondrop: vi.fn(),
    label: 'Drop to attach',
    forceActive: true,
    children: child
  })
  expect(container.querySelector('[data-drop-label]')?.textContent?.trim()).toBe('Drop to attach')
  expect(container.firstElementChild!.className).toContain('border-accent')
})
