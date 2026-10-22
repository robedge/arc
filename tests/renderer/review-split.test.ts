import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { ReviewFileDiff } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

const diff: ReviewFileDiff = {
  kind: 'text',
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,3 +1,3 @@',
      lines: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
        { kind: 'del', oldNo: 2, text: 'old line' },
        { kind: 'add', newNo: 2, text: 'new line' },
        { kind: 'add', newNo: 3, text: 'extra line' }
      ]
    },
    {
      oldStart: 90,
      oldLines: 1,
      newStart: 91,
      newLines: 1,
      header: '@@ -90 +91 @@',
      lines: [{ kind: 'ctx', oldNo: 90, newNo: 91, text: 'far' }]
    }
  ]
}

async function openFile(): Promise<void> {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
  await fireEvent.click(screen.getByRole('option', { name: /a\.ts/ }))
  await waitFor(() => expect(document.querySelector('[data-diff-scroll]')).toBeTruthy())
}

beforeEach(() => {
  localStorage.clear()
  review.reset()
  review.layout = 'unified'
  mockHarness((channel) => {
    if (channel === 'review:get') {
      return {
        ok: true,
        data: {
          sessionId: 's1',
          workers: [],
          repos: [
            {
              projectId: 'api',
              projectName: 'api',
              branch: 'arc/s',
              push: { state: 'never' },
              uncommitted: { state: 'ok', files: [] },
              files: [
                {
                  path: 'a.ts',
                  status: 'M',
                  added: 3,
                  removed: 1,
                  binary: false,
                  large: false,
                  workers: []
                }
              ]
            }
          ]
        }
      }
    }
    return { ok: true, data: diff }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('side-by-side view', () => {
  it('shows removed on the left and added on the right with numbers on both sides', async () => {
    review.layout = 'split'
    await openFile()
    const olds = [...document.querySelectorAll<HTMLElement>('[data-split-cell="old"]')]
    const news = [...document.querySelectorAll<HTMLElement>('[data-split-cell="new"]')]
    const rows = olds.map((old, i) => ({ old, new: news[i]! }))
    const cells = (row: { old: HTMLElement; new: HTMLElement }, side: 'old' | 'new'): HTMLElement =>
      row[side]
    expect(cells(rows[0]!, 'old').textContent).toContain('keep')
    expect(cells(rows[0]!, 'new').textContent).toContain('keep')
    const del = cells(rows[1]!, 'old')
    const add = cells(rows[1]!, 'new')
    expect(del.dataset.diffLine).toBe('del')
    expect(del.className).toContain('bg-danger/10')
    expect(del.querySelector('[data-line-no]')?.textContent).toBe('2')
    expect(del.querySelector('[data-sign]')?.textContent).toBe('−')
    expect(add.dataset.diffLine).toBe('add')
    expect(add.className).toContain('bg-success/10')
    expect(add.querySelector('[data-line-no]')?.textContent).toBe('2')
    expect(add.querySelector('[data-sign]')?.textContent).toBe('+')
    // The leftover added line has an empty left cell.
    expect(cells(rows[2]!, 'old').dataset.diffLine).toBe('empty')
    expect(cells(rows[2]!, 'new').querySelector('[data-line-no]')?.textContent).toBe('3')
    expect(document.querySelector('[data-diff-hunk]')?.textContent).toContain('@@ -1,3 +1,3 @@')
  })

  it('the toggle switches the diff component and is keyboard operable', async () => {
    await openFile()
    expect(document.querySelector('[data-diff-split]')).toBeNull()
    expect(document.querySelector('[data-old-no]')).toBeTruthy()
    const split = screen.getByRole('radio', { name: 'Side-by-side' })
    expect((screen.getByRole('radio', { name: 'Single' }) as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(split)
    await waitFor(() => expect(document.querySelector('[data-diff-split]')).toBeTruthy())
    expect(document.querySelector('[data-old-no]')).toBeNull()
    await fireEvent.click(screen.getByRole('radio', { name: 'Single' }))
    await waitFor(() => expect(document.querySelector('[data-diff-split]')).toBeNull())
  })

  it('n and p move between hunks in the split view', async () => {
    review.layout = 'split'
    await openFile()
    const scroller = document.querySelector('[data-diff-scroll]') as HTMLElement
    await fireEvent.keyDown(window, { key: 'n' })
    // Rows: hunk, 3 pairs, hunk -> the second header is row 4 at 20px each.
    await waitFor(() => expect(scroller.scrollTop).toBe(0))
    await fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(scroller.scrollTop).toBe(80))
    await fireEvent.keyDown(window, { key: 'p' })
    await waitFor(() => expect(scroller.scrollTop).toBe(0))
  })

  it('the two panes share one vertical scroll position', async () => {
    review.layout = 'split'
    await openFile()
    const oldPane = document.querySelector('[data-diff-pane="old"]') as HTMLElement
    const newPane = document.querySelector('[data-diff-pane="new"]') as HTMLElement
    newPane.scrollTop = 40
    await fireEvent.scroll(newPane)
    expect(oldPane.scrollTop).toBe(40)
    oldPane.scrollTop = 20
    await fireEvent.scroll(oldPane)
    expect(newPane.scrollTop).toBe(20)
  })

  it('the header wraps on a narrow window instead of squeezing its controls', async () => {
    await openFile()
    const header = document.querySelector('[data-review-header]') as HTMLElement
    expect(header.className).toContain('flex-wrap')
    expect(header.querySelector('h2')?.className).toContain('shrink-0')
    expect(header.querySelector('[data-review-layout]')?.className).toContain('whitespace-nowrap')
  })

  it('keeps the worker filter label distinct from a worker model control', async () => {
    await openFile()
    expect(screen.getByLabelText('Worker filter')).toBeTruthy()
    expect(screen.queryByLabelText(/^Worker model/)).toBeNull()
  })
})

describe('layout preference', () => {
  /** A fresh store, as built when the renderer loads. */
  async function freshStore(): Promise<{ layout: 'unified' | 'split' }> {
    vi.resetModules()
    const mod = await import('../../src/renderer/src/lib/stores/review.svelte')
    return mod.review
  }

  it('is written on change and read once when the store is built', async () => {
    const a = await freshStore()
    expect(a.layout).toBe('unified')
    a.layout = 'split'
    expect(localStorage.getItem('arc.review.layout')).toBe('split')
    expect((await freshStore()).layout).toBe('split')
    a.layout = 'unified'
    expect((await freshStore()).layout).toBe('unified')
  })

  it('ignores an unknown stored value', async () => {
    localStorage.setItem('arc.review.layout', 'sideways')
    expect((await freshStore()).layout).toBe('unified')
  })

  it('falls back to unified without errors when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const store = await freshStore()
    expect(store.layout).toBe('unified')
    expect(() => {
      store.layout = 'split'
    }).not.toThrow()
    expect(store.layout).toBe('split')
  })
})
