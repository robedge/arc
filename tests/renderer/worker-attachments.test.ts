import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import type { WorkerView } from '../../src/shared/types/session'
import { mockArc } from './helpers'

const IMAGE = { id: 'img1', name: 'shot.png', kind: 'image' as const, size: 4096 }
const PDF = { id: 'pdf1', name: 'spec.pdf', kind: 'pdf' as const, size: 2048 }

function worker(over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Match the screenshot.',
    projectIds: [],
    model: 'sonnet',
    status: 'working',
    activity: 'Working',
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

beforeEach(() => {
  mockArc(() => ({ ok: true, data: undefined }))
})
afterEach(cleanup)

const section = (): HTMLElement | null => document.querySelector('[data-worker-attachments]')

it("the task view lists the worker's attachments", async () => {
  render(WorkerDetails, { worker: worker({ attachments: [IMAGE, PDF] }), onclose: () => {} })
  const box = section()!
  expect(box.textContent).toContain('spec.pdf')
  expect(box.textContent).toContain('shot.png')
  const img = box.querySelector('[data-attachment-thumb]') as HTMLImageElement
  expect(img.getAttribute('src')).toBe('arc-attachment://sent/img1?thumb=1')
  const opener = screen.getByRole('button', { name: 'Preview shot.png' })
  opener.focus()
  await fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'shot.png' })
  expect(dialog.querySelector('img')!.getAttribute('src')).toBe('arc-attachment://sent/img1')
  await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'shot.png' })).toBeNull())
  expect(document.activeElement).toBe(opener)
})

it('renders nothing when attachments are absent or empty', () => {
  const { unmount } = render(WorkerDetails, { worker: worker(), onclose: () => {} })
  expect(section()).toBeNull()
  unmount()
  render(WorkerDetails, { worker: worker({ attachments: [] }), onclose: () => {} })
  expect(section()).toBeNull()
})

it('a pushed update adding an attachment appears', async () => {
  const { rerender } = render(WorkerDetails, {
    worker: worker({ attachments: [PDF] }),
    onclose: () => {}
  })
  expect(section()!.textContent).not.toContain('shot.png')
  await rerender({ worker: worker({ attachments: [PDF, IMAGE], updatedAt: 2 }), onclose: () => {} })
  expect(section()!.textContent).toContain('shot.png')
})
