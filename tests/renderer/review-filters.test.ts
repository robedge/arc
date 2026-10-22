import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { ReviewFile, ReviewSnapshot } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

const file = (path: string, workers: string[]): ReviewFile => ({
  path,
  status: 'M',
  added: 1,
  removed: 0,
  binary: false,
  large: false,
  workers,
  reviewed: false,
  changedSinceReviewed: false
})

const data: ReviewSnapshot = {
  sessionId: 's1',
  workers: ['W1', 'W2', 'W3', 'You'],
  notes: [],
  repos: [
    {
      projectId: 'api',
      projectName: 'api',
      branch: 'arc/x',
      uncommitted: { state: 'ok', files: [] },
      push: { state: 'never' },
      files: [file('a1.ts', ['W1', 'W3']), file('a2.ts', ['W2']), file('a3.ts', ['You'])]
    },
    {
      projectId: 'web',
      projectName: 'web',
      branch: 'arc/x',
      uncommitted: { state: 'ok', files: [] },
      push: { state: 'never' },
      files: [file('w1.ts', ['W1'])]
    }
  ]
}

const paths = (): string[] =>
  Array.from(document.querySelectorAll('[data-review-file]')).map(
    (el) => el.getAttribute('data-review-file') as string
  )

async function setup(): Promise<void> {
  mockHarness((channel) => {
    if (channel === 'review:get') return { ok: true, data }
    return { ok: true, data: { kind: 'text', hunks: [] } }
  })
  await review.openReview('s1')
  render(ReviewScreen, { onback: () => {} })
  await tick()
}

beforeEach(() => review.reset())
afterEach(cleanup)

it('shows each file row workers as "W1, W3"', async () => {
  await setup()
  const row = document.querySelector('[data-review-file="a1.ts"]') as HTMLElement
  expect(row.querySelector('[data-workers]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'W1, W3'
  )
  expect(row.querySelector('[data-workers]')?.getAttribute('aria-label')).toBe('Changed by W1, W3')
})

it("the worker filter lists only that worker's files and hides empty repositories", async () => {
  await setup()
  await fireEvent.change(screen.getByLabelText('Worker filter'), { target: { value: 'W2' } })
  await tick()
  expect(paths()).toEqual(['a2.ts'])
  expect(screen.queryByRole('region', { name: 'web' })).toBeNull()
})

it('the repository filter lists one repository', async () => {
  await setup()
  await fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'web' } })
  await tick()
  expect(paths()).toEqual(['w1.ts'])
  expect(screen.queryByRole('region', { name: 'api' })).toBeNull()
})

it('shows an empty state when nothing matches and clears a hidden selection', async () => {
  await setup()
  review.select('api', 'session', 'a2.ts')
  await fireEvent.change(screen.getByLabelText('Worker filter'), { target: { value: 'W1' } })
  await tick()
  expect(review.selected).toBeNull()
  await fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'web' } })
  await fireEvent.change(screen.getByLabelText('Worker filter'), { target: { value: 'W2' } })
  await tick()
  expect(screen.getByText('No files match these filters')).toBeTruthy()
})

it('j and k move through the filtered list only', async () => {
  await setup()
  await fireEvent.change(screen.getByLabelText('Worker filter'), { target: { value: 'W1' } })
  await tick()
  expect(paths()).toEqual(['a1.ts', 'w1.ts'])
  await fireEvent.keyDown(window, { key: 'j' })
  expect(review.selected?.path).toBe('a1.ts')
  await fireEvent.keyDown(window, { key: 'j' })
  expect(review.selected).toEqual({ projectId: 'web', source: 'session', path: 'w1.ts' })
  await fireEvent.keyDown(window, { key: 'k' })
  await waitFor(() => expect(review.selected?.path).toBe('a1.ts'))
})

it('filters reset when the session changes', async () => {
  await setup()
  review.workerFilter = 'W2'
  review.repoFilter = 'api'
  await review.openReview('s2')
  expect(review.workerFilter).toBe('all')
  expect(review.repoFilter).toBe('all')
})
