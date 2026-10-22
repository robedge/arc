import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type {
  ReviewFile,
  ReviewFileDiff,
  ReviewUncommitted,
  ReviewUncommittedFile
} from '../../src/shared/types/review'
import { mockHarness } from './helpers'

const session = (path: string): ReviewFile => ({
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
const hand = (path: string, over: Partial<ReviewUncommittedFile> = {}): ReviewUncommittedFile => ({
  path,
  status: 'M',
  added: 4,
  removed: 2,
  binary: false,
  large: false,
  ...over
})

let uncommitted: ReviewUncommitted = { state: 'ok', files: [] }
let diffFor: (req: { path: string; source?: string }) => ReviewFileDiff
let invoke: ReturnType<typeof mockHarness>

const textDiff = (text: string): ReviewFileDiff => ({
  kind: 'text',
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '@@ -1 +1 @@',
      lines: [{ kind: 'add', newNo: 1, text }]
    }
  ]
})

beforeEach(() => {
  review.reset()
  activeSession.close()
  uncommitted = { state: 'ok', files: [hand('src/hand.ts')] }
  diffFor = (req) => textDiff(req.source === 'uncommitted' ? 'from hand' : 'from session')
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
              files: [session('src/a.ts'), session('src/hand.ts')],
              uncommitted
            }
          ]
        }
      }
    }
    if (channel === 'review:file') {
      return { ok: true, data: diffFor(request as { path: string; source?: string }) }
    }
    return { ok: true, data: {} }
  })
})
afterEach(cleanup)

async function open(): Promise<void> {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
}

it('lists uncommitted files in a Not committed subgroup without worker chips', async () => {
  await open()
  const group = document.querySelector('[data-review-uncommitted]') as HTMLElement
  expect(within(group).getByText('Not committed')).toBeTruthy()
  const row = within(group).getByRole('option', { name: /src\/hand\.ts/ })
  expect(row.textContent).toContain('Changed')
  expect(row.textContent).toContain('+4')
  expect(row.textContent).toContain('−2')
  expect(group.querySelector('[data-worker-chip], [data-workers]')).toBeNull()
  expect(group.querySelector('input[type="checkbox"]')).toBeNull()
  // The session's own files still carry their chips.
  expect(document.querySelector('[data-workers]')).toBeTruthy()
})

it('has no subgroup when there are no uncommitted files', async () => {
  uncommitted = { state: 'ok', files: [] }
  await open()
  expect(document.querySelector('[data-review-uncommitted]')).toBeNull()
  expect(screen.queryByText('Not committed')).toBeNull()
})

it('fetches an uncommitted file with source uncommitted and shows its diff', async () => {
  await open()
  const group = document.querySelector('[data-review-uncommitted]') as HTMLElement
  await fireEvent.click(within(group).getByRole('option', { name: /src\/hand\.ts/ }))
  await waitFor(() => expect(screen.getByText('from hand')).toBeTruthy())
  const calls = invoke.mock.calls.filter((c) => c[0] === 'review:file').map((c) => c[1])
  expect(calls[0]).toMatchObject({ path: 'src/hand.ts', source: 'uncommitted' })
})

it('selects the same path in both lists independently', async () => {
  await open()
  const group = document.querySelector('[data-review-uncommitted]') as HTMLElement
  const fromSession = screen.getAllByRole('option', { name: /src\/hand\.ts/ })[0] as HTMLElement
  await fireEvent.click(fromSession)
  await waitFor(() => expect(screen.getByText('from session')).toBeTruthy())
  expect(review.selected).toEqual({ projectId: 'api', source: 'session', path: 'src/hand.ts' })
  await fireEvent.click(within(group).getByRole('option', { name: /src\/hand\.ts/ }))
  await waitFor(() => expect(screen.getByText('from hand')).toBeTruthy())
  expect(review.selected).toEqual({ projectId: 'api', source: 'uncommitted', path: 'src/hand.ts' })
  const selected = document.querySelectorAll('[aria-selected="true"]')
  expect(selected).toHaveLength(1)
  expect(group.contains(selected[0] as Node)).toBe(true)
})

it('keyboard navigation moves from the session files into the uncommitted ones', async () => {
  await open()
  review.select('api', 'session', 'src/hand.ts')
  await fireEvent.keyDown(window, { key: 'j' })
  expect(review.selected).toEqual({ projectId: 'api', source: 'uncommitted', path: 'src/hand.ts' })
})

it('keeps a selected uncommitted file across a refresh while it still exists', async () => {
  await open()
  review.select('api', 'uncommitted', 'src/hand.ts')
  await review.load()
  expect(review.selected?.source).toBe('uncommitted')
  uncommitted = { state: 'ok', files: [] }
  await review.load()
  expect(review.selected).toBeNull()
})

it('explains an other-branch checkout with the branch name', async () => {
  uncommitted = { state: 'other-branch', current: 'feature/x' }
  await open()
  expect(
    screen.getByText("Your checkout is on feature/x, so uncommitted edits aren't shown.")
  ).toBeTruthy()
})

it('explains a detached checkout', async () => {
  uncommitted = { state: 'other-branch', current: null }
  await open()
  expect(
    screen.getByText("Your checkout isn't on a branch, so uncommitted edits aren't shown.")
  ).toBeTruthy()
})

it('says quietly when the uncommitted edits could not be read', async () => {
  uncommitted = { state: 'unavailable' }
  await open()
  expect(screen.getByText("Couldn't read your uncommitted edits.")).toBeTruthy()
})

it('a worker filter hides the subgroup until All workers', async () => {
  await open()
  review.workerFilter = 'W1'
  await tick()
  expect(document.querySelector('[data-review-uncommitted]')).toBeNull()
  review.workerFilter = 'all'
  await tick()
  expect(document.querySelector('[data-review-uncommitted]')).toBeTruthy()
})

it('shows a too-large untracked file without a line count', async () => {
  uncommitted = {
    state: 'ok',
    files: [hand('big.bin', { status: 'A', added: 0, removed: 0, large: true })]
  }
  diffFor = () => ({ kind: 'tooLarge', changedLines: 0 })
  await open()
  const group = document.querySelector('[data-review-uncommitted]') as HTMLElement
  await fireEvent.click(within(group).getByRole('option', { name: /big\.bin/ }))
  await waitFor(() => expect(screen.getByText('Too large to display')).toBeTruthy())
  expect(screen.queryByText(/0 lines/)).toBeNull()
})
