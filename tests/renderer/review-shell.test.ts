import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import ReviewFileList from '../../src/renderer/src/lib/components/review/ReviewFileList.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { review } from '../../src/renderer/src/lib/stores/review.svelte'
import type { ReviewSnapshot } from '../../src/shared/types/review'
import type { SessionHeader as Header, SessionSnapshot } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
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
}

const snapshotOf = (changedFileCount: number): SessionSnapshot => ({
  header,
  messages: [],
  events: [],
  workers: [],
  plan: null,
  attention: [],
  brainState: 'idle',
  changedFileCount,
  seq: 0
})

const reviewData: ReviewSnapshot = {
  sessionId: 's1',
  workers: ['W1', 'You'],
  notes: [],
  repos: [
    {
      projectId: 'api',
      projectName: 'api',
      branch: 'arc/fix-sync',
      uncommitted: { state: 'ok', files: [] },
      push: { state: 'never' },
      files: [
        {
          path: 'src/a.ts',
          status: 'M',
          added: 3,
          removed: 1,
          binary: false,
          large: false,
          workers: ['You'],
          reviewed: false,
          changedSinceReviewed: false
        },
        {
          path: 'src/b.ts',
          status: 'A',
          added: 10,
          removed: 0,
          binary: false,
          large: false,
          workers: ['You'],
          reviewed: false,
          changedSinceReviewed: false
        },
        {
          path: 'src/new.ts',
          oldPath: 'src/old.ts',
          status: 'R',
          added: 0,
          removed: 0,
          binary: false,
          large: false,
          workers: ['W1'],
          reviewed: false,
          changedSinceReviewed: false
        }
      ]
    },
    {
      projectId: 'web',
      projectName: 'web',
      branch: 'arc/fix-sync',
      uncommitted: { state: 'ok', files: [] },
      push: { state: 'never' },
      files: [
        {
          path: 'src/c.ts',
          status: 'D',
          added: 0,
          removed: 7,
          binary: false,
          large: false,
          workers: ['You'],
          reviewed: false,
          changedSinceReviewed: false
        }
      ]
    }
  ]
}

beforeEach(() => {
  review.reset()
  activeSession.close()
  mockHarness((channel) => {
    if (channel === 'review:get') return { ok: true, data: reviewData }
    return { ok: true, data: {} }
  })
})
afterEach(cleanup)

it('shows the count in the button and opens the review on click', async () => {
  const onreview = vi.fn()
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn(), changedCount: 12, onreview })
  const button = screen.getByRole('button', { name: 'Review changes · 12' })
  expect(button.getAttribute('aria-disabled')).toBeNull()
  await fireEvent.click(button)
  expect(onreview).toHaveBeenCalledTimes(1)
})

it('at 0 is aria-disabled, explains itself on hover and focus, and does nothing on click', async () => {
  const onreview = vi.fn()
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn(), changedCount: 0, onreview })
  const button = screen.getByRole('button', { name: 'Review changes · 0' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('tooltip')).toBeNull()
  await fireEvent.mouseEnter(button.parentElement as HTMLElement)
  expect(screen.getByRole('tooltip').textContent).toBe('No changes yet')
  await fireEvent.mouseLeave(button.parentElement as HTMLElement)
  expect(screen.queryByRole('tooltip')).toBeNull()
  await fireEvent.focusIn(button)
  expect(screen.getByRole('tooltip').textContent).toBe('No changes yet')
  expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
  await fireEvent.click(button)
  expect(onreview).not.toHaveBeenCalled()
})

it('groups files by repository with status, path and counts', () => {
  render(ReviewFileList, { repos: reviewData.repos, selected: null, onselect: vi.fn() })
  const api = screen.getByRole('region', { name: 'api' })
  expect(within(api).getByText('arc/fix-sync')).toBeTruthy()
  expect(within(api).getAllByRole('option')).toHaveLength(3)
  const changed = within(api).getByRole('option', { name: /src\/a\.ts/ })
  expect(changed.textContent).toContain('Changed')
  expect(changed.textContent).toContain('+3')
  expect(changed.textContent).toContain('−1')
  expect(within(api).getByRole('option', { name: /src\/b\.ts/ }).textContent).toContain('Added')
  expect(
    within(api).getByRole('option', { name: /src\/old\.ts → src\/new\.ts/ }).textContent
  ).toContain('Renamed')
  const web = screen.getByRole('region', { name: 'web' })
  expect(within(web).getByRole('option', { name: /src\/c\.ts/ }).textContent).toContain('Deleted')
})

it('Back to session keeps the conversation mounted with its scroll position', async () => {
  activeSession.setSnapshot(snapshotOf(4))
  render(SessionScreen)
  await tick()
  await tick()
  const log = screen.getByRole('log', { name: 'Conversation' })
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
  log.scrollTop = 120
  await fireEvent.scroll(log)

  await fireEvent.click(screen.getByRole('button', { name: 'Review changes · 4' }))
  await waitFor(() => expect(screen.getByText('src/c.ts')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Review changes · 4' })).toBeTruthy()
  expect((document.querySelector('[data-session-body]') as HTMLElement | null)?.inert).toBe(true)

  await fireEvent.click(screen.getByRole('button', { name: 'Back to session' }))
  await tick()
  expect(document.querySelector('[data-review-screen]')).toBeNull()
  expect((document.querySelector('[data-session-body]') as HTMLElement | null)?.inert).toBe(false)
  const after = screen.getByRole('log', { name: 'Conversation' })
  expect(after).toBe(log)
  expect(after.scrollTop).toBe(120)
})

it('Conversation restores its scroll position when mounted again, and stays stuck to the bottom', async () => {
  activeSession.setSnapshot(snapshotOf(0))
  const { default: Conversation } =
    await import('../../src/renderer/src/lib/components/sessions/Conversation.svelte')
  const metrics = (el: HTMLElement): void => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 })
  }
  const first = render(Conversation)
  await tick()
  let log = screen.getByRole('log', { name: 'Conversation' })
  metrics(log)
  log.scrollTop = 90
  await fireEvent.scroll(log)
  first.unmount()

  const second = render(Conversation)
  await tick()
  await tick()
  log = screen.getByRole('log', { name: 'Conversation' })
  expect(log.scrollTop).toBe(90)
  metrics(log)
  log.scrollTop = 800
  await fireEvent.scroll(log)
  second.unmount()

  render(Conversation)
  await tick()
  await tick()
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
})
