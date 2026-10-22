import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ReviewScreen from '../../src/renderer/src/lib/components/review/ReviewScreen.svelte'
import { eventStyle } from '../../src/renderer/src/lib/components/sessions/event-kinds'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import type { ReviewPush } from '../../src/shared/types/review'
import { mockHarness } from './helpers'

const COMMAND = 'git push -u origin arc/s'
let push: ReviewPush
let previewResult: () => unknown
let pushResult: () => unknown | Promise<unknown>
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  review.reset()
  toasts.list = []
  push = { state: 'never' }
  previewResult = () => ({ ok: true, data: { command: COMMAND, remote: 'origin' } })
  pushResult = () => {
    push = { state: 'pushed', remote: 'origin', at: Date.now(), newerCommits: 0 }
    return { ok: true, data: { pushedAt: Date.now(), remote: 'origin', sha: 'abc' } }
  }
  invoke = mockHarness(async (channel) => {
    if (channel === 'review:get') {
      return {
        ok: true,
        data: {
          sessionId: 's1',
          workers: ['W1'],
          notes: [],
          repos: [
            {
              projectId: 'api',
              projectName: 'api',
              branch: 'arc/s',
              push,
              files: [],
              uncommitted: { state: 'ok', files: [] }
            }
          ]
        }
      }
    }
    if (channel === 'review:push-preview') return previewResult() as never
    if (channel === 'review:push') return (await pushResult()) as never
    return { ok: true, data: {} }
  })
})
afterEach(cleanup)

async function show(): Promise<void> {
  await review.openReview('s1')
  render(ReviewScreen, { onback: vi.fn() })
}
const pushCalls = (): unknown[] => invoke.mock.calls.filter((c) => c[0] === 'review:push')
const pushButton = async (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: 'Push branch' })
async function openDialog(): Promise<void> {
  await show()
  await fireEvent.click(await pushButton())
  await screen.findByRole('dialog')
}
const confirm = (): HTMLElement => screen.getByRole('button', { name: 'Push' })

it('previews and shows the exact command and remote; nothing is pushed until Push', async () => {
  await openDialog()
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector('code.font-mono')?.textContent).toBe(COMMAND)
  expect(dialog.textContent).toContain('origin')
  expect(invoke).toHaveBeenCalledWith('review:push-preview', { sessionId: 's1', projectId: 'api' })
  expect(pushCalls()).toHaveLength(0)
})

it('Cancel closes the dialog without pushing', async () => {
  await openDialog()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(pushCalls()).toHaveLength(0)
})

it('is busy while pushing and cannot be cancelled', async () => {
  let release: () => void = () => {}
  pushResult = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, data: { pushedAt: 1, remote: 'origin', sha: 'abc' } })
    })
  await openDialog()
  await fireEvent.click(confirm())
  await waitFor(() => expect(confirm().getAttribute('aria-busy')).toBe('true'))
  expect((confirm() as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  release()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('on failure keeps the dialog open and shows git message verbatim; the repo is not marked pushed', async () => {
  const reason = ' ! [rejected] arc/s -> arc/s (non-fast-forward)\nerror: failed to push some refs'
  pushResult = () => ({ ok: false, error: { code: 'PUSH_FAILED', details: { reason } } })
  await openDialog()
  await fireEvent.click(confirm())
  const headline = await screen.findByRole('alert')
  expect(headline.textContent).toContain('The push failed.')
  const git = screen.getByRole('dialog').querySelector('pre.font-mono')
  expect(git?.textContent).toBe(reason)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.querySelector('[data-push-tag]')).toBeNull()
  expect(toasts.list).toHaveLength(0)
  expect((confirm() as HTMLButtonElement).disabled).toBe(false)
})

it('on success closes, shows the Pushed tag and toasts', async () => {
  await openDialog()
  await fireEvent.click(confirm())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(pushCalls()).toEqual([
    ['review:push', { sessionId: 's1', projectId: 'api', confirm: true }]
  ])
  await waitFor(() =>
    expect(document.querySelector('[data-push-tag]')?.textContent).toMatch(/^Pushed \d\d:\d\d$/)
  )
  expect(toasts.list.map((t) => t.message)).toEqual(['Pushed arc/s to origin'])
})

it('a preview error is a toast and opens no dialog', async () => {
  previewResult = () => ({ ok: false, error: { code: 'WAITING_FOR_CHECKOUT' } })
  await show()
  await fireEvent.click(await pushButton())
  await waitFor(() => expect(toasts.list).toHaveLength(1))
  expect(toasts.list[0]?.message).toBe('Waiting for your checkout')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('no remote disables the button with its reason', async () => {
  push = { state: 'no-remote' }
  await show()
  const button = await pushButton()
  expect(button.getAttribute('aria-disabled')).toBe('true')
  const why = document.querySelector('[data-push-why]')
  expect(why?.textContent).toBe('No remote configured')
  expect(button.getAttribute('aria-describedby')).toBe(why?.id)
  await fireEvent.click(button)
  expect(invoke).not.toHaveBeenCalledWith('review:push-preview', expect.anything())
})

it('waiting for the checkout disables the button with its reason', async () => {
  push = { state: 'waiting' }
  await show()
  const button = await pushButton()
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.querySelector('[data-push-why]')?.textContent).toBe('Waiting for your checkout')
})

it('shows newer commits in the singular and plural, and the date when not today', async () => {
  push = { state: 'pushed', remote: 'origin', at: Date.now(), newerCommits: 1 }
  await show()
  await waitFor(() =>
    expect(document.querySelector('[data-push-tag]')?.textContent).toMatch(
      /^Pushed \d\d:\d\d · 1 newer commit$/
    )
  )
  cleanup()
  review.reset()
  push = { state: 'pushed', remote: 'origin', at: Date.now() - 3 * 86400000, newerCommits: 2 }
  await show()
  await waitFor(() => {
    const text = document.querySelector('[data-push-tag]')?.textContent ?? ''
    expect(text).toMatch(/^Pushed .+, \d\d:\d\d · 2 newer commits$/)
  })
})

it('styles the push event as a success', () => {
  expect(eventStyle('push')).toMatchObject({ icon: 'success', tone: 'success' })
})
