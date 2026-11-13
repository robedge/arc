import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import NewSessionDialog from '../../src/renderer/src/lib/components/sessions/NewSessionDialog.svelte'
import { attachments } from '../../src/renderer/src/lib/stores/attachments.svelte'
import type { Result } from '../../src/shared/errors'
import { mockArc } from './helpers'

const ids = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`
const A = ids(1)
const B = ids(2)
let drafts: number
let invoke: ReturnType<typeof mockArc>
let createReply: () => Result<unknown> | Promise<Result<unknown>>
let pickReply: () => Result<unknown> | Promise<Result<unknown>>
let bytesReply: () => Result<unknown> | Promise<Result<unknown>>
const filePaths = new Map<File, string>()

const meta = (id: string, name: string, kind: 'text' | 'image' = 'text') => ({
  id,
  name,
  kind,
  mime: kind === 'image' ? 'image/png' : 'text/plain',
  size: 10
})
const draftName = (n: number) =>
  `01HZZZZZZZZZZZZZZZZZZZZ${String.fromCharCode(64 + n)}00`.slice(0, 26)

beforeEach(() => {
  drafts = 0
  filePaths.clear()
  createReply = () => ({ ok: true, data: { sessionId: 's1' } })
  pickReply = () => ({
    ok: true,
    data: { attachments: [meta(A, 'a.txt'), meta(B, 'b.txt')], refused: [] }
  })
  bytesReply = () => ({
    ok: true,
    data: { attachments: [meta(A, 'Pasted image 1', 'image')], refused: [] }
  })
  invoke = mockArc((channel, request) => {
    if (channel === 'attachments:new-draft') {
      return { ok: true, data: { draftId: draftName(++drafts) } }
    }
    if (channel === 'attachments:pick') return pickReply()
    if (channel === 'attachments:stage-bytes') return bytesReply()
    if (channel === 'attachments:stage-paths') {
      const { paths } = request as { paths: string[] }
      return {
        ok: true,
        data: {
          attachments: paths.map((p, i) => meta(ids(10 + i), p.split('/').pop()!)),
          refused: []
        }
      }
    }
    if (channel === 'sessions:create') return createReply()
    return { ok: true, data: undefined }
  })
  ;(window.arc.getPathForFile as Mock).mockImplementation((file: File) => filePaths.get(file) ?? '')
  attachments.reset()
})
afterEach(cleanup)

const mount = (props: Partial<{ onclose: () => void; oncreated: (id: string) => void }> = {}) =>
  render(NewSessionDialog, {
    groupId: 'g1',
    onclose: props.onclose ?? vi.fn(),
    oncreated: props.oncreated ?? vi.fn()
  })
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)
const request = () => screen.getByLabelText('Request') as HTMLTextAreaElement
const start = () => screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement
const clip = () => screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement
const attach = async () => {
  await fireEvent.click(clip())
  await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0))
}

it('attaching by the picker and starting with text sends the draft id and ordered ids', async () => {
  const oncreated = vi.fn()
  mount({ oncreated })
  await fireEvent.input(request(), { target: { value: 'Look at these' } })
  await attach()
  await fireEvent.click(start())
  await waitFor(() => expect(oncreated).toHaveBeenCalledWith('s1'))
  expect(calls('sessions:create')[0]![1]).toEqual({
    groupId: 'g1',
    request: 'Look at these',
    mode: 'plan_first',
    workerLimit: 3,
    draftId: draftName(1),
    attachmentIds: [A, B]
  })
})

it('starting with attachments and no text is valid, and the draft is cleared on success', async () => {
  const oncreated = vi.fn()
  mount({ oncreated })
  await attach()
  await fireEvent.click(start())
  await waitFor(() => expect(oncreated).toHaveBeenCalled())
  expect(screen.queryByText('Enter a request for the brain.')).toBeNull()
  expect(calls('sessions:create')[0]![1]).toMatchObject({ request: '', attachmentIds: [A, B] })
  expect(calls('attachments:discard-draft')).toHaveLength(0)
})

it('an empty request without attachments still asks for a request', async () => {
  mount()
  await fireEvent.click(start())
  expect(screen.getByText('Enter a request for the brain.')).toBeTruthy()
  expect(calls('sessions:create')).toHaveLength(0)
})

it('Start is disabled while a file is staging', async () => {
  let finish!: (r: Result<unknown>) => void
  pickReply = () => new Promise((resolve) => (finish = resolve))
  mount()
  await fireEvent.input(request(), { target: { value: 'hi' } })
  await fireEvent.click(clip())
  await waitFor(() => expect(start().disabled).toBe(true))
  await fireEvent.submit(start().closest('form')!)
  expect(calls('sessions:create')).toHaveLength(0)
  finish({ ok: true, data: { attachments: [meta(A, 'a.txt')], refused: [] } })
  await waitFor(() => expect(start().disabled).toBe(false))
})

it('pasting a screenshot in the Request box attaches it and inserts no text', async () => {
  mount()
  const shot = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })
  const notPrevented = await fireEvent.paste(request(), {
    clipboardData: { files: [shot], getData: () => '' }
  })
  expect(notPrevented).toBe(false)
  await waitFor(() => expect(screen.getByText('Pasted image 1')).toBeTruthy())
  expect(request().value).toBe('')
})

it('pasting text still pastes text', async () => {
  mount()
  const notPrevented = await fireEvent.paste(request(), {
    clipboardData: { files: [], getData: () => 'hello' }
  })
  expect(notPrevented).toBe(true)
  expect(calls('attachments:new-draft')).toHaveLength(0)
})

it('dropping a file on the Request box attaches it', async () => {
  mount()
  const file = new File(['x'], 'one.txt')
  filePaths.set(file, '/a/one.txt')
  const zone = document.querySelector('[data-attach-field]')!.parentElement!
  await fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } })
  await waitFor(() => expect(screen.getByText('one.txt')).toBeTruthy())
  expect(calls('attachments:stage-paths')[0]![1]).toMatchObject({ paths: ['/a/one.txt'] })
})

it('Cancel discards the draft and a reopened dialog lists nothing', async () => {
  const onclose = vi.fn()
  const first = mount({ onclose })
  await attach()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onclose).toHaveBeenCalled()
  await waitFor(() =>
    expect(calls('attachments:discard-draft')).toEqual([
      ['attachments:discard-draft', { draftId: draftName(1) }]
    ])
  )
  first.unmount()
  mount()
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
})

it('Escape on the dialog discards the draft too', async () => {
  mount()
  await attach()
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(calls('attachments:discard-draft')).toHaveLength(1))
})

it('cancelling with no draft created calls nothing', async () => {
  const onclose = vi.fn()
  mount({ onclose })
  await fireEvent.input(request(), { target: { value: 'hi' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onclose).toHaveBeenCalled()
  expect(calls('attachments:discard-draft')).toHaveLength(0)
  expect(calls('attachments:new-draft')).toHaveLength(0)
})

it('a staging result that arrives after Cancel is cleaned up', async () => {
  let finish!: (r: Result<unknown>) => void
  pickReply = () => new Promise((resolve) => (finish = resolve))
  const view = mount()
  await fireEvent.click(clip())
  await waitFor(() => expect(calls('attachments:pick')).toHaveLength(1))
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  view.unmount()
  await waitFor(() => expect(calls('attachments:discard-draft')).toHaveLength(1))
  finish({ ok: true, data: { attachments: [meta(A, 'late.txt')], refused: [] } })
  await waitFor(() => expect(calls('attachments:discard-draft')).toHaveLength(2))
  expect(calls('attachments:discard-draft')[1]![1]).toEqual({ draftId: draftName(1) })
  mount()
  expect(screen.queryByText('late.txt')).toBeNull()
})

it('a draft still being created when the dialog closes is discarded, not resurrected', async () => {
  let made!: (r: Result<unknown>) => void
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'attachments:new-draft') return new Promise((resolve) => (made = resolve))
    return { ok: true, data: undefined }
  })
  const view = mount()
  await fireEvent.click(clip())
  await waitFor(() => expect(calls('attachments:new-draft')).toHaveLength(1))
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  view.unmount()
  made({ ok: true, data: { draftId: draftName(1) } })
  await waitFor(() =>
    expect(calls('attachments:discard-draft')).toEqual([
      ['attachments:discard-draft', { draftId: draftName(1) }]
    ])
  )
  expect(calls('attachments:pick')).toHaveLength(0)
})

it('two openings use different drafts', async () => {
  const first = mount()
  await attach()
  first.unmount()
  mount()
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  await attach()
  expect(calls('attachments:new-draft')).toHaveLength(2)
  expect(new Set(calls('attachments:new-draft')).size).toBe(2)
})

it('a failed create keeps the text and attachments and shows the error', async () => {
  createReply = () => ({ ok: false, error: { code: 'ATTACHMENTS_WITH_COMMAND' } })
  const onclose = vi.fn()
  mount({ onclose })
  await fireEvent.input(request(), { target: { value: '/review' } })
  await attach()
  await fireEvent.click(start())
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      "Attachments can't be sent with a command."
    )
  )
  expect(request().value).toBe('/review')
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(calls('attachments:discard-draft')).toHaveLength(0)
  expect(onclose).not.toHaveBeenCalled()
})

it('ATTACHMENT_UNREADABLE marks that chip as an error', async () => {
  createReply = () => ({
    ok: false,
    error: { code: 'ATTACHMENT_UNREADABLE', details: { name: 'a.txt' } }
  })
  mount()
  await attach()
  await fireEvent.click(start())
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('a.txt'))
  expect(document.querySelectorAll('[data-attachment-state="error"]')).toHaveLength(1)
})

it('the dirty-tree choice keeps the attachments until the session is created', async () => {
  createReply = () => ({
    ok: true,
    data: {
      needsDirtyChoice: {
        token: 't1',
        repos: [{ projectId: 'api', name: 'api', files: ['a.ts'], fileCount: 1 }]
      }
    }
  })
  const oncreated = vi.fn()
  mount({ oncreated })
  await attach()
  await fireEvent.click(start())
  await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeTruthy())
  expect(calls('attachments:discard-draft')).toHaveLength(0)
  // Back out of the question: the form returns with its attachments.
  invoke.mockImplementation(async (channel: string) =>
    channel === 'sessions:resolve-dirty'
      ? { ok: true, data: { status: 'cancelled' } }
      : { ok: true, data: undefined }
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.getByLabelText('Request')).toBeTruthy())
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(calls('attachments:discard-draft')).toHaveLength(0)
  expect(oncreated).not.toHaveBeenCalled()
})

it('the draft is cleared when the dirty choice creates the session', async () => {
  createReply = () => ({
    ok: true,
    data: {
      needsDirtyChoice: {
        token: 't1',
        repos: [{ projectId: 'api', name: 'api', files: ['a.ts'], fileCount: 1 }]
      }
    }
  })
  const oncreated = vi.fn()
  const view = mount({ oncreated })
  await attach()
  await fireEvent.click(start())
  await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeTruthy())
  invoke.mockImplementation(async (channel: string) =>
    channel === 'sessions:resolve-dirty'
      ? { ok: true, data: { status: 'ready', sessionId: 's9' } }
      : { ok: true, data: undefined }
  )
  await fireEvent.click(screen.getByRole('radio', { name: /Set aside/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalledWith('s9'))
  view.unmount()
  expect(calls('attachments:discard-draft')).toHaveLength(0)
})

it('Escape in an image preview closes only the preview and returns focus to the chip', async () => {
  pickReply = () => ({
    ok: true,
    data: { attachments: [meta(A, 'shot.png', 'image')], refused: [] }
  })
  const onclose = vi.fn()
  mount({ onclose })
  await attach()
  const chip = document.querySelector<HTMLElement>('[data-attachment-chip]')!
  chip.focus()
  await fireEvent.keyDown(chip, { key: 'Enter' })
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
  expect(onclose).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(chip)
  expect(calls('attachments:discard-draft')).toHaveLength(0)
})
