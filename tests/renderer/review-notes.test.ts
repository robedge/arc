import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { AppError } from '../../src/shared/errors'
import type { ReviewFileDiff, ReviewNote } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

const diff: ReviewFileDiff = {
  kind: 'text',
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,2 +1,3 @@',
      lines: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
        { kind: 'del', oldNo: 2, text: 'old line' },
        { kind: 'add', newNo: 2, text: 'new line' },
        { kind: 'add', newNo: 3, text: 'extra line' }
      ]
    }
  ]
}

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  id: 'n1',
  projectId: 'api',
  path: 'a.ts',
  side: 'new',
  line: 2,
  lineText: 'new line',
  body: 'Use a constant here.',
  state: 'draft',
  stale: false,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

let notes: ReviewNote[]
let failWith: AppError | null
let invoke: ReturnType<typeof mockHarness>

const sessionFile = {
  path: 'a.ts',
  status: 'M' as const,
  added: 3,
  removed: 1,
  binary: false,
  large: false,
  workers: [],
  reviewed: false,
  changedSinceReviewed: false
}

function setup(): void {
  invoke = mockHarness((channel, request) => {
    if (channel === 'review:get') {
      return {
        ok: true,
        data: {
          sessionId: 's1',
          workers: [],
          notes,
          repos: [
            {
              projectId: 'api',
              projectName: 'api',
              branch: 'arc/s',
              push: { state: 'never' },
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
              },
              files: [sessionFile]
            }
          ]
        }
      }
    }
    if (channel === 'review:file') return { ok: true, data: diff }
    if (channel.startsWith('review:note-') || channel === 'review:send-notes') {
      if (failWith) return { ok: false, error: failWith }
    }
    const req = request as Record<string, unknown>
    if (channel === 'review:note-create') {
      const created = note({
        id: `n${notes.length + 10}`,
        side: req.side as 'old' | 'new',
        line: req.line as number,
        lineText: req.lineText as string,
        body: req.body as string
      })
      notes = [...notes, created]
      return { ok: true, data: created }
    }
    if (channel === 'review:note-update') {
      const updated = { ...notes.find((n) => n.id === req.noteId)!, body: req.body as string }
      notes = notes.map((n) => (n.id === updated.id ? updated : n))
      return { ok: true, data: updated }
    }
    if (channel === 'review:note-delete') {
      notes = notes.filter((n) => n.id !== req.noteId)
      return { ok: true, data: undefined }
    }
    if (channel === 'sessions:page') {
      return {
        ok: true,
        data: [
          {
            id: 7,
            sessionId: 's1',
            role: 'user',
            content: 'Review notes (2):\n1. api · a.ts · line 2 (new)',
            state: 'complete',
            planId: null,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    }
    if (channel === 'review:send-notes') {
      return {
        ok: true,
        data: { messageId: 7, count: notes.filter((n) => n.state === 'draft').length }
      }
    }
    return { ok: true, data: undefined }
  })
}

async function openFile(path = /a\.ts/): Promise<void> {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
  await fireEvent.click(screen.getByRole('option', { name: path }))
  await waitFor(() => expect(document.querySelector('[data-diff-scroll]')).toBeTruthy())
}

const labels = (): string[] =>
  [...document.querySelectorAll('[data-add-note]')].map((b) => b.getAttribute('aria-label') ?? '')

beforeEach(() => {
  localStorage.clear()
  review.reset()
  activeSession.close()
  review.layout = 'unified'
  notes = []
  failWith = null
  setup()
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('Add note gutter buttons', () => {
  it('unified: removed lines are on the old side, added and context lines on the new side', async () => {
    await openFile()
    expect(labels()).toEqual([
      'Add note on line 1 (new)',
      'Add note on line 2 (old)',
      'Add note on line 2 (new)',
      'Add note on line 3 (new)'
    ])
  })

  it('split: each cell is on its own side', async () => {
    review.layout = 'split'
    await openFile()
    // The before pane comes first in the DOM, then the after pane.
    expect(labels()).toEqual([
      'Add note on line 1 (old)',
      'Add note on line 2 (old)',
      'Add note on line 1 (new)',
      'Add note on line 2 (new)',
      'Add note on line 3 (new)'
    ])
  })

  it('are real buttons that stay in the tab order', async () => {
    await openFile()
    const button = screen.getByRole('button', { name: 'Add note on line 2 (old)' })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('tabindex')).toBeNull()
  })

  it('are absent on uncommitted files', async () => {
    await openFile(/hand\.ts/)
    expect(document.querySelector('[data-diff-line]')).toBeTruthy()
    expect(labels()).toEqual([])
  })
})

describe('writing notes', () => {
  async function openComposerOnDeletedLine(): Promise<HTMLTextAreaElement> {
    await openFile()
    await fireEvent.click(screen.getByRole('button', { name: 'Add note on line 2 (old)' }))
    return (await screen.findByRole('textbox', {
      name: /Note on line 2 \(old\)/
    })) as HTMLTextAreaElement
  }

  it('saving creates a draft with the line anchor and the send button counts it', async () => {
    const box = await openComposerOnDeletedLine()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.getAttribute('disabled')).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Send 0 notes to brain' }).hasAttribute('disabled')
    ).toBe(true)
    await fireEvent.input(box, { target: { value: 'Why remove this?' } })
    await fireEvent.click(save)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send 1 note to brain' })).toBeTruthy()
    )
    expect(invoke).toHaveBeenCalledWith('review:note-create', {
      sessionId: 's1',
      projectId: 'api',
      path: 'a.ts',
      side: 'old',
      line: 2,
      lineText: 'old line',
      body: 'Why remove this?'
    })
    const thread = document.querySelector('[data-note-thread]') as HTMLElement
    expect(within(thread).getByText('Why remove this?')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Escape cancels without saving', async () => {
    const box = await openComposerOnDeletedLine()
    await fireEvent.input(box, { target: { value: 'draft text' } })
    await fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('review:note-create', expect.anything())
  })

  it('Cmd+Enter saves', async () => {
    const box = await openComposerOnDeletedLine()
    await fireEvent.input(box, { target: { value: 'via keyboard' } })
    await fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send 1 note to brain' })).toBeTruthy()
    )
  })

  it('shows the too-many-notes message and keeps the text', async () => {
    const box = await openComposerOnDeletedLine()
    failWith = { code: 'TOO_MANY_NOTES', message: 'x' } as AppError
    await fireEvent.input(box, { target: { value: 'one more' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('You can send up to 50 notes at a time.')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('one more')
  })
})

describe('saved notes', () => {
  it('drafts can be edited and deleted', async () => {
    notes = [note()]
    await openFile()
    expect(screen.getByText('Use a constant here.')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement
    expect(box.value).toBe('Use a constant here.')
    await fireEvent.input(box, { target: { value: 'Use a named constant.' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Use a named constant.')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('review:note-update', {
      noteId: 'n1',
      body: 'Use a named constant.'
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Use a named constant.')).toBeNull())
    expect(screen.getByRole('button', { name: 'Send 0 notes to brain' })).toBeTruthy()
  })

  it('sent notes show Sent and have no Edit or Delete', async () => {
    notes = [note({ state: 'sent', messageId: 3 })]
    await openFile()
    expect(screen.getByText('Sent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('a stale note says it changed since it was written', async () => {
    notes = [note({ stale: true })]
    await openFile()
    expect(screen.getByText('Changed since you wrote this')).toBeTruthy()
  })

  it('a note whose line is not in the diff is still listed, with its line', async () => {
    notes = [note({ line: 99 })]
    await openFile()
    const loose = document.querySelector('[data-loose-notes]') as HTMLElement
    expect(within(loose).getByText('Use a constant here.')).toBeTruthy()
    expect(loose.textContent).toContain('line 99 (new)')
  })

  it('notes on files no longer changed are listed in the header', async () => {
    notes = [note({ path: 'gone.ts', line: 4 })]
    await openFile()
    await fireEvent.click(screen.getByRole('button', { name: '1 note on files no longer changed' }))
    const item = document.querySelector('[data-gone-note]') as HTMLElement
    expect(item.textContent).toContain('gone.ts')
    expect(item.textContent).toContain('line 4 (new)')
  })
})

describe('Send notes to brain', () => {
  it('posts once, marks the drafts sent and confirms', async () => {
    notes = [note(), note({ id: 'n2', line: 3, body: 'Second.' })]
    await openFile()
    const send = screen.getByRole('button', { name: 'Send 2 notes to brain' })
    await fireEvent.click(send)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send 0 notes to brain' })).toBeTruthy()
    )
    expect(invoke).toHaveBeenCalledWith('review:send-notes', { sessionId: 's1' })
    expect(screen.getAllByText('Sent')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(toasts.list.map((t) => t.message)).toContain('Sent 2 notes to the brain')
  })

  it('adds the sent message to the open conversation, since user messages are not pushed', async () => {
    notes = [note(), note({ id: 'n2', line: 3, body: 'Second.' })]
    activeSession.sessionId = 's1'
    await openFile()
    await fireEvent.click(screen.getByRole('button', { name: 'Send 2 notes to brain' }))
    await waitFor(() => expect(activeSession.messages.map((m) => m.id)).toEqual([7]))
    expect(activeSession.messages[0]?.content).toContain('Review notes (2):')
    expect(invoke).toHaveBeenCalledWith('sessions:page', {
      sessionId: 's1',
      kind: 'messages',
      beforeId: 8,
      limit: 1
    })
  })

  it('shows the error when sending fails and keeps the drafts', async () => {
    notes = [note()]
    await openFile()
    failWith = { code: 'TOO_MANY_NOTES', message: 'x' } as AppError
    await fireEvent.click(screen.getByRole('button', { name: 'Send 1 note to brain' }))
    expect(await screen.findByText('You can send up to 50 notes at a time.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send 1 note to brain' })).toBeTruthy()
  })
})
