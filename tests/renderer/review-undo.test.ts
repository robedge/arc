import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { eventStyle } from '../../src/renderer/src/lib/components/sessions/event-kinds'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import { messageFor } from '../../src/renderer/src/lib/ipc/messages'
import type { ReviewFile } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

const file = (path: string): ReviewFile => ({
  path,
  status: 'M',
  added: 1,
  removed: 0,
  binary: false,
  large: false,
  workers: ['W1'],
  reviewed: false,
  changedSinceReviewed: false
})

let paths: string[]
let workers: string[]
let undoResult: () => unknown
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  review.reset()
  paths = ['a.ts', 'b.ts', 'c.ts']
  workers = []
  undoResult = () => ({ ok: true, data: undefined })
  invoke = mockHarness(async (channel, request) => {
    if (channel === 'review:get') {
      return {
        ok: true,
        data: {
          sessionId: 's1',
          workers: ['W1'],
          repos: [
            {
              projectId: 'api',
              projectName: 'api',
              branch: 'arc/s',
              push: { state: 'never' },
              files: paths.map(file),
              uncommitted: {
                state: 'ok',
                files: [
                  {
                    path: 'hand.ts',
                    status: 'M',
                    added: 1,
                    removed: 0,
                    binary: false,
                    large: false
                  }
                ]
              }
            }
          ]
        }
      }
    }
    if (channel === 'review:file') return { ok: true, data: { kind: 'text', hunks: [] } }
    if (channel === 'review:undo-preview') return { ok: true, data: { activeWorkers: workers } }
    if (channel === 'review:undo') {
      const res = undoResult() as { ok: boolean }
      if (res.ok) paths = paths.filter((p) => p !== (request as { path: string }).path)
      return res as never
    }
    return { ok: true, data: {} }
  })
})
afterEach(cleanup)

async function openDialog(path = 'b.ts'): Promise<void> {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
  review.select('api', 'session', path)
  await fireEvent.click(await screen.findByRole('button', { name: 'Undo changes' }))
  await screen.findByRole('dialog')
}
const confirm = (): HTMLElement =>
  screen.getAllByRole('button', { name: 'Undo changes' }).at(-1) as HTMLElement

it('shows the exact question with the path in mono', async () => {
  await openDialog()
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector('p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    "Undo all of this session's changes to api/b.ts? This adds a commit to arc/s."
  )
  expect(dialog.querySelector('code.font-mono')?.textContent).toBe('api/b.ts')
  expect(dialog.querySelector('[data-undo-warning]')).toBeNull()
  expect(invoke).toHaveBeenCalledWith('review:undo-preview', {
    sessionId: 's1',
    projectId: 'api',
    path: 'b.ts'
  })
})

it('Cancel closes the dialog without undoing', async () => {
  await openDialog()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith('review:undo', expect.anything())
})

it('confirming calls review:undo, closes, drops the file and selects the next one', async () => {
  await openDialog()
  await fireEvent.click(confirm())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(invoke).toHaveBeenCalledWith('review:undo', {
    sessionId: 's1',
    projectId: 'api',
    path: 'b.ts'
  })
  expect(document.querySelector('[data-review-file="b.ts"]')).toBeNull()
  await waitFor(() => expect(review.selected?.path).toBe('c.ts'))
})

it('undoing the last session file moves the selection on instead of leaving it empty', async () => {
  paths = ['a.ts']
  await openDialog('a.ts')
  await fireEvent.click(confirm())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(review.selected?.path).toBe('hand.ts'))
})

it('warns about one worker still on the file', async () => {
  workers = ['W2']
  await openDialog()
  expect(screen.getByRole('dialog').querySelector('[data-undo-warning]')?.textContent).toBe(
    'W2 is still working on this file. Its next merge may bring the change back.'
  )
})

it('warns about several workers in the plural', async () => {
  workers = ['W2', 'W3']
  await openDialog()
  expect(screen.getByRole('dialog').querySelector('[data-undo-warning]')?.textContent).toBe(
    'W2 and W3 are still working on this file. Their next merge may bring the change back.'
  )
})

it('keeps the dialog open and shows the message when the undo fails', async () => {
  undoResult = () => ({ ok: false, error: { code: 'BRANCH_DIVERGED' } })
  await openDialog()
  await fireEvent.click(confirm())
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(messageFor({ code: 'BRANCH_DIVERGED' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.querySelector('[data-review-file="b.ts"]')).not.toBeNull()
})

it('offers no Undo on an uncommitted file', async () => {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
  review.select('api', 'uncommitted', 'hand.ts')
  await screen.findByText('No line changes')
  expect(screen.queryByRole('button', { name: 'Undo changes' })).toBeNull()
})

it('styles the undo event as information, not an error', () => {
  const style = eventStyle('undo')
  expect(style).toMatchObject({ icon: 'info', tone: 'accent' })
})
