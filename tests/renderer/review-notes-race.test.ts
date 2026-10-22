// @spec: 004-change-review
import { beforeEach, expect, it } from 'vitest'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { ReviewNote, ReviewSnapshot } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

function note(id: string): ReviewNote {
  return {
    id,
    projectId: 'p1',
    path: 'config.txt',
    side: 'new',
    line: 6,
    lineText: 'x',
    body: id,
    state: 'draft',
    stale: false,
    createdAt: 1,
    updatedAt: 1
  }
}

const snapshot = (notes: ReviewNote[]): ReviewSnapshot => ({
  sessionId: 's1',
  repos: [],
  workers: [],
  notes
})

beforeEach(() => review.reset())

it('a refresh that was already running when a note was saved does not make the note disappear', async () => {
  let answerGet: (() => void) | null = null
  mockHarness((channel) => {
    if (channel === 'review:get') {
      // The main process read the notes before the new one existed, and answers late.
      const stale = snapshot([note('n1')])
      return new Promise((resolve) => {
        answerGet = () => resolve({ ok: true, data: stale })
      })
    }
    return { ok: true, data: note('n2') }
  })
  review.sessionId = 's1'
  const loading = review.load()
  review.openComposer({ projectId: 'p1', path: 'config.txt', side: 'new', line: 6, lineText: 'x' })
  expect(await review.createNote('n2')).toBeNull()
  answerGet!()
  await loading
  expect(review.notes.map((n) => n.id)).toEqual(['n2'])
})
