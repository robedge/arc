import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { ReviewFile, ReviewFileDiff, ReviewRepo } from '../../src/shared/types/review'
import type { SessionSnapshot } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const file = (path: string, added = 1): ReviewFile => ({
  path,
  status: 'M',
  added,
  removed: 0,
  binary: false,
  large: false,
  workers: ['W1'],
  reviewed: false,
  changedSinceReviewed: false
})

let repos: ReviewRepo[] = []
const repo = (files: ReviewFile[]): ReviewRepo[] => [
  {
    projectId: 'api',
    projectName: 'api',
    branch: 'arc/s',
    files,
    uncommitted: { state: 'ok', files: [] },
    push: { state: 'never' }
  }
]

const textDiff: ReviewFileDiff = {
  kind: 'text',
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
        { kind: 'del', oldNo: 2, text: 'old line' },
        { kind: 'add', newNo: 2, text: 'new line', noNewline: true }
      ]
    }
  ]
}

let diffs: Record<string, ReviewFileDiff | { error: string }> = {}
let invoke: ReturnType<typeof mockHarness>

function setup(): void {
  invoke = mockHarness((channel, request) => {
    if (channel === 'review:get') return { ok: true, data: { sessionId: 's1', repos } }
    if (channel === 'review:file') {
      const req = request as { path: string; showAnyway?: boolean }
      const d = diffs[req.path]
      if (d && 'error' in d) return { ok: false, error: { code: 'REVIEW_FILE_NOT_FOUND' } }
      return { ok: true, data: d ?? textDiff }
    }
    return { ok: true, data: {} }
  })
}

const fileCalls = (): unknown[] =>
  invoke.mock.calls.filter((c) => c[0] === 'review:file').map((c) => c[1])

function snapshot(): SessionSnapshot {
  return {
    header: {
      id: 's1',
      groupId: 'g1',
      name: 'S',
      mode: 'autonomous',
      workerLimit: 4,
      model: 'auto',
      brainModel: 'sonnet',
      autoApprove: false,
      allowRules: [],
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1,
      branches: []
    },
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention: [],
    brainState: 'idle',
    changedFileCount: 2,
    seq: 5
  }
}

const event = (
  over: Partial<{ sessionId: string; seq: number; changedPaths: string[]; fileCount: number }> = {}
) => ({
  sessionId: 's1',
  projectId: 'api',
  seq: 6,
  changedPaths: ['a.ts'],
  fileCount: 3,
  ...over
})

/** What App.svelte does with the push. */
function push(e: ReturnType<typeof event>): void {
  if (activeSession.applyReviewChanged(e)) review.queueRefresh(e)
}

beforeEach(() => {
  review.reset()
  activeSession.close()
  activeSession.setSnapshot(snapshot())
  repos = repo([file('a.ts'), file('b.ts')])
  diffs = {}
  setup()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('diff rendering', () => {
  it('tints added and removed lines, shows signs, gutters and the no-newline marker', async () => {
    await review.openReview('s1')
    render(ReviewScreen, { onback: vi.fn() })
    await fireEvent.click(screen.getByRole('option', { name: /a\.ts/ }))
    await waitFor(() => expect(document.querySelector('[data-diff-line]')).toBeTruthy())
    const add = document.querySelector('[data-diff-line="add"]') as HTMLElement
    const del = document.querySelector('[data-diff-line="del"]') as HTMLElement
    const ctx = document.querySelector('[data-diff-line="ctx"]') as HTMLElement
    expect(add.className).toContain('bg-success/10')
    expect(del.className).toContain('bg-danger/10')
    expect(ctx.className).not.toMatch(/bg-(success|danger)/)
    expect(add.querySelector('[data-sign]')?.textContent).toBe('+')
    expect(del.querySelector('[data-sign]')?.textContent).toBe('−')
    expect(del.querySelector('[data-old-no]')?.textContent).toBe('2')
    expect(del.querySelector('[data-new-no]')?.textContent).toBe('')
    expect(add.querySelector('[data-new-no]')?.textContent).toBe('2')
    expect(document.querySelector('[data-diff-hunk]')?.textContent).toContain('@@ -1,2 +1,2 @@')
    expect(screen.getByText('\\ No newline at end of file')).toBeTruthy()
  })

  it('binary, too large and empty states', async () => {
    diffs = {
      'a.ts': { kind: 'binary' },
      'b.ts': { kind: 'tooLarge', changedLines: 60000 },
      'c.ts': { kind: 'text', hunks: [] }
    }
    repos = repo([file('a.ts'), file('b.ts'), file('c.ts')])
    await review.openReview('s1')
    render(ReviewScreen, { onback: vi.fn() })
    await fireEvent.click(screen.getByRole('option', { name: /a\.ts/ }))
    await waitFor(() => expect(screen.getByText('Binary file changed')).toBeTruthy())
    await fireEvent.click(screen.getByRole('option', { name: /b\.ts/ }))
    await waitFor(() =>
      expect(screen.getByText('Too large to display (60,000 lines)')).toBeTruthy()
    )
    await fireEvent.click(screen.getByRole('option', { name: /c\.ts/ }))
    await waitFor(() => expect(screen.getByText('No line changes')).toBeTruthy())
  })

  it('a large file waits for Show anyway, which refetches with showAnyway and is remembered', async () => {
    diffs = { 'a.ts': { kind: 'large', changedLines: 2431 } }
    await review.openReview('s1')
    render(ReviewScreen, { onback: vi.fn() })
    await fireEvent.click(screen.getByRole('option', { name: /a\.ts/ }))
    await waitFor(() => expect(screen.getByText('Large change: 2,431 lines')).toBeTruthy())
    expect(fileCalls()).toEqual([{ sessionId: 's1', projectId: 'api', path: 'a.ts' }])
    diffs = { 'a.ts': textDiff }
    await fireEvent.click(screen.getByRole('button', { name: 'Show anyway' }))
    await waitFor(() => expect(document.querySelector('[data-diff-line]')).toBeTruthy())
    expect(fileCalls()[1]).toEqual({
      sessionId: 's1',
      projectId: 'api',
      path: 'a.ts',
      showAnyway: true
    })
    await fireEvent.click(screen.getByRole('option', { name: /b\.ts/ }))
    await fireEvent.click(screen.getByRole('option', { name: /a\.ts/ }))
    await waitFor(() => expect(fileCalls()).toHaveLength(4))
    expect(fileCalls()[3]).toMatchObject({ path: 'a.ts', showAnyway: true })
  })

  it('REVIEW_FILE_NOT_FOUND clears the selection', async () => {
    diffs = { 'a.ts': { error: 'gone' } }
    await review.openReview('s1')
    render(ReviewScreen, { onback: vi.fn() })
    await fireEvent.click(screen.getByRole('option', { name: /a\.ts/ }))
    await waitFor(() => expect(review.selected).toBeNull())
    expect(screen.getByText('Select a file to see its changes')).toBeTruthy()
  })
})

describe('live update', () => {
  beforeEach(async () => {
    await review.openReview('s1')
    review.select('api', 'session', 'a.ts')
    await vi.waitFor(() => expect(review.diff).not.toBeNull())
    vi.useFakeTimers()
  })

  it('keeps the selected file and refetches its diff only when its path changed', async () => {
    repos = repo([file('a.ts', 2), file('b.ts'), file('c.ts')])
    push(event({ changedPaths: ['c.ts'], fileCount: 3 }))
    await vi.advanceTimersByTimeAsync(299)
    expect(invoke.mock.calls.filter((c) => c[0] === 'review:get')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(review.selected).toEqual({ projectId: 'api', source: 'session', path: 'a.ts' })
    expect(review.fileCount).toBe(3)
    // a.ts itself changed shape (+2) so it refetches as well.
    expect(fileCalls()).toHaveLength(2)

    push(event({ seq: 7, changedPaths: ['b.ts'], fileCount: 3 }))
    await vi.advanceTimersByTimeAsync(400)
    expect(fileCalls()).toHaveLength(2)

    push(event({ seq: 8, changedPaths: ['a.ts'], fileCount: 3 }))
    await vi.advanceTimersByTimeAsync(400)
    expect(fileCalls()).toHaveLength(3)
    expect(review.selected).toEqual({ projectId: 'api', source: 'session', path: 'a.ts' })
  })

  it('updates the header count while the review is closed', async () => {
    review.close()
    repos = repo([file('a.ts'), file('b.ts'), file('c.ts')])
    push(event())
    expect(activeSession.changedFileCount).toBe(3)
  })

  it('ignores stale seq and other sessions', async () => {
    repos = repo([file('a.ts'), file('b.ts'), file('c.ts')])
    push(event({ seq: 5 }))
    push(event({ sessionId: 'other', seq: 9 }))
    await vi.advanceTimersByTimeAsync(500)
    expect(invoke.mock.calls.filter((c) => c[0] === 'review:get')).toHaveLength(1)
    expect(activeSession.changedFileCount).toBe(2)
  })

  it('says how many more files changed, singular and plural, then hides it', async () => {
    repos = repo([file('a.ts'), file('b.ts'), file('c.ts')])
    push(event())
    await vi.advanceTimersByTimeAsync(400)
    expect(review.notice).toBe('Updated: 1 more file changed')
    await vi.advanceTimersByTimeAsync(6000)
    expect(review.notice).toBeNull()

    repos = repo([file('a.ts'), file('b.ts', 5), file('c.ts', 4), file('d.ts')])
    push(event({ seq: 7, fileCount: 4 }))
    await vi.advanceTimersByTimeAsync(400)
    expect(review.notice).toBe('Updated: 3 more files changed')
  })
})

describe('keyboard', () => {
  it('j/k move between files and n/p between hunks, but not inside inputs', async () => {
    await review.openReview('s1')
    render(ReviewScreen, { onback: vi.fn() })
    await fireEvent.keyDown(window, { key: 'j' })
    expect(review.selected?.path).toBe('a.ts')
    await fireEvent.keyDown(window, { key: 'j' })
    expect(review.selected?.path).toBe('b.ts')
    await fireEvent.keyDown(window, { key: 'k' })
    expect(review.selected?.path).toBe('a.ts')

    const input = document.createElement('input')
    document.body.appendChild(input)
    await fireEvent.keyDown(input, { key: 'j' })
    expect(review.selected?.path).toBe('a.ts')
    input.remove()

    await waitFor(() => expect(review.diff).not.toBeNull())
    await fireEvent.keyDown(window, { key: 'n' })
    expect(review.hunkTarget?.row).toBe(0)
  })

  it('arrow keys, Home and End move the selection in the listbox', async () => {
    await review.openReview('s1')
    render(ReviewScreen, { onback: vi.fn() })
    const listbox = screen.getByRole('listbox')
    await fireEvent.keyDown(listbox, { key: 'End' })
    expect(review.selected?.path).toBe('b.ts')
    await fireEvent.keyDown(listbox, { key: 'ArrowUp' })
    expect(review.selected?.path).toBe('a.ts')
    await fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    expect(review.selected?.path).toBe('b.ts')
    await fireEvent.keyDown(listbox, { key: 'Home' })
    expect(review.selected?.path).toBe('a.ts')
  })
})
