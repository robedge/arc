import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Conversation from '../../src/renderer/src/lib/components/sessions/Conversation.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import PlanCard from '../../src/renderer/src/lib/components/sessions/PlanCard.svelte'
import type { PlanView } from '../../src/shared/types/session'

beforeEach(() => {
  activeSession.close()
})
afterEach(cleanup)

function metrics(el: HTMLElement, top: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 })
  el.scrollTop = top
}

it('shows Jump to latest when scrolled up more than 48px and hides it near the bottom', async () => {
  render(Conversation)
  await tick()
  await tick()
  const log = screen.getByRole('log', { name: 'Conversation' })
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  metrics(log, 0)
  await fireEvent.scroll(log)
  expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
  metrics(log, 760)
  await fireEvent.scroll(log)
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
})

it('Jump to latest scrolls to the bottom', async () => {
  render(Conversation)
  await tick()
  await tick()
  const log = screen.getByRole('log', { name: 'Conversation' })
  metrics(log, 0)
  await fireEvent.scroll(log)
  await fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
  expect(log.scrollTop).toBe(1000)
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
})

it('renders Jump to latest inside the scroller region, never in the footer region', async () => {
  const { createRawSnippet } = await import('svelte')
  const footer = createRawSnippet(() => ({
    render: () => '<div><textarea aria-label="Message"></textarea><button>Send</button></div>'
  }))
  const { container } = render(Conversation, { footer })
  await tick()
  await tick()
  const log = screen.getByRole('log', { name: 'Conversation' })
  metrics(log, 0)
  await fireEvent.scroll(log)
  const jump = screen.getByRole('button', { name: 'Jump to latest' })
  const scrollerRegion = container.querySelector('[data-scroller-region]')!
  const footerRegion = container.querySelector('[data-footer-region]')!
  expect(scrollerRegion.contains(jump)).toBe(true)
  expect(footerRegion.contains(jump)).toBe(false)
  expect(scrollerRegion.contains(footerRegion)).toBe(false)
  expect(footerRegion.querySelector('textarea')).not.toBeNull()
})

it('scrolls a newly proposed plan into view, and again when changes are requested', async () => {
  const scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
  const mkPlan = (over: Partial<PlanView> = {}): PlanView => ({
    id: 'p1',
    sessionId: 's1',
    status: 'proposed',
    workers: [{ name: 'api', task: 'T', repos: ['api'], model: 'sonnet', rationale: '' }],
    messageId: 1,
    replacedById: null,
    changesRequested: false,
    createdAt: 1,
    resolvedAt: null,
    ...over
  })
  const { rerender } = render(PlanCard, { plan: mkPlan(), workerModel: 'auto' })
  await tick()
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }))
  await rerender({ plan: mkPlan({ changesRequested: true }), workerModel: 'auto' })
  await tick()
  expect(scrollIntoView).toHaveBeenCalledTimes(2)
  await rerender({ plan: mkPlan({ status: 'approved' }), workerModel: 'auto' })
  await tick()
  expect(scrollIntoView).toHaveBeenCalledTimes(2)
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})
