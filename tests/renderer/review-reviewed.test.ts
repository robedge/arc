import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import type { ReviewFile, ReviewFileDiff } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

type Marks = Record<string, Pick<ReviewFile, 'reviewed' | 'changedSinceReviewed'>>

const file = (path: string, marks: Marks): ReviewFile => ({
  path,
  status: 'M',
  added: 1,
  removed: 0,
  binary: false,
  large: false,
  workers: ['W1'],
  reviewed: false,
  changedSinceReviewed: false,
  ...marks[path]
})

const diff: ReviewFileDiff = {
  kind: 'text',
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '@@ -1 +1 @@',
      lines: [{ kind: 'add', newNo: 1, text: 'hello' }]
    }
  ]
}

let marks: Marks
let setReviewed: (req: unknown) => { ok: boolean; error?: unknown }
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  review.reset()
  activeSession.close()
  toasts.list = []
  marks = {}
  setReviewed = (req) => {
    const r = req as { path: string; reviewed: boolean }
    marks[r.path] = { reviewed: r.reviewed, changedSinceReviewed: false }
    return { ok: true }
  }
  invoke = mockHarness((channel, request) => {
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
              files: ['a.ts', 'b.ts', 'c.ts'].map((p) => file(p, marks)),
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
    if (channel === 'review:file') return { ok: true, data: diff }
    if (channel === 'review:set-reviewed') {
      const res = setReviewed(request)
      return res.ok
        ? { ok: true, data: undefined }
        : { ok: false, error: { code: 'REVIEW_FILE_NOT_FOUND', message: 'gone' } }
    }
    return { ok: true, data: {} }
  })
})
afterEach(cleanup)

async function open(): Promise<void> {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
}
const box = (path: string): HTMLInputElement =>
  screen.getAllByRole('checkbox', { name: `Reviewed ${path}` })[0] as HTMLInputElement
const progress = (): string =>
  (document.querySelector('[data-review-progress]') as HTMLElement).textContent!.trim()

it('shows 0 of 3 reviewed, polite, and ticking calls the channel and updates the progress', async () => {
  await open()
  expect(progress()).toBe('0 of 3 reviewed')
  expect(document.querySelector('[data-review-progress]')?.getAttribute('aria-live')).toBe('polite')
  await fireEvent.click(box('a.ts'))
  await waitFor(() => expect(progress()).toBe('1 of 3 reviewed'))
  expect(invoke).toHaveBeenCalledWith('review:set-reviewed', {
    sessionId: 's1',
    projectId: 'api',
    path: 'a.ts',
    reviewed: true
  })
  await fireEvent.click(box('b.ts'))
  await waitFor(() => expect(progress()).toBe('2 of 3 reviewed'))
})

it('unticking clears the mark and lowers the progress', async () => {
  marks = { 'a.ts': { reviewed: true, changedSinceReviewed: false } }
  await open()
  expect(progress()).toBe('1 of 3 reviewed')
  expect(box('a.ts').checked).toBe(true)
  await fireEvent.click(box('a.ts'))
  await waitFor(() => expect(progress()).toBe('0 of 3 reviewed'))
  expect(invoke).toHaveBeenCalledWith(
    'review:set-reviewed',
    expect.objectContaining({ path: 'a.ts', reviewed: false })
  )
  expect(box('a.ts').checked).toBe(false)
})

it('shows "Changed since reviewed" as text on a row whose tick was cleared', async () => {
  marks = { 'b.ts': { reviewed: false, changedSinceReviewed: true } }
  await open()
  const row = document.querySelector('[data-review-file="b.ts"]') as HTMLElement
  expect(row.textContent).toContain('Changed since reviewed')
  expect(box('b.ts').checked).toBe(false)
  expect(document.querySelector('[data-review-file="a.ts"]')?.textContent).not.toContain(
    'Changed since reviewed'
  )
  expect(progress()).toBe('0 of 3 reviewed')
})

it('puts the tick back and shows a toast when the channel fails', async () => {
  setReviewed = () => ({ ok: false })
  await open()
  await fireEvent.click(box('a.ts'))
  await waitFor(() => expect(toasts.list.length).toBe(1))
  expect(box('a.ts').checked).toBe(false)
  expect(progress()).toBe('0 of 3 reviewed')
})

it('ticking does not change the row selection', async () => {
  await open()
  review.select('api', 'session', 'c.ts')
  await fireEvent.click(box('a.ts'))
  await waitFor(() => expect(progress()).toBe('1 of 3 reviewed'))
  expect(review.selected).toEqual({ projectId: 'api', source: 'session', path: 'c.ts' })
})

it('keeps the toolbar and the row checkbox in step', async () => {
  await open()
  await fireEvent.click(document.querySelector('[data-review-file="a.ts"]') as HTMLElement)
  await waitFor(() => expect(document.querySelector('[data-diff-toolbar]')).toBeTruthy())
  const [rowBox, toolbarBox] = screen.getAllByRole('checkbox', {
    name: 'Reviewed a.ts'
  }) as HTMLInputElement[]
  await fireEvent.click(toolbarBox as HTMLInputElement)
  await waitFor(() => expect((rowBox as HTMLInputElement).checked).toBe(true))
  expect((toolbarBox as HTMLInputElement).checked).toBe(true)
  await fireEvent.click(rowBox as HTMLInputElement)
  await waitFor(() => expect((toolbarBox as HTMLInputElement).checked).toBe(false))
})

it('has no Reviewed checkbox on uncommitted rows or in their toolbar', async () => {
  await open()
  expect(screen.queryByRole('checkbox', { name: 'Reviewed hand.ts' })).toBeNull()
  const row = document.querySelector('[data-review-source="uncommitted"]') as HTMLElement
  expect(row.querySelector('input[type="checkbox"]')).toBeNull()
  await fireEvent.click(row)
  await waitFor(() => expect(document.querySelector('[data-diff-toolbar]')).toBeTruthy())
  expect(document.querySelector('[data-diff-toolbar] input[type="checkbox"]')).toBeNull()
})

it('counts session files across all repositories regardless of filters', async () => {
  marks = { 'a.ts': { reviewed: true, changedSinceReviewed: false } }
  await open()
  review.workerFilter = 'W9'
  await waitFor(() => expect(progress()).toBe('1 of 3 reviewed'))
})
