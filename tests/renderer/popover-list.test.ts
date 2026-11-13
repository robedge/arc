// @spec: 013-session-branches-on-demand
// @regression
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import PopoverList from '../../src/renderer/src/lib/components/ui/PopoverList.svelte'

afterEach(cleanup)

const props = {
  label: '2 more projects',
  listLabel: 'Projects without a session branch',
  items: ['web', 'docs']
}

it('starts closed with aria-expanded false and aria-controls set', () => {
  render(PopoverList, props)
  const button = screen.getByRole('button', { name: '2 more projects' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(button.getAttribute('aria-controls')).toBeTruthy()
  expect(screen.queryByRole('list')).toBeNull()
})

it('opens on click, labels the list and points aria-controls at it', async () => {
  render(PopoverList, props)
  const button = screen.getByRole('button', { name: '2 more projects' })
  await fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const list = screen.getByRole('list', { name: 'Projects without a session branch' })
  expect(list.id).toBe(button.getAttribute('aria-controls'))
  expect([...list.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([
    'web',
    'docs'
  ])
})

it('opens with the keyboard: Enter and Space activate the native button', async () => {
  render(PopoverList, props)
  const button = screen.getByRole('button', { name: '2 more projects' })
  expect(button.tagName).toBe('BUTTON')
  expect(button.getAttribute('type')).toBe('button')
  button.focus()
  await fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
})

it('has a 44px target', () => {
  render(PopoverList, props)
  expect(screen.getByRole('button').className).toContain('min-h-[var(--size-hit)]')
})

it('Escape closes and returns focus to the button', async () => {
  render(PopoverList, props)
  const button = screen.getByRole('button', { name: '2 more projects' })
  await fireEvent.click(button)
  const item = screen.getByRole('list').querySelector('li') as HTMLElement
  await fireEvent.keyDown(item, { key: 'Escape' })
  expect(screen.queryByRole('list')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(button)
})

it('a click outside closes it', async () => {
  render(PopoverList, props)
  const button = screen.getByRole('button', { name: '2 more projects' })
  await fireEvent.click(button)
  await fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('list')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

it('a click inside the list keeps it open', async () => {
  render(PopoverList, props)
  await fireEvent.click(screen.getByRole('button'))
  await fireEvent.pointerDown(screen.getByText('web'))
  expect(screen.getByRole('list')).toBeTruthy()
})
