import { afterEach, beforeEach, expect, it, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { attachments } from '../../src/renderer/src/lib/stores/attachments.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import type { AttachmentRefusal } from '../../src/shared/attachments'
import type { Result } from '../../src/shared/errors'
import { mockArc } from './helpers'

const DRAFT = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const idOf = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`

let counter: number
let refusedNext: AttachmentRefusal[]
let stageDelay: Promise<void> | null
let sendReply: Result<unknown>
const filePaths = new Map<File, string>()

beforeEach(() => {
  counter = 0
  refusedNext = []
  stageDelay = null
  sendReply = { ok: true, data: { messageId: 7, attachments: [] } }
  filePaths.clear()
  mockArc(async (channel, request) => {
    if (channel === 'attachments:new-draft') return { ok: true, data: { draftId: DRAFT } }
    if (channel === 'attachments:stage-paths') {
      if (stageDelay) await stageDelay
      const { paths } = request as { paths: string[] }
      const refused = refusedNext
      refusedNext = []
      const refusedNames = new Set(refused.map((r) => r.name))
      return {
        ok: true,
        data: {
          attachments: paths
            .map((p) => p.split('/').pop()!)
            .filter((name) => !refusedNames.has(name))
            .map((name) => ({
              id: idOf(++counter),
              name,
              kind: 'text',
              mime: 'text/plain',
              size: 100
            })),
          refused
        }
      }
    }
    if (channel === 'sessions:send-message') return sendReply
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
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
const withPath = (path: string) => {
  const file = new File(['x'], path.split('/').pop()!, { type: 'text/plain' })
  filePaths.set(file, path)
  return file
}
const zone = () => document.querySelector('[data-attach-field]')!.parentElement!
const drop = (files: File[]) =>
  fireEvent.drop(zone(), { dataTransfer: { types: ['Files'], files } })
const notices = () => document.querySelector('[data-attachment-notices]') as HTMLElement | null
const lines = () => [...(notices()?.querySelectorAll('[data-notice-line]') ?? [])]
const texts = () => lines().map((l) => l.querySelector('[data-notice-text]')!.textContent)
const clipboard = (files: File[], text = '') => ({
  clipboardData: { files, getData: (type: string) => (type === 'text/plain' ? text : '') }
})

async function dropRefused(refused: AttachmentRefusal[], allowed: string[] = []) {
  refusedNext = refused
  const files = [...allowed, ...refused.map((r) => r.name)].map((n) => withPath(`/d/${n}`))
  await drop(files)
  await waitFor(() => expect(lines().length).toBeGreaterThan(0))
}

it('renders nothing visible when there are no refusals, but the status region stays', () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(lines()).toHaveLength(0)
})

it.each([
  [
    { name: 'a.zip', reason: 'unsupported' },
    "a.zip can't be attached. Arc accepts images, PDFs and text files."
  ],
  [{ name: 'big.png', reason: 'too_large' }, 'big.png is too large. The limit is 20 MB.'],
  [{ name: 'k.txt', reason: 'too_many' }, 'A message can have at most 10 attachments.'],
  [{ name: 'src', reason: 'folder' }, "Folders can't be attached."],
  [{ name: 'x.log', reason: 'unreadable' }, "x.log couldn't be read."]
] as [AttachmentRefusal, string][])(
  'shows the %j message in a polite status region',
  async (r, text) => {
    render(Composer, { sessionId: 's1', brainState: 'idle' })
    await dropRefused([r])
    expect(notices()!.getAttribute('role')).toBe('status')
    expect(notices()!.getAttribute('aria-live')).toBe('polite')
    expect(texts()).toEqual([text])
    // The send ErrorText is a different region and is not used for refusals.
    expect(screen.queryByRole('alert')).toBeNull()
  }
)

it('mixed drop: the allowed file is attached and the notice names only the refused one', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([{ name: 'bad.zip', reason: 'unsupported' }], ['good.txt'])
  expect(screen.getByText('good.txt')).not.toBeNull()
  expect(texts()).toEqual(["bad.zip can't be attached. Arc accepts images, PDFs and text files."])
  expect(notices()!.textContent).not.toContain('good.txt')
})

it('shows at most 3 lines and then "and N more were refused."', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused(
    ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: `${n}.zip`, reason: 'unsupported' as const }))
  )
  expect(lines()).toHaveLength(3)
  expect(notices()!.querySelector('[data-notice-more]')!.textContent).toBe(
    'and 2 more were refused.'
  )
})

it('several too_many refusals collapse into one line', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused(['a', 'b', 'c'].map((n) => ({ name: `${n}.txt`, reason: 'too_many' as const })))
  expect(texts()).toEqual(['A message can have at most 10 attachments.'])
  expect(notices()!.querySelector('[data-notice-more]')).toBeNull()
})

it('dismiss removes only that line, and the button has an accessible name', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([
    { name: 'a.zip', reason: 'unsupported' },
    { name: 'src', reason: 'folder' }
  ])
  await fireEvent.click(within(notices()!).getByRole('button', { name: 'Dismiss: a.zip' }))
  expect(texts()).toEqual(["Folders can't be attached."])
})

it('dismissing a line reveals the next hidden one', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused(
    ['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.zip`, reason: 'unsupported' as const }))
  )
  await fireEvent.click(within(notices()!).getAllByRole('button')[0]!)
  expect(lines()).toHaveLength(3)
  expect(notices()!.querySelector('[data-notice-more]')).toBeNull()
})

it('is cleared when the next add starts', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([{ name: 'a.zip', reason: 'unsupported' }])
  await drop([withPath('/d/ok.txt')])
  await waitFor(() => expect(screen.getByText('ok.txt')).not.toBeNull())
  expect(lines()).toHaveLength(0)
})

it('is not cleared while a previous add is still in flight', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([{ name: 'a.zip', reason: 'unsupported' }])
  let release!: () => void
  stageDelay = new Promise((r) => (release = r))
  await drop([withPath('/d/slow.txt')])
  await waitFor(() => expect(attachments.isStaging('session:s1')).toBe(true))
  expect(lines()).toHaveLength(0)
  refusedNext = [{ name: 'b.zip', reason: 'unsupported' }]
  await drop([withPath('/d/b.zip')])
  release()
  await waitFor(() => expect(attachments.isStaging('session:s1')).toBe(false))
  expect(texts().some((t) => t.startsWith('b.zip'))).toBe(true)
})

it('is cleared on send success', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([{ name: 'a.zip', reason: 'unsupported' }], ['ok.txt'])
  await fireEvent.click(sendButton())
  await waitFor(() => expect(lines()).toHaveLength(0))
})

it('stays after a failed send', async () => {
  sendReply = { ok: false, error: { code: 'CLI_UNAVAILABLE' } }
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([{ name: 'a.zip', reason: 'unsupported' }], ['ok.txt'])
  await fireEvent.click(sendButton())
  await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
  expect(lines()).toHaveLength(1)
})

it('is cleared when the user switches to another session', async () => {
  const first = render(Composer, { sessionId: 's1', brainState: 'idle' })
  await dropRefused([{ name: 'a.zip', reason: 'unsupported' }])
  first.unmount()
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect(lines()).toHaveLength(0)
})

it('a path-less pasted file that is not an image is reported as unreadable', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  const blob = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
  expect(await fireEvent.paste(box(), clipboard([blob]))).toBe(false)
  await waitFor(() => expect(texts()).toEqual(["x.bin couldn't be read."]))
})

it('a path-less file pasted next to text is left to the browser and not reported', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  const blob = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
  expect(await fireEvent.paste(box(), clipboard([blob], 'cells'))).toBe(true)
  expect(lines()).toHaveLength(0)
})

it('a dropped path-less file is reported, the other file attaches', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  const web = new File(['x'], 'from-browser.png', { type: 'image/png' })
  await drop([withPath('/d/one.txt'), web])
  await waitFor(() => expect(texts()).toEqual(["from-browser.png couldn't be read."]))
  expect(screen.getByText('one.txt')).not.toBeNull()
})

it('a path-less paste keeps the refusals of the path files it came with', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  refusedNext = [{ name: 'a.zip', reason: 'unsupported' }]
  const blob = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
  await fireEvent.paste(box(), clipboard([withPath('/d/a.zip'), blob]))
  await waitFor(() => expect(lines()).toHaveLength(2))
})

// ---- chip states

it('the row is aria-busy and the chip says it is adding while staging', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  let release!: () => void
  stageDelay = new Promise((r) => (release = r))
  await drop([withPath('/d/slow.txt')])
  await waitFor(() =>
    expect(document.querySelector('[data-attachment-row]')!.getAttribute('aria-busy')).toBe('true')
  )
  expect(screen.getByText('Adding slow.txt')).not.toBeNull()
  expect(sendButton().disabled).toBe(true)
  expect(sendButton().getAttribute('aria-describedby')).toBeTruthy()
  expect(document.getElementById(sendButton().getAttribute('aria-describedby')!)!.textContent).toBe(
    'Waiting for attachments'
  )
  release()
  await waitFor(() =>
    expect(document.querySelector('[data-attachment-row]')!.getAttribute('aria-busy')).toBeNull()
  )
})

it('an ATTACHMENT_UNREADABLE send marks that chip as error and keeps text and the others', async () => {
  sendReply = { ok: false, error: { code: 'ATTACHMENT_UNREADABLE', details: { name: 'b.txt' } } }
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: 'keep' } })
  await drop([withPath('/d/a.txt'), withPath('/d/b.txt')])
  await waitFor(() => expect(attachments.ready('session:s1')).toHaveLength(2))
  await waitFor(() =>
    expect(document.querySelector('[data-attachment-state="staging"]')).toBeNull()
  )
  await fireEvent.click(sendButton())
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'b.txt could no longer be read. Remove it or attach it again.'
    )
  )
  const chips = [...document.querySelectorAll('[data-attachment-chip]')]
  expect(chips.map((c) => c.getAttribute('data-attachment-state'))).toEqual(['ready', 'error'])
  expect(screen.getByText('b.txt could not be read')).not.toBeNull()
  expect(box().value).toBe('keep')
  expect(screen.getByRole('button', { name: 'Remove b.txt' })).not.toBeNull()
  // The error chip is not ready: the next send carries only a.txt.
  expect(attachments.ready('session:s1').map((i) => i.name)).toEqual(['a.txt'])
})

it('after the error chip is the only one, Send follows the text; removing it works', async () => {
  sendReply = { ok: false, error: { code: 'ATTACHMENT_UNREADABLE', details: { name: 'b.txt' } } }
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await drop([withPath('/d/b.txt')])
  await waitFor(() => expect(sendButton().disabled).toBe(false))
  await fireEvent.click(sendButton())
  await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
  expect(sendButton().disabled).toBe(true)
  await fireEvent.input(box(), { target: { value: 'text only' } })
  expect(sendButton().disabled).toBe(false)
  await fireEvent.click(screen.getByRole('button', { name: 'Remove b.txt' }))
  expect(document.querySelectorAll('[data-attachment-chip]')).toHaveLength(0)
})
