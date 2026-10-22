import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AgentColumn from '../../src/renderer/src/lib/components/sessions/AgentColumn.svelte'
import HeaderMenu from '../../src/renderer/src/lib/components/sessions/HeaderMenu.svelte'
import type { WorkerView } from '../../src/shared/types/session'

afterEach(cleanup)

const worker = (n: number): WorkerView =>
  ({
    id: `w${n}`,
    number: n,
    slug: `job-${n}`,
    role: 'worker',
    status: 'working',
    model: 'sonnet',
    activity: 'x'
  }) as unknown as WorkerView

it('the agent column is the scroller and its cards never shrink', () => {
  const { container } = render(AgentColumn, {
    brainState: 'idle',
    workers: [1, 2, 3, 4, 5, 6].map(worker)
  })
  const column = container.querySelector('[data-agent-column]') as HTMLElement
  expect(column.classList.contains('overflow-y-auto')).toBe(true)
  expect(column.classList.contains('min-h-0')).toBe(true)
  expect(column.classList.contains('h-full')).toBe(false)
  const cards = [...column.children]
  expect(cards).toHaveLength(7)
  for (const c of cards) expect(c.classList.contains('shrink-0')).toBe(true)
})

it('lists the newest worker first, right under the brain', () => {
  const { container } = render(AgentColumn, { brainState: 'idle', workers: [1, 2, 3].map(worker) })
  const cards = [...container.querySelectorAll('[data-worker-card]')]
  expect(cards.map((c) => c.textContent?.match(/W(\d)/)?.[1])).toEqual(['3', '2', '1'])
})

it('marks the current option in the menu and keeps keyboard navigation', async () => {
  const options = [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' }
  ]
  render(HeaderMenu, {
    text: 'Brain',
    label: 'Brain model',
    options,
    current: 'sonnet',
    onselect: vi.fn()
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  const items = screen.getAllByRole('menuitemradio')
  expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  expect(items[0]).toBe(document.activeElement)
  await fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
  expect(items[1]).toBe(document.activeElement)
})
